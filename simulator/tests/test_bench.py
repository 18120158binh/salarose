import json
import threading
import time

import pytest

from cdp_sim import bench
from cdp_sim.bench import JOBS, BenchError, BenchOptions, BenchReading, Restore, VertexLoad, Wal, limiter
from cdp_sim.cluster import Kube, KubeError, LiveCluster, argo_freeze_patch, argo_restore_patch, checkpoint_problem
from cdp_sim.load import Reading
from cdp_sim.report import Measurement, Report
from cdp_sim.sender import FIRST_SHOPPER

RUN = "20261108t000000-abcdef"
AUTOMATED = {"prune": True, "selfHeal": True}
SPEC = {"image": "cdp/flink-jobs:sha-1", "job": {"state": "running", "upgradeMode": "savepoint", "parallelism": 1},
        "flinkConfiguration": {"state.backend.type": "rocksdb"}, "taskManager": {"resource": {"cpu": 0.5}}}
BUSY = {"Source: snowplow-parsed": VertexLoad(300, 650), "Decide": VertexLoad(950, 10)}
CAP = 3 * 2**30


class Clock:
    def __init__(self):
        self.now = 1_000_000.0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        time.sleep(0.005)
        self.now += seconds


class FakeClient:
    def __init__(self, cluster):
        self.cluster = cluster

    def post(self, events):
        self.cluster.arrive(events)
        return 200, None

    def pixel(self, event):
        self.cluster.arrive((event,))
        return 200, None

    def close(self):
        pass


class FakeTail:
    def __init__(self):
        self.counts = {"snowplow-parsed": 0, "snowplow-parsed-dead-letters": 0}
        self.error = None
        self.behind = 0

    def start(self):
        pass

    def stop(self):
        pass

    def sent_at(self, event_id, at):
        pass


class FakeCluster:
    """One job and its input topic. A request to the collector adds one record; a running job drains at `rate`."""

    def __init__(self, clock, rate=50.0, loads=BUSY, cpu=0.95, lease=None):
        self.clock = clock
        self.rate = rate
        self.loads = loads
        self.cpu = cpu
        self.spec = json.loads(json.dumps(SPEC))
        self.automated = dict(AUTOMATED)
        self.committed = 0
        self.end = 0
        self.state = "running"
        self.running_at = clock()
        self.drain_from = 0
        self.savepoints = []
        self.events = []
        self.lock = threading.Lock()
        self.wal_lsn = 0
        self.wal_per_record = 10
        self.held = 0
        self.cap = CAP
        # WAL the upstream jobs write per record that reaches the input topic while the job is suspended, and WAL
        # the downstream jobs write after the job drained: (bytes per second, seconds).
        self.fill_wal = 0
        self.downstream_wal = (0, 0)
        self.extra_wal = 0
        self.drained_at = None
        self.last_reading = clock()
        # The slots hold every byte of WAL the bench writes, as they do for the CDC commit delay.
        self.hold_all = False
        self.lease = {} if lease is None else lease
        self.lock_calls = []
        self.unhealthy = None
        self.others_suspended = []
        self.suspend_error = None
        self.resume_error = None
        self.restore_elsewhere = False
        self.trickle = 0
        self.calls = []
        self.tail_ = FakeTail()

    def arrive(self, events):
        with self.lock:
            self.end += 1
            self.events.extend(events)
            if self.state == "suspended":
                self.extra_wal += self.fill_wal

    def drained(self):
        if self.state != "running":
            return self.committed
        return min(self.end, self.drain_from + int(self.rate * (self.clock() - self.running_at)))

    def deployed(self, job):
        return json.loads(json.dumps(self.spec))

    def suspended_jobs(self):
        return list(self.others_suspended)

    def lock_bench(self, holder):
        self.lock_calls.append(("lock", holder))
        if "holder" in self.lease:
            return f"another bench holds the lock: {self.lease['holder']}"
        self.lease["holder"] = holder
        return None

    def unlock_bench(self, holder):
        self.lock_calls.append(("unlock", holder))
        assert self.lease.get("holder") == holder
        del self.lease["holder"]

    def freeze_argo(self, automated):
        self.calls.append("freeze")
        assert self.automated == automated
        self.automated = None

    def restore_argo(self, removed):
        self.calls.append("restore")
        self.automated = removed

    def argo_automated(self):
        return self.automated

    def health(self, job):
        return self.unhealthy

    def suspend(self, job):
        self.calls.append("suspend")
        if self.suspend_error:
            raise self.suspend_error
        self.committed = self.drained()
        self.state = "suspended"
        self.spec["job"]["state"] = "suspended"
        self.savepoints.append(f"s3://bucket/flink/{job}/savepoints/savepoint-{len(self.savepoints)}")
        return self.savepoints[-1]

    def resume(self, job, savepoint):
        self.calls.append("resume")
        if self.resume_error:
            raise self.resume_error
        self.state = "running"
        self.spec["job"]["state"] = "running"
        self.running_at = self.clock()
        self.drain_from = self.committed
        path = "s3://bucket/elsewhere" if self.restore_elsewhere else savepoint + "/"
        return Restore(path, True, self.running_at)

    def reading(self, job, accepted):
        with self.lock:
            now, since = self.clock(), self.clock() - self.last_reading
            self.last_reading = now
            if self.state == "running":
                self.committed = self.drained()
                self.end += self.trickle
                if self.committed == self.end:
                    self.tail_.counts["snowplow-parsed"] += len(self.events)
                    self.events = []
                    if self.savepoints and self.drained_at is None:
                        self.drained_at = now
                    rate, seconds = self.downstream_wal
                    if self.drained_at is not None and now - self.drained_at <= seconds:
                        self.extra_wal += rate * since
                else:
                    self.drained_at = None
            self.wal_lsn = self.committed * self.wal_per_record + self.extra_wal
            offsets = (self.committed, self.end)
        guard = Reading(lag={}, volumes={"kafka": 0.3, "postgres": 0.3}, errors={}, dead_letters=0, parsed=0,
                        accepted=accepted)
        held = self.held + (self.wal_lsn if self.hold_all else 0)
        return BenchReading(guard, Wal(int(self.wal_lsn), int(held), self.cap), offsets)

    def flink_load(self, job):
        return dict(self.loads)

    def pod_usage(self, job):
        return self.cpu, 1.5e9

    def counters(self, job, since):
        return {"exceptions": 0, "restarts": 0, "checkpoints_completed": 3, "checkpoints_failed": 0}

    def tail(self):
        return self.tail_

    def connect(self):
        return FakeClient(self)


