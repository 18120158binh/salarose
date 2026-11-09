"""The bench's controller and observers on the live deployment: the Kubernetes API, Argo CD, Flink, Postgres WAL.

The Kubernetes calls use the pod's service account token. infra/k8s/simulator/bench-rbac.yaml grants it exactly what
these calls need: get on the five FlinkDeployments and patch on the four it measures in `cdp`, create, get, and
delete on the Lease that lets one bench run at a time, and get and patch on the Argo CD Application cdp-root. The
Flink REST API is read over each job's `<job>-rest` service, which needs no permission.
"""

from __future__ import annotations

import json
import ssl
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path

from kafka import KafkaAdminClient, KafkaConsumer

from cdp_sim.bench import JOBS, BenchError, BenchJob, BenchReading, Restore, ResumeUnconfirmed, VertexLoad, Wal
from cdp_sim.db import Database
from cdp_sim.gauges import DEAD_LETTERS, PARSED, REQUEST_TIMEOUT_MS, LagProbe, RunTail, Volumes, prometheus_value
from cdp_sim.load import Reading
from cdp_sim.sender import Client, KeepAliveCollector
from cdp_sim.settings import Settings

ACCOUNT = Path("/var/run/secrets/kubernetes.io/serviceaccount")
FLINK_DEPLOYMENTS = "/apis/flink.apache.org/v1beta1/namespaces/cdp/flinkdeployments"
ROOT_APP = "/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/cdp-root"
LEASES = "/apis/coordination.k8s.io/v1/namespaces/cdp/leases"
LOCK = "cdp-sim-bench"
# Every FlinkDeployment in cdp: the bench refuses to start while any of them is suspended.
DEPLOYMENTS = (*JOBS, "campaign-outbox-job")
# How long a suspend waits for its savepoint: the job's checkpoint timeout, 600 s, and the operator's reconcile.
SUSPEND_TIMEOUT_S = 900.0
RESUME_TIMEOUT_S = 600.0
POLL_S = 5.0
# A job is healthy when its last completed checkpoint is younger than this many checkpoint intervals, and none of
# its last few checkpoints failed.
CHECKPOINT_AGE_INTERVALS = 3
RECENT_CHECKPOINTS = 5


class KubeError(RuntimeError):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


class Kube:
    """The Kubernetes API from inside a pod, over HTTPS with the service account's token and CA."""

    def __init__(self, base_url: str = "https://kubernetes.default.svc", account: Path = ACCOUNT) -> None:
        self._base_url = base_url
        self._account = account
        self._context = ssl.create_default_context(cafile=str(account / "ca.crt")) if account.exists() else None

    def call(self, method: str, path: str, body: object = None, content_type: str = "application/json") -> dict:
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(f"{self._base_url}{path}", data=data, method=method)
        request.add_header("Authorization", f"Bearer {(self._account / 'token').read_text().strip()}")
        request.add_header("Accept", "application/json")
        if data is not None:
            request.add_header("Content-Type", content_type)
        try:
            with urllib.request.urlopen(request, timeout=30, context=self._context) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise KubeError(error.code,
                            f"{method} {path}: HTTP {error.code}: {error.read()[:500].decode(errors='replace')}")


def http_json(url: str, timeout_s: float = 10.0) -> dict | list:
    with urllib.request.urlopen(url, timeout=timeout_s) as response:
        return json.load(response)


def argo_freeze_patch(automated: dict) -> list[dict]:
    """Removes syncPolicy.automated only while it still holds what the bench read."""
    return [{"op": "test", "path": "/spec/syncPolicy/automated", "value": automated},
            {"op": "remove", "path": "/spec/syncPolicy/automated"}]


def argo_restore_patch(policy: dict, automated: dict) -> list[dict]:
    """Puts back exactly the automated block the bench removed, only while the policy is as the bench left it."""
    return [{"op": "test", "path": "/spec/syncPolicy", "value": policy},
            {"op": "add", "path": "/spec/syncPolicy/automated", "value": automated}]