def options(job="customer-decision-job", backlog=100, runs=2, **overrides):
    values = dict(fill_eps=500.0, probe_backlog=1000, batch=5, connections=2, interval_s=5.0, settle_s=10.0,
                  fill_timeout_s=600.0, drain_timeout_s=600.0, seed=1) | overrides
    return BenchOptions(JOBS[job], backlog, runs=runs, **values)


def run_bench(cluster, clock, opts=None):
    lines = []
    result = bench.run(opts or options(), RUN, cluster, clock=clock, sleep=clock.sleep, log=lines.append)
    return result, lines


def check(result, requirement):
    return next(item for item in result.checks if requirement in item.requirements)


def report_of(result):
    report = Report(RUN, "bench", {}, "now", phases=result.runs, expectations=result.checks)
    report.measurements = result.measurements
    return report


def test_each_run_drains_a_backlog_and_the_number_has_unit_runs_median_range_and_limiter():
    clock = Clock()
    cluster = FakeCluster(clock, rate=10.0)
    result, _ = run_bench(cluster, clock)

    assert [run.phase for run in result.runs] == ["run 1", "run 2"]
    assert all(run.result == "pass" and run.metrics["backlog"] >= 100 for run in result.runs)
    [number] = result.measurements
    assert number.unit == "records/s" and number.runs == 2
    assert 5 <= number.median <= 10, "consumed records over RUNNING to the first reading that sees the drain done"
    assert number.range[0] <= number.median <= number.range[1]
    assert "CPU of operator 'Decide'" in number.limiter
    assert number.result == "measured"
    assert report_of(result).verdict == "pass"
    assert cluster.calls == ["freeze", "suspend", "resume", "suspend", "resume", "restore"]


def test_every_run_resumes_from_the_savepoint_it_suspended_with_and_argo_cd_comes_back_as_it_was():
    clock = Clock()
    cluster = FakeCluster(clock)
    result, _ = run_bench(cluster, clock)

    restores = check(result, "SIM-FR-21")
    assert all(item.result == "pass" for item in result.checks if "SIM-FR-21" in item.requirements)
    argo = next(item for item in result.checks if "Argo CD" in item.expectation)
    assert argo.evidence == {"removed": AUTOMATED, "now": AUTOMATED}
    assert cluster.automated == AUTOMATED and cluster.state == "running"
    assert restores.result == "pass"


def test_runs_send_distinct_shoppers_so_no_device_id_repeats_in_the_bench():
    clock = Clock()
    cluster = FakeCluster(clock)
    shoppers_by_run = {}
    original = cluster.arrive

    def arrive(events):
        run = shoppers_by_run.setdefault(len(cluster.savepoints), set())
        run.update(event.device_id for event in events)
        original(events)

    cluster.arrive = arrive
    run_bench(cluster, clock)
    first, second = shoppers_by_run[1], shoppers_by_run[2]
    assert first and second and not first & second
    assert f"sim-{RUN}-d{FIRST_SHOPPER}" in first


def test_a_number_whose_runs_name_no_limiter_is_inconclusive_and_the_run_incomplete():
    clock = Clock()
    cluster = FakeCluster(clock, loads={"Source": VertexLoad(200, 0), "Decide": VertexLoad(300, 0)})
    result, _ = run_bench(cluster, clock)

    [number] = result.measurements
    assert number.runs == 2 and number.limiter is None and number.result == "inconclusive"
    assert report_of(result).verdict == "incomplete"
    assert "inconclusive" in number.line()


def test_an_unhealthy_job_is_never_suspended():
    clock = Clock()
    cluster = FakeCluster(clock)
    cluster.unhealthy = "checkpoints [2323] failed among the last 5"
    result, _ = run_bench(cluster, clock)

    assert "suspend" not in cluster.calls
    assert "not healthy" in check(result, "SIM-FR-12").reason
    assert cluster.calls == ["freeze", "restore"]
    assert report_of(result).verdict == "fail"


def test_the_bench_refuses_to_start_while_another_job_is_suspended():
    clock = Clock()
    cluster = FakeCluster(clock)
    cluster.others_suspended = ["event-parse-job"]
    result, _ = run_bench(cluster, clock)

    assert cluster.calls == [], "Argo CD untouched, nothing suspended"
    assert "event-parse-job" in result.checks[0].reason and result.checks[0].result == "not run"
    assert report_of(result).verdict == "incomplete"


def test_a_job_that_does_not_upgrade_with_savepoints_is_refused():
    clock = Clock()
    cluster = FakeCluster(clock)
    cluster.spec["job"]["upgradeMode"] = "last-state"
    result, _ = run_bench(cluster, clock)
    assert cluster.calls == [] and "not 'savepoint'" in result.checks[0].reason


def test_a_savepoint_that_does_not_complete_ends_the_bench_and_restores_argo_cd():
    clock = Clock()
    cluster = FakeCluster(clock)
    cluster.suspend_error = BenchError("savepoint did not complete; the bench set the job back to running")
    result, _ = run_bench(cluster, clock)

    assert cluster.calls == ["freeze", "suspend", "restore"]
    assert "did not complete" in check(result, "SIM-FR-12").reason


def test_a_job_the_bench_cannot_resume_stays_suspended_with_argo_cd_frozen_and_the_report_says_how_to_recover():
    clock = Clock()
    cluster = FakeCluster(clock)
    cluster.resume_error = RuntimeError("did not reach STABLE/RUNNING")
    result, _ = run_bench(cluster, clock)

    assert "restore" not in cluster.calls and cluster.automated is None
    argo = next(item for item in result.checks if "Argo CD" in item.expectation)
    assert argo.result == "fail"
    assert cluster.savepoints[0] in argo.reason and "selfHeal" in argo.reason


def test_a_suspend_that_fails_without_saying_the_job_kept_running_keeps_argo_cd_frozen():
    clock = Clock()
    cluster = FakeCluster(clock)
    cluster.suspend_error = RuntimeError("SUSPENDED but its savepoint path is the old one")
    result, _ = run_bench(cluster, clock)
    assert "restore" not in cluster.calls
    assert next(item for item in result.checks if "Argo CD" in item.expectation).result == "fail"


def test_a_resume_from_another_path_fails_the_run_and_the_bench():
    clock = Clock()
    cluster = FakeCluster(clock)
    cluster.restore_elsewhere = True
    result, _ = run_bench(cluster, clock)

    assert result.runs[0].result == "fail" and len(result.runs) == 1
    restores = next(item for item in result.checks if item.expectation.startswith("Every run resumed"))
    assert restores.result == "fail" and cluster.savepoints[0] in restores.reason
    assert cluster.calls[-1] == "restore", "the job runs, so Argo CD comes back"


def test_slots_holding_wal_past_the_guard_keep_the_bench_from_starting():
    clock = Clock()
    cluster = FakeCluster(clock)
    cluster.held = int(0.8 * CAP)
    result, _ = run_bench(cluster, clock)

    assert "80% of max_slot_wal_keep_size" in result.checks[0].reason
    assert cluster.calls == []


def test_the_wal_guard_mid_fill_resumes_the_job_before_the_bench_ends():
    clock = Clock()
    cluster = FakeCluster(clock)
    original = cluster.reading

    def reading(job, accepted):
        if cluster.state == "suspended" and cluster.end > 5:
            cluster.held = int(0.9 * CAP)
        return original(job, accepted)

    cluster.reading = reading
    result, _ = run_bench(cluster, clock)
    assert cluster.calls == ["freeze", "suspend", "resume", "restore"]
    assert "fill" in check(result, "SIM-FR-12").reason


def test_a_probe_run_measures_wal_per_record_and_a_backlog_past_the_cap_share_is_refused():
    clock = Clock()
    cluster = FakeCluster(clock, rate=500.0)
    cluster.wal_per_record = 200_000
    result, _ = run_bench(cluster, clock, options(backlog=20_000, probe_backlog=200, runs=1))

    assert [run.phase for run in result.runs] == ["probe"]
    reason = check(result, "SIM-FR-12").reason
    assert "--backlog 8053" in reason, reason
    assert result.measurements[0].runs == 0, "the probe is not counted"


def test_input_that_arrives_during_the_drain_fails_the_sender_check():
    clock = Clock()
    cluster = FakeCluster(clock)
    original = cluster.resume

    def resume(job, savepoint):
        cluster.trickle = 3
        return original(job, savepoint)

    cluster.resume = resume
    result, _ = run_bench(cluster, clock, options(runs=1))
    assert check(result, "SIM-FR-25").result == "fail"
    assert result.runs[0].result == "fail"