class LiveCluster:
    def __init__(self, settings: Settings, db: Database, run_id: str, kube: Kube | None = None,
                 clock: Callable[[], float] = time.time, sleep: Callable[[float], None] = time.sleep) -> None:
        self._settings = settings
        self._db = db
        self._run_id = run_id
        self._kube = kube or Kube()
        self._clock = clock
        self._sleep = sleep
        client_id = f"sim-{run_id}-bench"
        self._lag = LagProbe(
            KafkaAdminClient(bootstrap_servers=settings.kafka_brokers, client_id=client_id,
                             request_timeout_ms=REQUEST_TIMEOUT_MS),
            KafkaConsumer(bootstrap_servers=settings.kafka_brokers, client_id=client_id, enable_auto_commit=False,
                          request_timeout_ms=REQUEST_TIMEOUT_MS),
        )
        self._volumes = Volumes(settings.prometheus_url, settings.volume_query, db, settings.pg_volume_bytes)
        self._tail: RunTail | None = None

    # --- Kubernetes and Argo CD ---

    def _deployment(self, job: str) -> dict:
        return self._kube.call("GET", f"{FLINK_DEPLOYMENTS}/{job}")

    def deployed(self, job: str) -> dict:
        return self._deployment(job)["spec"]

    def suspended_jobs(self) -> list[str]:
        return [job for job in DEPLOYMENTS if self.deployed(job).get("job", {}).get("state") == "suspended"]

    def lock_bench(self, holder: str) -> str | None:
        """Creates the Lease only one bench can hold. Returns why not when another bench holds it. A bench killed
        before it released the Lease leaves it behind, and the next bench refuses until someone deletes it."""
        now = time.strftime("%Y-%m-%dT%H:%M:%S.000000Z", time.gmtime(self._clock()))
        lease = {"apiVersion": "coordination.k8s.io/v1", "kind": "Lease",
                 "metadata": {"name": LOCK, "labels": {"app.kubernetes.io/name": "traffic-simulator"}},
                 "spec": {"holderIdentity": holder, "acquireTime": now}}
        try:
            self._lock_uid = self._kube.call("POST", LEASES, lease)["metadata"]["uid"]
        except KubeError as error:
            if error.code != 409:
                raise
            spec = self._kube.call("GET", f"{LEASES}/{LOCK}").get("spec", {})
            return (f"another bench holds the lock: Lease cdp/{LOCK} held by {spec.get('holderIdentity')} since"
                    f" {spec.get('acquireTime')}. If no bench Job runs, kubectl -n cdp delete lease {LOCK}")
        return None

    def unlock_bench(self, holder: str) -> None:
        """Deletes the Lease this bench created, and no other: the uid precondition fails on someone else's."""
        self._kube.call("DELETE", f"{LEASES}/{LOCK}",
                        {"apiVersion": "v1", "kind": "DeleteOptions", "preconditions": {"uid": self._lock_uid}})

    def _root_policy(self) -> dict:
        return self._kube.call("GET", ROOT_APP)["spec"].get("syncPolicy", {})

    def argo_automated(self) -> dict | None:
        return self._root_policy().get("automated")

    def freeze_argo(self, automated: dict) -> None:
        self._kube.call("PATCH", ROOT_APP, argo_freeze_patch(automated), "application/json-patch+json")

    def restore_argo(self, removed: dict) -> None:
        policy = self._root_policy()
        if "automated" in policy:
            raise RuntimeError(f"cdp-root already has syncPolicy.automated {policy['automated']}; someone else put it"
                               " back, so the bench leaves it")
        self._kube.call("PATCH", ROOT_APP, argo_restore_patch(policy, removed), "application/json-patch+json")

    def _patch_state(self, job: str, state: str) -> None:
        self._kube.call("PATCH", f"{FLINK_DEPLOYMENTS}/{job}", {"spec": {"job": {"state": state}}},
                        "application/merge-patch+json")

    def suspend(self, job: str) -> str:
        """Suspends the job with a savepoint and returns its path. A savepoint that does not complete in time sets the
        job back to running: the operator retries a failed savepoint for ever and never suspends on its own. It
        applies the running spec only after its current savepoint attempt ends, which may still stop the job, so the
        bench says the job never stopped only once it sees the operator run it as running."""
        before = self._deployment(job)["status"].get("jobStatus", {}).get("upgradeSavepointPath")
        self._patch_state(job, "suspended")
        deadline = self._clock() + SUSPEND_TIMEOUT_S
        while self._clock() < deadline:
            self._sleep(POLL_S)
            status = self._deployment(job)["status"]
            path = status.get("jobStatus", {}).get("upgradeSavepointPath")
            if status.get("lifecycleState") == "SUSPENDED":
                if not path or path == before:
                    raise RuntimeError(f"{job} is SUSPENDED but its savepoint path is {path!r}, the one from before"
                                       " the bench, so the bench cannot tell what to resume from")
                return path
        self._patch_state(job, "running")
        deadline = self._clock() + SUSPEND_TIMEOUT_S
        while self._clock() < deadline:
            self._sleep(POLL_S)
            if runs_as_running(self._deployment(job)["status"]):
                raise BenchError(f"{job}'s savepoint did not complete within {SUSPEND_TIMEOUT_S:g} s. The bench set"
                                 " the job back to running and saw it run; it never stopped, so it lost no state")
        raise RuntimeError(f"{job}'s savepoint did not complete within {SUSPEND_TIMEOUT_S:g} s, and the bench set it"
                           " back to running but could not confirm that it runs. Check its state and where it restored"
                           " from before putting Argo CD's automated sync back")

    def resume(self, job: str, savepoint: str) -> Restore:
        status = self._deployment(job)["status"]
        path = status.get("jobStatus", {}).get("upgradeSavepointPath")
        if path != savepoint:
            raise RuntimeError(f"{job}'s savepoint path is now {path!r}, not the {savepoint!r} it suspended with")
        self._patch_state(job, "running")
        deadline = self._clock() + RESUME_TIMEOUT_S
        while self._clock() < deadline:
            self._sleep(POLL_S)
            status = self._deployment(job)["status"]
            job_id = status.get("jobStatus", {}).get("jobId")
            if (status.get("lifecycleState"), status.get("jobStatus", {}).get("state")) == ("STABLE", "RUNNING"):
                restored = self._rest(job, f"/jobs/{job_id}/checkpoints").get("latest", {}).get("restored") or {}
                running = self._rest(job, f"/jobs/{job_id}")["timestamps"].get("RUNNING")
                return Restore(restored.get("external_path"), bool(restored.get("is_savepoint")),
                               running / 1000 if running else self._clock())
        raise ResumeUnconfirmed(f"{job} did not reach STABLE/RUNNING within {RESUME_TIMEOUT_S:g} s of the resume")

    # --- Flink REST ---

    def _rest(self, job: str, path: str) -> dict | list:
        return http_json(f"http://{job}-rest.cdp.svc:8081{path}")

    def _job_id(self, job: str) -> str:
        job_id = self._deployment(job)["status"].get("jobStatus", {}).get("jobId")
        if not job_id:
            raise RuntimeError(f"{job} has no job id in its status")
        return job_id

    def health(self, job: str) -> str | None:
        status = self._deployment(job)["status"]
        state = (status.get("lifecycleState"), status.get("jobStatus", {}).get("state"))
        if state != ("STABLE", "RUNNING"):
            return f"lifecycle/job state is {state[0]}/{state[1]}, not STABLE/RUNNING"
        job_id = status["jobStatus"]["jobId"]
        interval_ms = self._rest(job, f"/jobs/{job_id}/checkpoints/config")["interval"]
        checkpoints = self._rest(job, f"/jobs/{job_id}/checkpoints")
        return checkpoint_problem(checkpoints, interval_ms, self._clock())

    def flink_load(self, job: str) -> dict[str, VertexLoad]:
        job_id = self._job_id(job)
        loads = {}
        for vertex in self._rest(job, f"/jobs/{job_id}")["vertices"]:
            metrics = self._rest(job, f"/jobs/{job_id}/vertices/{vertex['id']}/subtasks/metrics"
                                      "?get=busyTimeMsPerSecond,backPressuredTimeMsPerSecond")
            values = {metric["id"]: float(metric["max"]) for metric in metrics}
            loads[vertex["name"]] = VertexLoad(values.get("busyTimeMsPerSecond", 0.0),
                                               values.get("backPressuredTimeMsPerSecond", 0.0))
        return loads

    def counters(self, job: str, since: float) -> dict:
        """Exceptions since the resume, and the restarts and checkpoints of the job the resume started."""
        try:
            job_id = self._job_id(job)
            exceptions = self._rest(job, f"/jobs/{job_id}/exceptions?maxExceptions=50")
            entries = exceptions.get("exceptionHistory", {}).get("entries", [])
            restarts = self._rest(job, f"/jobs/{job_id}/metrics?get=numRestarts")
            checkpoints = self._rest(job, f"/jobs/{job_id}/checkpoints")
        except Exception as error:  # noqa: BLE001  An unread counter fails the run's delivery check.
            return {"counters_error": f"{type(error).__name__}: {error}", "exceptions": None, "restarts": None,
                    "checkpoints_failed": None}
        completed = (checkpoints.get("latest") or {}).get("completed") or {}
        return {
            "exceptions": sum(1 for entry in entries if entry.get("timestamp", 0) >= since * 1000),
            "restarts": int(float(restarts[0]["value"])) if restarts else None,
            "checkpoints_completed": checkpoints.get("counts", {}).get("completed"),
            "checkpoints_failed": checkpoints.get("counts", {}).get("failed"),
            "checkpoint_last_duration_ms": completed.get("end_to_end_duration"),
            "checkpoint_last_size_bytes": completed.get("checkpointed_size", completed.get("state_size")),
        }

    # --- Prometheus, Kafka, Postgres ---

    def pod_usage(self, job: str) -> tuple[float | None, float | None]:
        pods = f'namespace="cdp",pod=~"{job}-taskmanager-.*",container="flink-main-container"'
        try:
            cpu = prometheus_value(self._settings.prometheus_url,
                                   f"sum(rate(container_cpu_usage_seconds_total{{{pods}}}[1m]))")
            memory = prometheus_value(self._settings.prometheus_url,
                                      f"max(container_memory_working_set_bytes{{{pods}}})")
        except Exception:  # noqa: BLE001  Unread usage leaves the limiter without CPU, which it says.
            return None, None
        return cpu, memory

    def wal(self) -> Wal:
        row = self._db.rows(
            "SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')::bigint AS lsn,"
            " COALESCE((SELECT max(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) FROM pg_replication_slots"
            " WHERE restart_lsn IS NOT NULL), 0)::bigint AS held,"
            " (SELECT setting::bigint FROM pg_settings WHERE name = 'max_slot_wal_keep_size') AS cap_mb"
        )[0]
        unreserved = self._db.rows(
            "SELECT slot_name FROM pg_replication_slots WHERE wal_status IS NULL OR wal_status NOT IN"
            " ('reserved', 'extended')"
        )
        cap = int(row["cap_mb"]) * 2**20 if row["cap_mb"] is not None and int(row["cap_mb"]) >= 0 else None
        return Wal(int(row["lsn"]), int(row["held"]), cap, tuple(slot["slot_name"] for slot in unreserved))

    def reading(self, job: BenchJob, accepted: int) -> BenchReading:
        ratios, errors = self._volumes.read()
        tail = self._tail
        if tail is not None and tail.error:
            errors["dead_letters"] = f"the run tail stopped: {tail.error}"
        dead = None if tail is None or tail.error else tail.counts[DEAD_LETTERS]
        guard = Reading(lag={}, volumes=ratios, errors=errors, dead_letters=dead,
                        parsed=tail.counts[PARSED] if tail else 0, accepted=accepted)
        try:
            wal = self.wal()
        except Exception as error:  # noqa: BLE001  The guard counts an unread WAL.
            errors["wal"] = f"{type(error).__name__}: {error}"
            wal = None
        try:
            offsets = self._lag.offsets(job.input_topic, job.group)
        except Exception as error:  # noqa: BLE001
            errors["offsets"] = f"{type(error).__name__}: {error}"
            offsets = None
        return BenchReading(guard, wal, offsets)

    def tail(self) -> RunTail:
        self._tail = RunTail(self._settings.kafka_brokers, self._run_id, f"sim-{self._run_id}-bench",
                             lambda sent, ms: None, time.monotonic)
        return self._tail

    def connect(self) -> Client:
        return KeepAliveCollector(self._settings.collector_url)