def test_a_sigterm_during_the_fill_resumes_the_job_and_restores_argo_cd():
    clock = Clock()
    cluster = FakeCluster(clock)
    original = cluster.reading

    def reading(job, accepted):
        if cluster.state == "suspended":
            raise SystemExit(143)
        return original(job, accepted)

    cluster.reading = reading
    result, _ = run_bench(cluster, clock)
    assert cluster.calls == ["freeze", "suspend", "resume", "restore"]
    assert "SystemExit" in check(result, "SIM-FR-12").reason


def test_event_parse_checks_that_every_accepted_event_reached_its_outputs():
    clock = Clock()
    cluster = FakeCluster(clock)
    result, _ = run_bench(cluster, clock, options(job="event-parse-job", runs=1))
    run = result.runs[0]
    assert run.result == "pass" and run.metrics["output_events"] == run.metrics["accepted"] > 0
    assert check(result, "SIM-FR-24").result == "pass"


def test_the_deployed_check_names_image_parallelism_and_state_backend():
    clock = Clock()
    cluster = FakeCluster(clock)
    result, _ = run_bench(cluster, clock, options(runs=1))
    deployed = check(result, "SIM-FR-27")
    assert deployed.result == "pass"
    assert deployed.evidence | {} == {"image": "cdp/flink-jobs:sha-1", "parallelism": 1, "state_backend": "rocksdb",
                                      "taskmanager": {"cpu": 0.5}, "state_after": "running"}


@pytest.mark.parametrize(("loads", "cpu", "named"), [
    ({"Source": VertexLoad(400, 600), "Stitch": VertexLoad(980, 0)}, 0.2, "operator 'Stitch' waiting off CPU"),
    ({"Source": VertexLoad(400, 600), "Stitch": VertexLoad(980, 0)}, 0.95, "CPU of operator 'Stitch'"),
    ({"Source": VertexLoad(400, 600), "Stitch": VertexLoad(980, 0)}, None, "TaskManager CPU unread"),
    ({"Source": VertexLoad(900, 800), "Sink": VertexLoad(100, 0)}, 0.95, None),
    ({}, 0.5, None),
])
def test_the_limiter_is_the_busiest_vertex_that_is_not_backpressured(loads, cpu, named):
    found = limiter(loads, cpu, parallelism=1)
    assert (found is None) if named is None else (named in found)


def test_a_measurement_reports_its_median_and_range_and_needs_one_common_limiter():
    number = Measurement("drain", "records/s", (10.0, 30.0, 20.0), ("cpu", "cpu", "cpu"))
    assert (number.median, number.range, number.limiter, number.result) == (20.0, (10.0, 30.0), "cpu", "measured")
    split = Measurement("drain", "records/s", (10.0, 30.0), ("cpu", "postgres"))
    assert split.limiter is None and split.result == "inconclusive"
    assert Measurement("drain", "records/s", (), ()).result == "inconclusive"


def test_checkpoint_health_needs_a_recent_checkpoint_and_no_recent_failure():
    now = 2_000.0
    fresh = {"latest": {"completed": {"latest_ack_timestamp": 1_980_000}}, "history": [{"id": 9, "status": "COMPLETED"}]}
    assert checkpoint_problem(fresh, 30_000, now) is None
    stale = {"latest": {"completed": {"latest_ack_timestamp": 1_800_000}}, "history": []}
    assert "200 s ago" in checkpoint_problem(stale, 30_000, now)
    failed = {**fresh, "history": [{"id": 10, "status": "FAILED"}, {"id": 9, "status": "COMPLETED"}]}
    assert "[10] failed" in checkpoint_problem(failed, 30_000, now)
    assert "no checkpoint" in checkpoint_problem({"latest": {"completed": None}}, 30_000, now)


def test_the_argo_cd_patches_remove_and_put_back_only_what_the_bench_read():
    assert argo_freeze_patch(AUTOMATED) == [
        {"op": "test", "path": "/spec/syncPolicy/automated", "value": AUTOMATED},
        {"op": "remove", "path": "/spec/syncPolicy/automated"}]
    policy = {"syncOptions": ["ServerSideApply=true"]}
    assert argo_restore_patch(policy, AUTOMATED) == [
        {"op": "test", "path": "/spec/syncPolicy", "value": policy},
        {"op": "add", "path": "/spec/syncPolicy/automated", "value": AUTOMATED}]


class FakeKube(Kube):
    def __init__(self, app):
        self.app = app
        self.patches = []

    def call(self, method, path, body=None, content_type="application/json"):
        if method == "PATCH":
            self.patches.append((path, body, content_type))
            return {}
        return self.app


def live(kube):
    cluster = LiveCluster.__new__(LiveCluster)
    cluster._kube = kube
    cluster._clock = time.time
    return cluster


def test_freezing_argo_cd_sends_a_json_patch_and_restoring_refuses_when_someone_put_it_back():
    kube = FakeKube({"spec": {"syncPolicy": {"automated": AUTOMATED, "syncOptions": []}}})
    live(kube).freeze_argo(AUTOMATED)
    [(path, body, content_type)] = kube.patches
    assert path.endswith("/applications/cdp-root") and content_type == "application/json-patch+json"
    assert body[1] == {"op": "remove", "path": "/spec/syncPolicy/automated"}
    with pytest.raises(RuntimeError, match="someone else put it back"):
        live(kube).restore_argo(AUTOMATED)


class FlinkKube(Kube):
    """A FlinkDeployment whose status follows a script of statuses, one per poll."""

    def __init__(self, statuses):
        self.statuses = list(statuses)
        self.status = self.statuses.pop(0)
        self.patches = []

    def call(self, method, path, body=None, content_type="application/json"):
        if method == "PATCH":
            self.patches.append(body["spec"]["job"]["state"])
            return {}
        if self.statuses and self.patches:
            self.status = self.statuses.pop(0)
        return {"spec": SPEC, "status": self.status}


def flink_cluster(kube, clock):
    cluster = live(kube)
    cluster._clock, cluster._sleep = clock, clock.sleep
    return cluster


def status(lifecycle, savepoint, state="RUNNING", job_id="j1", reconciled="running"):
    spec = {**SPEC, "job": {**SPEC["job"], "state": reconciled}}
    return {"lifecycleState": lifecycle, "jobStatus": {"state": state, "upgradeSavepointPath": savepoint,
                                                        "jobId": job_id},
            "reconciliationStatus": {"lastReconciledSpec": json.dumps(spec)}}


def test_a_suspend_returns_the_new_savepoint_once_the_job_is_suspended():
    clock = Clock()
    kube = FlinkKube([status("STABLE", "s3://old"), status("STABLE", "s3://old"), status("SUSPENDED", "s3://new")])
    assert flink_cluster(kube, clock).suspend("customer-decision-job") == "s3://new"
    assert kube.patches == ["suspended"]


def test_a_job_suspended_without_a_new_savepoint_is_not_reported_as_safe():
    clock = Clock()
    kube = FlinkKube([status("STABLE", "s3://old"), status("SUSPENDED", "s3://old")])
    with pytest.raises(RuntimeError, match="cannot tell what to resume from"):
        flink_cluster(kube, clock).suspend("customer-decision-job")


def test_a_resume_refuses_when_the_savepoint_path_changed_since_the_suspend():
    clock = Clock()
    kube = FlinkKube([status("SUSPENDED", "s3://other")])
    with pytest.raises(RuntimeError, match="not the 's3://mine'"):
        flink_cluster(kube, clock).resume("customer-decision-job", "s3://mine")
    assert kube.patches == []


def test_the_report_carries_each_number_and_its_summary_line():
    clock = Clock()
    cluster = FakeCluster(clock, rate=10.0)
    result, _ = run_bench(cluster, clock)
    report = report_of(result)
    [number] = json.loads(report.to_json())["measurements"]
    assert number["unit"] == "records/s" and number["runs"] == 2 and number["limiter"]
    assert len(number["range"]) == 2 and number["median"] is not None
    assert "drain rate of snowplow-parsed: median" in report.summary()


def test_a_guard_that_trips_mid_drain_keeps_the_run_in_the_report():
    clock = Clock()
    cluster = FakeCluster(clock, rate=10.0)
    original = cluster.reading

    def reading(job, accepted):
        if cluster.state == "running" and cluster.savepoints and cluster.committed > 20:
            cluster.held = int(0.9 * CAP)
        return original(job, accepted)

    cluster.reading = reading
    result, _ = run_bench(cluster, clock)
    [run] = result.runs
    assert run.result == "fail" and "max_slot_wal_keep_size" in run.reason
    assert cluster.calls[-1] == "restore"


def test_a_missing_permission_before_the_bench_changes_anything_is_a_refusal():
    clock = Clock()
    cluster = FakeCluster(clock)

    def forbidden(job):
        raise RuntimeError("GET flinkdeployments: HTTP 403")

    cluster.deployed = forbidden
    result, _ = run_bench(cluster, clock)
    assert cluster.calls == [] and "HTTP 403" in result.checks[0].reason


def held_at_each_suspend(cluster):
    seen = []
    original = cluster.suspend

    def suspend(job):
        seen.append(cluster.reading(job, 0).wal.held)
        return original(job)

    cluster.suspend = suspend
    return seen


def test_wal_the_slots_already_hold_counts_against_the_cap_before_every_run():
    clock = Clock()
    cluster = FakeCluster(clock, rate=500.0)
    cluster.held = int(0.3 * CAP)
    cluster.wal_per_record = 48_318
    result, _ = run_bench(cluster, clock, options(backlog=20_000, probe_backlog=200, runs=1))

    assert [run.phase for run in result.runs] == ["probe"], "30% held plus 30% for the run is over half the cap"
    reason = check(result, "SIM-FR-12").reason
    assert "already hold" in reason and "--backlog 13333" in reason, reason
    assert cluster.calls == ["freeze", "suspend", "resume", "restore"]