def runs_as_running(status: dict) -> bool:
    """The operator has applied a running spec and the job runs: STABLE, RUNNING, and running last reconciled."""
    reconciled = status.get("reconciliationStatus", {}).get("lastReconciledSpec")
    try:
        state = json.loads(reconciled)["job"]["state"] if reconciled else None
    except (ValueError, KeyError, TypeError):
        state = None
    running = (status.get("lifecycleState"), status.get("jobStatus", {}).get("state")) == ("STABLE", "RUNNING")
    return running and state == "running"


def checkpoint_problem(checkpoints: dict, interval_ms: float, now: float) -> str | None:
    """Why the job may not take a savepoint, from its checkpoint statistics. None when it checkpoints."""
    completed = (checkpoints.get("latest") or {}).get("completed")
    if not completed:
        return "no checkpoint has completed since the job started"
    age_s = now - completed["latest_ack_timestamp"] / 1000
    limit_s = CHECKPOINT_AGE_INTERVALS * interval_ms / 1000
    if age_s > limit_s:
        return f"the last checkpoint completed {age_s:.0f} s ago, over {limit_s:.0f} s"
    recent = (checkpoints.get("history") or [])[:RECENT_CHECKPOINTS]
    failed = [entry["id"] for entry in recent if entry.get("status") == "FAILED"]
    if failed:
        return f"checkpoints {failed} failed among the last {len(recent)}"
    return None