def test_the_next_run_waits_until_the_slots_release_the_wal_of_the_runs_before_it():
    clock = Clock()
    cluster = FakeCluster(clock, rate=500.0)
    cluster.wal_per_record = int(0.1 * CAP / 20_000)
    original = cluster.reading

    def reading(job, accepted):
        released = cluster.drained_at is None or clock() - cluster.drained_at >= 300
        cluster.held = 0 if released or len(cluster.savepoints) != 1 else int(0.45 * CAP)
        return original(job, accepted)

    cluster.reading = reading
    held = held_at_each_suspend(cluster)
    result, lines = run_bench(cluster, clock, options(backlog=20_000, probe_backlog=200, runs=1))

    assert [run.phase for run in result.runs] == ["probe", "run 1"]
    assert held[1] == 0, "run 1 suspended only after the slots let go of the probe's WAL"
    assert any("waiting for the replication slots" in line for line in lines)


def test_wal_the_fill_writes_stops_the_fill_before_the_slots_reach_the_threshold():
    clock = Clock()
    cluster = FakeCluster(clock)
    cluster.hold_all = True
    cluster.fill_wal = int(0.9 * CAP / 100)
    result, _ = run_bench(cluster, clock, options(backlog=100, runs=1, fill_eps=10.0))

    held = [sample["wal"]["held"] for sample in result.samples if sample["wal"]]
    assert max(held) < bench.WAL_STOP_SHARE * CAP, "the projection stops the fill, not the held WAL passing 70%"
    assert cluster.calls == ["freeze", "suspend", "resume", "restore"]
    reason = check(result, "SIM-FR-12").reason
    assert "fill" in reason and "projected" in reason, reason


def test_the_wal_per_record_counts_the_fill_and_the_downstream_writes_after_the_drain():
    clock = Clock()
    cluster = FakeCluster(clock, rate=500.0)
    cluster.fill_wal = 1_000
    cluster.downstream_wal = (50_000, 60)
    result, _ = run_bench(cluster, clock, options(backlog=20_000, probe_backlog=200, runs=1))

    probe = result.runs[0]
    assert probe.phase == "probe"
    assert probe.metrics["wal_bytes_per_record"] > 1_000 + 10 + 10_000, probe.metrics


@pytest.mark.parametrize(("cap", "phases"), [(3 * 2**30, []), (8 * 2**30, ["probe", "run 1"])])
def test_the_cap_in_force_is_read_live_and_never_assumed(cap, phases):
    clock = Clock()
    cluster = FakeCluster(clock, rate=500.0)
    cluster.cap = cap
    cluster.held = 2 * 2**30
    cluster.wal_per_record = 2**30 // 20_000
    result, _ = run_bench(cluster, clock, options(backlog=20_000, probe_backlog=200, runs=1))
    assert [run.phase for run in result.runs] == phases


def test_a_cap_the_bench_cannot_read_keeps_it_from_starting():
    clock = Clock()
    cluster = FakeCluster(clock)
    cluster.cap = None
    result, _ = run_bench(cluster, clock)
    assert cluster.calls == [] and "max_slot_wal_keep_size" in result.checks[0].reason


def test_a_tail_that_cannot_connect_restores_argo_cd_and_reports_why():
    clock = Clock()
    cluster = FakeCluster(clock)

    def tail():
        raise RuntimeError("topic snowplow-parsed-dead-letters not found")

    cluster.tail = tail
    result, _ = run_bench(cluster, clock)
    assert cluster.calls == ["freeze", "restore"] and cluster.automated == AUTOMATED
    assert "not found" in check(result, "SIM-FR-12").reason
    assert next(item for item in result.checks if "Argo CD" in item.expectation).result == "pass"


def test_a_tail_that_fails_to_stop_still_restores_argo_cd():
    clock = Clock()
    cluster = FakeCluster(clock)

    def stop():
        raise RuntimeError("consumer close timed out")

    cluster.tail_.stop = stop
    run_bench(cluster, clock, options(runs=1))
    assert cluster.calls[-1] == "restore" and cluster.automated == AUTOMATED


def test_a_second_bench_refuses_to_start_while_the_first_holds_the_lock():
    clock = Clock()
    lease = {}
    first = FakeCluster(clock, lease=lease)
    second = FakeCluster(Clock(), lease=lease)
    second_results = []
    original = first.reading

    def reading(job, accepted):
        if first.state == "suspended" and not second_results:
            second_results.append(bench.run(options(), "20261108t000100-second", second, clock=second.clock,
                                            sleep=second.clock.sleep, log=lambda line: None))
        return original(job, accepted)

    first.reading = reading
    result, _ = run_bench(first, clock)

    [refused] = second_results
    assert second.calls == [] and second.automated == AUTOMATED, "the second bench changed nothing"
    assert RUN in refused.checks[0].reason and refused.checks[0].result == "not run"
    assert report_of(result).verdict == "pass" and lease == {}


def suspended_with_sigterm(cluster):
    original = cluster.reading

    def reading(job, accepted):
        if cluster.state == "suspended":
            raise SystemExit(143)
        return original(job, accepted)

    cluster.reading = reading


def tail_fails(cluster):
    def tail():
        raise RuntimeError("no brokers")
    cluster.tail = tail


@pytest.mark.parametrize("arrange", [
    lambda cluster: None,
    lambda cluster: cluster.spec["job"].update(upgradeMode="last-state"),
    suspended_with_sigterm,
    tail_fails,
    lambda cluster: setattr(cluster, "resume_error", RuntimeError("did not reach STABLE/RUNNING")),
], ids=["finished", "refused", "sigterm", "tail", "left-suspended"])
def test_the_lock_is_released_on_every_exit_path(arrange):
    clock = Clock()
    cluster = FakeCluster(clock)
    arrange(cluster)
    result, _ = run_bench(cluster, clock, options(runs=1))
    assert cluster.lock_calls == [("lock", RUN), ("unlock", RUN)] and cluster.lease == {}
    released = next(item for item in result.checks if "lock" in item.expectation)
    assert released.result == "pass"


def test_the_bench_refuses_when_argo_cd_automated_sync_is_already_off():
    clock = Clock()
    cluster = FakeCluster(clock)
    cluster.automated = None
    result, _ = run_bench(cluster, clock)
    assert cluster.calls == [] and "already off" in result.checks[0].reason
    assert cluster.lease == {}


def test_a_resume_the_bench_sent_but_could_not_confirm_says_not_to_resume_again():
    clock = Clock()
    cluster = FakeCluster(clock)
    cluster.resume_error = bench.ResumeUnconfirmed("did not reach STABLE/RUNNING within 600 s of the resume")
    result, _ = run_bench(cluster, clock)
    argo = next(item for item in result.checks if "Argo CD" in item.expectation)
    assert argo.result == "fail" and cluster.automated is None
    assert "already says running" in argo.reason and "by hand" not in argo.reason
    assert cluster.savepoints[0] in argo.reason


def test_the_drain_ends_only_when_the_job_has_committed_the_whole_backlog():
    clock = Clock()
    cluster = FakeCluster(clock, rate=10.0)
    original = cluster.drained
    stall = []

    def drained():
        done = original()
        if cluster.state == "running" and cluster.savepoints and done >= cluster.end - 1:
            stall.append(stall[0] if stall else clock() + 30)
            return done if clock() >= stall[0] else cluster.end - 1
        return done

    cluster.drained = drained
    result, _ = run_bench(cluster, clock, options(runs=1))
    [run] = result.runs
    assert run.result == "pass" and run.metrics["consumed"] >= run.metrics["backlog"], run.reason


class LeaseKube(Kube):
    def __init__(self):
        self.lease = None
        self.requests = []

    def call(self, method, path, body=None, content_type="application/json"):
        self.requests.append((method, path, body))
        if method == "POST":
            if self.lease:
                raise KubeError(409, f"POST {path}: HTTP 409: leases.coordination.k8s.io already exists")
            self.lease = {**body, "metadata": {**body["metadata"], "uid": f"uid-{body['spec']['holderIdentity']}"}}
            return self.lease
        if method == "GET":
            return self.lease
        assert method == "DELETE" and body["preconditions"] == {"uid": self.lease["metadata"]["uid"]}
        self.lease = None
        return {}


def test_the_bench_lock_is_one_lease_and_a_second_bench_is_refused_with_its_holder():
    kube = LeaseKube()
    first, second = live(kube), live(kube)
    assert first.lock_bench("run-a") is None
    assert kube.requests[0][1].endswith("/namespaces/cdp/leases") and kube.lease["metadata"]["name"] == "cdp-sim-bench"

    refusal = second.lock_bench("run-b")
    assert "run-a" in refusal and "delete lease cdp-sim-bench" in refusal
    assert kube.lease["spec"]["holderIdentity"] == "run-a"

    first.unlock_bench("run-a")
    assert kube.lease is None and kube.requests[-1][0] == "DELETE"
    assert second.lock_bench("run-b") is None


class NamedKube(Kube):
    def __init__(self, states):
        self.states = states
        self.paths = []

    def call(self, method, path, body=None, content_type="application/json"):
        self.paths.append(path)
        return {"spec": {"job": {"state": self.states.get(path.rsplit("/", 1)[1], "running")}}}


def test_suspended_jobs_reads_each_deployment_by_name_and_never_lists():
    kube = NamedKube({"campaign-outbox-job": "suspended"})
    assert live(kube).suspended_jobs() == ["campaign-outbox-job"]
    assert sorted(path.rsplit("/", 1)[1] for path in kube.paths) == sorted([*JOBS, "campaign-outbox-job"])


class OperatorKube(Kube):
    """A savepoint suspend that never completes: UPGRADING until the bench sets running again, then `after`."""

    def __init__(self, after):
        self.after = after
        self.patches = []

    def call(self, method, path, body=None, content_type="application/json"):
        if method == "PATCH":
            self.patches.append(body["spec"]["job"]["state"])
            return {}
        if not self.patches:
            return {"spec": SPEC, "status": status("STABLE", "s3://old")}
        if self.patches[-1] == "suspended":
            return {"spec": SPEC, "status": status("UPGRADING", "s3://old", reconciled="suspended")}
        return {"spec": SPEC, "status": self.after}


def test_a_savepoint_timeout_ends_the_bench_safely_only_once_the_job_runs_as_running():
    clock = Clock()
    kube = OperatorKube(status("STABLE", "s3://old"))
    with pytest.raises(BenchError, match="lost no state"):
        flink_cluster(kube, clock).suspend("customer-decision-job")
    assert kube.patches == ["suspended", "running"]


def test_a_savepoint_timeout_with_the_operator_still_on_its_savepoint_keeps_argo_cd_frozen():
    clock = Clock()
    kube = OperatorKube(status("UPGRADING", "s3://old", reconciled="suspended"))
    with pytest.raises(RuntimeError, match="could not confirm") as raised:
        flink_cluster(kube, clock).suspend("customer-decision-job")
    assert not isinstance(raised.value, BenchError), "only a BenchError releases the freeze"


def test_a_resume_that_never_reaches_running_says_the_spec_already_says_running():
    clock = Clock()
    kube = FlinkKube([status("SUSPENDED", "s3://mine")])
    with pytest.raises(bench.ResumeUnconfirmed):
        flink_cluster(kube, clock).resume("customer-decision-job", "s3://mine")
    assert kube.patches == ["running"]


def test_a_freeze_that_failed_because_someone_else_removed_automated_sync_puts_nothing_back():
    clock = Clock()
    cluster = FakeCluster(clock)

    def freeze_argo(automated):
        cluster.calls.append("freeze")
        cluster.automated = None
        raise RuntimeError("PATCH applications/cdp-root: HTTP 422: the test operation failed")

    cluster.freeze_argo = freeze_argo
    result, _ = run_bench(cluster, clock)

    assert "restore" not in cluster.calls and cluster.automated is None, "the bench restores only what it removed"
    argo = next(item for item in result.checks if "Argo CD" in item.expectation)
    assert argo.result == "fail" and "did not confirm" in argo.reason, argo.reason
    assert "suspend" not in cluster.calls


def test_a_freeze_that_failed_before_anything_changed_leaves_argo_cd_as_it_was():
    clock = Clock()
    cluster = FakeCluster(clock)

    def freeze_argo(automated):
        cluster.calls.append("freeze")
        raise RuntimeError("PATCH applications/cdp-root: HTTP 403")

    cluster.freeze_argo = freeze_argo
    result, _ = run_bench(cluster, clock)
    argo = next(item for item in result.checks if "Argo CD" in item.expectation)
    assert cluster.calls == ["freeze"] and cluster.automated == AUTOMATED and argo.result == "pass"


def test_a_run_with_no_measured_wal_cost_is_sized_before_its_suspend_with_a_conservative_estimate():
    clock = Clock()
    cluster = FakeCluster(clock)
    cluster.held = int(0.2 * CAP)
    backlog = int(0.4 * CAP / bench.UNMEASURED_WAL_PER_EVENT)
    result, _ = run_bench(cluster, clock, options(backlog=backlog, probe_backlog=backlog, runs=1))

    assert "suspend" not in cluster.calls, "20% held plus an estimated 40% is over half the cap"
    reason = check(result, "SIM-FR-12").reason
    assert "estimate" in reason and "--backlog" in reason, reason
    assert cluster.automated == AUTOMATED


def test_a_probe_too_large_for_the_estimate_is_refused_and_names_a_safe_probe_backlog():
    clock = Clock()
    cluster = FakeCluster(clock)
    probe = int(0.6 * CAP / bench.UNMEASURED_WAL_PER_EVENT)
    result, _ = run_bench(cluster, clock, options(backlog=probe * 2, probe_backlog=probe, runs=1))
    assert "suspend" not in cluster.calls
    assert "--probe-backlog" in check(result, "SIM-FR-12").reason


def test_an_event_parse_record_is_estimated_as_a_whole_batch_of_events():
    clock = Clock()
    cluster = FakeCluster(clock)
    backlog = int(0.3 * CAP / bench.UNMEASURED_WAL_PER_EVENT / 5)
    fits, _ = run_bench(cluster, clock, options(job="customer-decision-job", backlog=backlog, probe_backlog=backlog,
                                                runs=1))
    assert "suspend" in cluster.calls, "one event per record: 6% of the cap"
    clock = Clock()
    cluster = FakeCluster(clock)
    run_bench(cluster, clock, options(job="event-parse-job", backlog=backlog * 5, probe_backlog=backlog * 5,
                                      runs=1))
    assert "suspend" not in cluster.calls, "five events per record at --batch 5: 150% of the cap"


def test_the_drain_counts_from_the_committed_offset_the_job_was_suspended_at():
    clock = Clock()
    cluster = FakeCluster(clock, rate=10.0)
    original = cluster.resume

    def resume(job, savepoint):
        restore = original(job, savepoint)
        cluster.running_at = clock() - 20
        return Restore(restore.path, True, cluster.running_at)

    cluster.resume = resume
    result, _ = run_bench(cluster, clock, options(runs=1))
    [run] = result.runs
    assert run.result == "pass" and run.metrics["consumed"] == run.metrics["backlog"], run.reason


def test_a_resume_cut_short_says_to_check_the_job_state_before_resuming_by_hand():
    clock = Clock()
    cluster = FakeCluster(clock)
    cluster.resume_error = SystemExit(143)
    result, _ = run_bench(cluster, clock)
    argo = next(item for item in result.checks if "Argo CD" in item.expectation)
    assert argo.result == "fail" and "spec.job.state" in argo.reason, argo.reason
