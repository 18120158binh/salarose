"""Bench: one Flink job's drain rate, measured by suspend, fill, and resume (SIM-FR-21 to SIM-FR-25, SIM-FR-27).

Each run suspends the job with a savepoint, sends shoppers through the real path until the job's input topic holds
the target backlog, resumes the job from that savepoint, and times the drain. The sender stops before the resume, so
it is never in the measured path.

The bench guards the deployment as the load run does, and more:
- Argo CD's automated sync of cdp-root is removed for the whole bench and put back exactly as it was, because a sync
  during a suspend sets the job running again (retros lesson 53). A JSON patch with a test op does both, so the bench
  never re-creates a key it did not remove (lesson 54).
- A run starts only on a job that checkpoints: a job that cannot checkpoint cannot take a savepoint (lesson 55).
- A Lease in `cdp` lets one bench run at a time, and the bench refuses to start while automated sync is already off,
  so no other bench or recovery can put the sync back while this one has a job suspended.
- Every reading checks the load run's stop conditions, the WAL the replication slots hold against
  max_slot_wal_keep_size as Postgres reports it now, and slots that are no longer reserved (#320). A probe run first
  measures the WAL a record costs over a whole run: the upstream writes during the fill, the drain, and the downstream
  writes after it. Before each run, the WAL the slots already hold plus that cost times the backlog must fit under a
  share of the cap. During the fill, the WAL written so far sets a projection of the rest of the run, and the fill
  stops while the drain of what it queued still fits.
- Whatever happens, the bench resumes a job it suspended from the savepoint it took, and restores Argo CD only after.
"""

from __future__ import annotations

import random
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Protocol

from cdp_sim.load import Limits, Meter, Phase, Profile, Reading, StopGuard, Tail, asdict_reading
from cdp_sim.report import ExpectationResult, Measurement, PhaseResult
from cdp_sim.sender import FIRST_SHOPPER, Client, Pacer, Sender


@dataclass(frozen=True)
class BenchJob:
    """A job the bench can measure: its input topic and the consumer group whose committed offsets track it."""

    name: str
    input_topic: str
    group: str


JOBS = {job.name: job for job in (
    BenchJob("event-parse-job", "snowplow-good", "event-processor-group"),
    BenchJob("customer-decision-job", "snowplow-parsed", "customer-decision-events"),
    BenchJob("customer-profile-writer-job", "customer-profile-mutations", "customer-profile-writer"),
    BenchJob("campaign-state-machine-job", "journey-engine-matched-events", "campaign-state-machine-group"),
)}
# The jobs whose output the run tail counts per event: event parse writes each event to snowplow-parsed or the dead
# letters. The other jobs' outputs do not map one to one onto what the run sent.
COUNTED_OUTPUT = "event-parse-job"

# A vertex this busy, in ms per second, does the work that bounds the job, unless it is itself backpressured.
BUSY_MS = 700.0
BACKPRESSURED_MS = 200.0
# CPU per busy subtask, in cores, at which the busy vertex counts as CPU-bound. A subtask runs on one thread.
CPU_BOUND_CORES = 0.8
# The live WAL guard: slot-held WAL over this share of max_slot_wal_keep_size stops the bench, and so does a
# projection during the fill that the rest of the run would take the slots past it.
WAL_STOP_SHARE = 0.7
# After a drain, WAL counts as quiet once it grows no faster than twice the rate before the bench, or this floor.
QUIET_FLOOR_BYTES_PER_S = 16 * 1024
# The WAL an event is assumed to cost until a run measures it: twice the 2 KB per event the whole pipeline wrote in
# the load run that invalidated the slots (#320, 6 MB/s at 3,000 events per second).
UNMEASURED_WAL_PER_EVENT = 4096


class BenchError(Exception):
    """Stops the bench. The job is resumed from its savepoint and Argo CD restored before the report."""


class ResumeUnconfirmed(Exception):
    """The job's spec says running again, but the bench did not see it run from its savepoint."""


@dataclass(frozen=True)
class Wal:
    """Postgres WAL: the current position, what the replication slots hold back, the cap, and slots past it."""

    lsn: int
    held: int
    cap: int | None
    unreserved: tuple[str, ...] = ()


@dataclass(frozen=True)
class Restore:
    """Where a resumed job restored its state from, and when it reached RUNNING, in wall-clock seconds."""

    path: str | None
    is_savepoint: bool
    running_at: float


@dataclass(frozen=True)
class VertexLoad:
    busy_ms: float
    backpressured_ms: float


@dataclass(frozen=True)
class BenchReading:
    guard: Reading
    wal: Wal | None
    offsets: tuple[int, int] | None


class Cluster(Protocol):
    """The bench's view of the deployment. `cluster.LiveCluster` talks to it; tests hand in a fake."""

    def deployed(self, job: str) -> dict: ...

    def suspended_jobs(self) -> list[str]: ...

    def lock_bench(self, holder: str) -> str | None: ...

    def unlock_bench(self, holder: str) -> None: ...

    def freeze_argo(self, automated: dict) -> None: ...

    def restore_argo(self, removed: dict) -> None: ...

    def argo_automated(self) -> dict | None: ...

    def health(self, job: str) -> str | None: ...

    def suspend(self, job: str) -> str: ...

    def resume(self, job: str, savepoint: str) -> Restore: ...

    def reading(self, job: BenchJob, accepted: int) -> BenchReading: ...

    def flink_load(self, job: str) -> dict[str, VertexLoad]: ...

    def pod_usage(self, job: str) -> tuple[float | None, float | None]: ...

    def counters(self, job: str, since: float) -> dict: ...

    def tail(self) -> Tail: ...

    def connect(self) -> Client: ...


@dataclass(frozen=True)
class BenchOptions:
    job: BenchJob
    backlog: int
    runs: int = 5
    fill_eps: float = 1000.0
    probe_backlog: int = 20_000
    # The WAL the slots hold, plus the measured WAL per record times the backlog, must stay under this share of
    # max_slot_wal_keep_size before a run starts.
    wal_share: float = 0.5
    # How long a run waits for the slots to release earlier runs' WAL before the bench gives up.
    wal_wait_s: float = 1800.0
    batch: int = 25
    pixel_share: float = 0.05
    connections: int = 32
    interval_s: float = 5.0
    fill_timeout_s: float = 3600.0
    # The input topic's end offset must hold still this long before the resume, so upstream jobs have caught up.
    settle_s: float = 60.0
    drain_timeout_s: float = 3600.0
    seed: int | None = None

    def parameters(self) -> dict:
        return {"job": self.job.name, "input_topic": self.job.input_topic, "group": self.job.group,
                "backlog": self.backlog, "runs": self.runs, "fill_eps": self.fill_eps,
                "probe_backlog": self.probe_backlog, "wal_share": self.wal_share, "wal_wait_s": self.wal_wait_s,
                "batch": self.batch,
                "pixel_share": self.pixel_share, "connections": self.connections, "interval_s": self.interval_s,
                "fill_timeout_s": self.fill_timeout_s, "settle_s": self.settle_s,
                "drain_timeout_s": self.drain_timeout_s}


@dataclass
class BenchResult:
    runs: list[PhaseResult] = field(default_factory=list)
    checks: list[ExpectationResult] = field(default_factory=list)
    measurements: list[Measurement] = field(default_factory=list)
    samples: list[dict] = field(default_factory=list)


class BenchGuard:
    """The load run's stop conditions plus the WAL the slots hold and slots that are no longer reserved."""

    def __init__(self) -> None:
        self._stop = StopGuard(Limits())
        self._missed_wal = 0

    def check(self, reading: BenchReading) -> str | None:
        if reason := self._stop.check(reading.guard):
            return reason
        wal = reading.wal
        self._missed_wal = 0 if wal else self._missed_wal + 1
        if self._missed_wal >= self._stop.limits.missed_readings:
            return f"cannot read the WAL the replication slots hold in {self._missed_wal} readings in a row"
        if wal is None:
            return None
        if wal.unreserved:
            return f"replication slots no longer reserved: {', '.join(wal.unreserved)}"
        if not wal.cap:
            return "cannot read max_slot_wal_keep_size, or it is unlimited, so the bench cannot size its WAL against it"
        if wal.held / wal.cap > WAL_STOP_SHARE:
            return (f"the replication slots hold {wal.held / wal.cap:.0%} of max_slot_wal_keep_size, over"
                    f" {WAL_STOP_SHARE:.0%}")
        return None

    def unreadable(self, reading: BenchReading) -> str | None:
        if reason := self._stop.unreadable(reading.guard):
            return reason
        if reading.wal is None:
            return "cannot read the WAL the replication slots hold, so the WAL cap cannot be watched"
        if reading.offsets is None:
            return "cannot read the job's committed offsets on its input topic"
        return None


def limiter(loads: dict[str, VertexLoad], cpu_cores: float | None, parallelism: int) -> str | None:
    """What bounded the drain, from the job's own metrics (SIM-FR-22). None when the metrics name nothing.

    The bound is the busiest vertex that is not itself backpressured: its upstream waits on it, and nothing
    downstream holds it back. Its TaskManagers' CPU then says whether it computes or waits, on Postgres or Kafka.
    """
    free = [(name, load) for name, load in loads.items()
            if load.busy_ms >= BUSY_MS and load.backpressured_ms < BACKPRESSURED_MS]
    if not free:
        return None
    name, load = max(free, key=lambda item: item[1].busy_ms)
    if cpu_cores is None:
        return f"operator {name!r} (busy {load.busy_ms:.0f} ms/s; TaskManager CPU unread)"
    per_subtask = cpu_cores / max(parallelism, 1)
    if per_subtask >= CPU_BOUND_CORES:
        return f"CPU of operator {name!r} (busy {load.busy_ms:.0f} ms/s at {per_subtask:.2f} cores per subtask)"
    return (f"operator {name!r} waiting off CPU, such as on Postgres or Kafka (busy {load.busy_ms:.0f} ms/s at"
            f" {per_subtask:.2f} cores per subtask)")


def average_loads(samples: list[dict[str, VertexLoad]]) -> dict[str, VertexLoad]:
    names = {name for sample in samples for name in sample}
    averaged = {}
    for name in sorted(names):
        loads = [sample[name] for sample in samples if name in sample]
        averaged[name] = VertexLoad(sum(load.busy_ms for load in loads) / len(loads),
                                    sum(load.backpressured_ms for load in loads) / len(loads))
    return averaged


def deployed_without_state(spec: dict) -> dict:
    """The spec the bench must not change: everything but the job's running or suspended state (SIM-FR-27)."""
    job = {key: value for key, value in spec.get("job", {}).items() if key != "state"}
    return {**spec, "job": job}


def parallelism_of(spec: dict) -> int:
    return int(spec.get("job", {}).get("parallelism") or 1)


class Bench:
    def __init__(self, options: BenchOptions, run_id: str, cluster: Cluster, clock: Callable[[], float] = time.time,
                 sleep: Callable[[float], None] = time.sleep,
                 log: Callable[[str], None] = lambda line: print(line, flush=True)) -> None:
        self.options = options
        self.run_id = run_id
        self.cluster = cluster
        self.clock = clock
        self.sleep = sleep
        self.log = log
        self.guard = BenchGuard()
        self.result = BenchResult()
        self.shoppers = 0
        self.accepted = 0
        self.stop_reason: str | None = None
        self.restores: list[tuple[str, Restore]] = []
        self.parallelism = 1
        # The savepoint of a job the bench suspended and has not yet seen running again. While it is set, Argo CD
        # stays frozen: a sync would start the job without the bench checking where it restored from.
        self.suspended_at: str | None = None
        self.resume_attempted = False
        self.resume_sent = False
        self.argo_frozen = False
        self.argo_before: dict | None = None
        # The most WAL a record has cost over a whole run so far, from the probe and each run.
        self.wal_per_record: float | None = None
        self.idle_wal_bytes_per_s = 0.0

    @property
    def job(self) -> BenchJob:
        return self.options.job

    def read(self, accepted: int | None = None) -> BenchReading:
        return self.cluster.reading(self.job, self.accepted if accepted is None else accepted)

    def sample(self, stage: str, run: str, reading: BenchReading, **extra) -> None:
        entry = {"t": round(self.clock(), 1), "run": run, "stage": stage, **asdict_reading(reading.guard),
                 "wal": None if reading.wal is None else {"held": reading.wal.held, "cap": reading.wal.cap,
                                                          "unreserved": list(reading.wal.unreserved)},
                 "committed": reading.offsets[0] if reading.offsets else None,
                 "end": reading.offsets[1] if reading.offsets else None, **extra}
        self.result.samples.append(entry)
        lag = reading.offsets[1] - reading.offsets[0] if reading.offsets else "?"
        self.log(f"{run} {stage}: lag={lag} accepted={self.accepted} dead={reading.guard.dead_letters}"
                 f" wal_held={entry['wal']['held'] if entry['wal'] else '?'} {extra or ''}".rstrip())

    def guarded(self, stage: str, run: str, accepted: int | None = None, **extra) -> BenchReading:
        reading = self.read(accepted)
        self.sample(stage, run, reading, **extra)
        if reason := self.guard.check(reading):
            raise BenchError(f"{run} {stage}: {reason}")
        return reading

    def run(self) -> BenchResult:
        try:
            refusal = self.cluster.lock_bench(self.run_id)
        except Exception as error:  # noqa: BLE001  Nothing is changed yet, such as on a missing permission.
            refusal = f"cannot take the bench lock: {type(error).__name__}: {error}"
        if refusal:
            self.refuse(refusal)
            return self.result
        try:
            self.locked_run()
        finally:
            self.result.checks.append(self.unlock_check())
        return self.result

    def locked_run(self) -> None:
        try:
            spec = self.cluster.deployed(self.job.name)
            self.parallelism = parallelism_of(spec)
            refusal = self.preflight(spec)
        except Exception as error:  # noqa: BLE001  Nothing is changed yet, such as on a missing permission.
            refusal = f"{type(error).__name__}: {error}"
        if refusal:
            self.refuse(refusal)
            return
        tail = None
        try:
            self.cluster.freeze_argo(self.argo_before)
            self.argo_frozen = True
            self.log(f"Argo CD automated sync of cdp-root removed: {self.argo_before}")
            tail = self.cluster.tail()
            tail.start()
            self.runs(tail)
        except BenchError as error:
            self.stop_reason = str(error)
        except BaseException as error:  # noqa: BLE001  SIGTERM included: the report must still say what was left.
            self.stop_reason = f"{type(error).__name__}: {error}"
        finally:
            if tail is not None:
                try:
                    tail.stop()
                except Exception as error:  # noqa: BLE001  Argo CD must come back whatever the tail does.
                    self.log(f"the run tail did not stop: {type(error).__name__}: {error}")
            self.result.checks.append(self.argo_check())
        self.result.checks += self.checks(spec)

    def preflight(self, spec: dict) -> str | None:
        job = spec.get("job", {})
        if job.get("state") != "running":
            return f"{self.job.name} is not running: spec.job.state is {job.get('state')!r}"
        if job.get("upgradeMode") != "savepoint":
            return (f"{self.job.name} has upgradeMode {job.get('upgradeMode')!r}, not 'savepoint', so a suspend would"
                    " not take the savepoint the resume needs")
        if others := self.cluster.suspended_jobs():
            return (f"jobs already suspended: {', '.join(others)}. Someone else is changing Flink state; restoring"
                    " Argo CD's automated sync afterwards would start them")
        self.argo_before = self.cluster.argo_automated()
        if self.argo_before is None:
            return ("Argo CD's automated sync of cdp-root is already off, so someone else may be changing the cluster"
                    " and could put it back while a job is suspended. Put it back, or wait until they finish")
        first = self.read()
        self.sample("before", "preflight", first)
        if reason := self.guard.unreadable(first) or self.guard.check(first):
            return reason
        self.sleep(self.options.interval_s)
        second = self.read()
        self.sample("before", "preflight", second)
        if reason := self.guard.unreadable(second) or self.guard.check(second):
            return reason
        self.idle_wal_bytes_per_s = max(second.wal.lsn - first.wal.lsn, 0) / self.options.interval_s
        return None

    def refuse(self, reason: str) -> None:
        self.result.checks.append(ExpectationResult("bench", "The bench can start safely", ("SIM-FR-21",), "not run",
                                                    reason=reason))
        self.result.measurements.append(Measurement(self.measurement_name, "records/s", (), ()))

    @property
    def measurement_name(self) -> str:
        return f"{self.job.name} drain rate of {self.job.input_topic}"

    def runs(self, tail: Tail) -> None:
        options = self.options
        if options.backlog > options.probe_backlog:
            self.one_run("probe", options.probe_backlog, tail)
            if self.wal_per_record is None:
                raise BenchError("probe: the WAL a record costs is unknown, so the backlog cannot be sized against"
                                 " max_slot_wal_keep_size")
        for n in range(1, options.runs + 1):
            self.one_run(f"run {n}", options.backlog, tail)

    @property
    def run_wal_per_record(self) -> float:
        """The WAL a record is expected to cost: the most a run has measured, or a conservative estimate before any
        run has. A record of snowplow-good is one collector request, which holds up to a batch of events."""
        if self.wal_per_record is not None:
            return self.wal_per_record
        events = self.options.batch if self.job.input_topic == "snowplow-good" else 1
        return float(UNMEASURED_WAL_PER_EVENT * events)

    def plan_wal(self, name: str, target: int) -> None:
        """Waits until the WAL the slots hold, plus what the run is expected to write, fits under wal_share of the cap.

        The slots keep WAL until the CDC sources confirm it, so earlier runs' WAL counts as held until they let it
        go. A run with no measured cost, the probe or a run no larger than it, uses the conservative estimate."""
        options = self.options
        deadline = self.clock() + options.wal_wait_s
        while True:
            wal = self.guarded("health", name).wal
            if wal is not None:
                per_record = self.run_wal_per_record
                need = per_record * target
                budget = options.wal_share * wal.cap
                if wal.held + need <= budget:
                    return
                if self.clock() >= deadline:
                    safe = int(max(budget - wal.held, 0) / per_record)
                    source = ("measured over the fill, the drain, and the writes after it" if self.wal_per_record
                              else "an estimate, since no run has measured it yet")
                    flag = "--probe-backlog" if name == "probe" else "--backlog"
                    raise BenchError(
                        f"{name}: the replication slots already hold {mib(wal.held)} MiB of WAL, and a backlog of"
                        f" {target} records would add about {mib(need)} MiB ({per_record:.0f} bytes per record,"
                        f" {source}). That is over {options.wal_share:.0%} of max_slot_wal_keep_size"
                        f" ({mib(wal.cap)} MiB), still after {options.wal_wait_s:g} s of waiting for the slots to"
                        f" release WAL. Rerun with {flag} {safe} or less")
                self.log(f"{name}: waiting for the replication slots to release WAL: they hold {mib(wal.held)} MiB,"
                         f" the run needs {mib(need)} MiB, and {mib(budget)} MiB is allowed")
            self.sleep(options.interval_s)

    def check_projection(self, name: str, stage: str, wal: Wal | None, more: float) -> None:
        """Stops the run when the held WAL plus what the rest of the run is projected to write passes the stop
        share. A stop during the fill leaves a smaller backlog to drain than the projection counted."""
        if wal is None or not wal.cap:
            return
        projected = wal.held + more
        if projected > WAL_STOP_SHARE * wal.cap:
            raise BenchError(
                f"{name} {stage}: the replication slots hold {mib(wal.held)} MiB of WAL and the rest of the run is"
                f" projected to add {mib(more)} MiB, {projected / wal.cap:.0%} of max_slot_wal_keep_size"
                f" ({mib(wal.cap)} MiB), over {WAL_STOP_SHARE:.0%}. The bench stopped before the slots got there")

    def one_run(self, name: str, target: int, tail: Tail) -> dict:
        job = self.job.name
        self.plan_wal(name, target)
        if problem := self.cluster.health(job):
            raise BenchError(f"{name}: {job} is not healthy, so it may not take a savepoint: {problem}")
        self.log(f"{name}: suspending {job} with a savepoint")
        # Until the suspend returns, the job may be stopped at a savepoint the bench has not seen, so Argo CD stays
        # frozen unless the suspend says the job never stopped.
        self.suspended_at = "a savepoint the suspend did not report"
        try:
            savepoint = self.cluster.suspend(job)
        except BenchError:
            self.suspended_at = None
            raise
        self.suspended_at = savepoint
        self.log(f"{name}: suspended at savepoint {savepoint}")
        # Event parse writes nothing of this run while it is suspended, so its output counts from here.
        counted_before = sum(tail.counts.values())
        try:
            fill = self.fill(name, target)
            fill["committed"], end = self.settle(name, target)
            fill["backlog"] = end - fill["committed"]
        finally:
            restore = self.resume(name, job, savepoint)
        metrics = {"savepoint": savepoint, "restored_from": restore.path, "restored_is_savepoint": restore.is_savepoint,
                   **fill}
        if not (restore.is_savepoint and same_path(restore.path, savepoint)):
            self.fail_run(name, target, metrics, "the job did not restore from the savepoint it suspended with")
            raise BenchError(f"{name}: {job} restored from {restore.path}, not from its savepoint {savepoint}")
        if fill["backlog"] < target:
            self.fail_run(name, target, metrics, f"the backlog reached only {fill['backlog']} records")
            raise BenchError(f"{name}: the backlog reached only {fill['backlog']} of {target} records")
        try:
            metrics |= self.drain(name, restore, fill, tail, counted_before)
        except BenchError as error:
            self.fail_run(name, target, metrics, str(error))
            raise
        reason = run_failure(metrics, self.job.name)
        self.result.runs.append(PhaseResult(name, "fail" if reason else "pass", {"backlog": target}, metrics, reason))
        if reason:
            raise BenchError(f"{name}: {reason}")
        return metrics

    def fail_run(self, name: str, target: int, metrics: dict, reason: str) -> None:
        self.result.runs.append(PhaseResult(name, "fail", {"backlog": target}, metrics, reason))

    def resume(self, name: str, job: str, savepoint: str) -> Restore:
        self.log(f"{name}: resuming {job} from {savepoint}")
        self.resume_attempted = True
        try:
            restore = self.cluster.resume(job, savepoint)
        except ResumeUnconfirmed:
            self.resume_sent = True
            raise
        self.suspended_at = None
        self.restores.append((savepoint, restore))
        return restore

    def fill(self, name: str, target: int) -> dict:
        """Sends shoppers at fill_eps until the input topic holds the target backlog, or the fill times out."""
        options = self.options
        profile = Profile((Phase("steady", options.fill_eps, options.fill_timeout_s),))
        meter = Meter(profile)
        start = self.read()
        started = self.clock()
        pacer = Pacer(self.run_id, profile, random.Random(options.seed), options.batch, options.pixel_share,
                      sample_every=10**9, first_shopper=FIRST_SHOPPER + self.shoppers)
        sender = Sender(pacer, self.cluster.connect, options.connections, meter.record, lambda *_: None,
                        meter.backpressure, lambda: self.clock() - started)
        sender.start()
        backlog = 0
        try:
            while not sender.done:
                self.sleep(options.interval_s)
                reading = self.guarded("fill", name, self.accepted + meter.accepted,
                                       sent=meter.phases[0].events_sent)
                backlog = reading.offsets[1] - reading.offsets[0] if reading.offsets else backlog
                if backlog >= target:
                    break
                self.check_fill_wal(name, start, reading, self.clock() - started, target)
        finally:
            sender.abort()
            sender.join()
            self.shoppers += pacer.shoppers
            self.accepted += meter.accepted
        phase = meter.phases[0]
        return {"fill_s": round(self.clock() - started, 1), "events_sent": phase.events_sent,
                "send_errors": phase.send_errors, "accepted": phase.events_sent - phase.send_errors,
                "fill_backlog": backlog, "wal_start": start.wal.lsn if start.wal else None}

    def check_fill_wal(self, name: str, start: BenchReading, reading: BenchReading, elapsed: float,
                       target: int) -> None:
        """Projects the rest of the run's WAL from the rate the fill writes it now, plus the drain's measured cost."""
        if start.wal is None or reading.wal is None or elapsed <= 0:
            return
        grown = lag(reading) - lag(start)
        records_per_s = grown / elapsed if grown > 0 else self.options.fill_eps
        wal_per_s = max(reading.wal.lsn - start.wal.lsn, 0) / elapsed
        rest_of_fill = wal_per_s * max(target - lag(reading), 0) / records_per_s
        self.check_projection(name, "fill", reading.wal, rest_of_fill + self.run_wal_per_record * target)

    def settle(self, name: str, target: int) -> tuple[int, int]:
        """Waits until the input topic's end offset holds still for settle_s. Returns the committed and end offsets
        then."""
        options = self.options
        deadline = self.clock() + options.drain_timeout_s
        last_end, still_since = None, self.clock()
        while True:
            reading = self.guarded("settle", name)
            self.check_projection(name, "settle", reading.wal, self.run_wal_per_record * target)
            if reading.offsets is not None:
                committed, end = reading.offsets
                if end != last_end:
                    last_end, still_since = end, self.clock()
                elif self.clock() - still_since >= options.settle_s:
                    return committed, end
            if self.clock() >= deadline:
                raise BenchError(f"{name}: the input topic's end offset did not hold still within"
                                 f" {options.drain_timeout_s:g} s")
            self.sleep(options.interval_s)

    def drain(self, name: str, restore: Restore, fill: dict, tail: Tail, counted_before: int) -> dict:
        options = self.options
        backlog = fill["backlog"]
        job = self.job.name
        start = self.read()
        if start.offsets is None:
            raise BenchError(f"{name}: cannot read the committed offsets at the resume")
        # The job may commit before the first reading after its resume, so the drain counts from where it stopped.
        first_committed, first_end = fill["committed"], start.offsets[1]
        wal_start = start.wal.lsn if start.wal else None
        loads: list[dict[str, VertexLoad]] = []
        cpu: list[float] = []
        memory: list[float] = []
        deadline = self.clock() + options.drain_timeout_s
        reading = start
        while True:
            self.sleep(options.interval_s)
            try:
                loads.append(self.cluster.flink_load(job))
            except Exception as error:  # noqa: BLE001  A missing metric weakens the limiter, not the run.
                self.log(f"{name} drain: Flink metrics unread: {type(error).__name__}: {error}")
            cores, bytes_ = self.cluster.pod_usage(job)
            if cores is not None:
                cpu.append(cores)
            if bytes_ is not None:
                memory.append(bytes_)
            reading = self.guarded("drain", name, cpu_cores=cores)
            # Done when the job has committed the backlog that stood at the resume. Input that arrives later does
            # not stretch the drain; the sender check reports it.
            if reading.offsets is not None and reading.offsets[0] >= first_end:
                break
            if self.clock() >= deadline:
                raise BenchError(f"{name}: the backlog did not drain within {options.drain_timeout_s:g} s")
        drained_at = self.clock()
        committed, end = reading.offsets
        consumed = committed - first_committed
        drain_s = drained_at - restore.running_at
        averaged = average_loads(loads)
        cpu_avg = sum(cpu) / len(cpu) if cpu else None
        wal_bytes = reading.wal.lsn - wal_start if reading.wal and wal_start is not None else None
        quiet_lsn = self.quiet(name, reading)
        run_wal = quiet_lsn - fill["wal_start"] if fill["wal_start"] is not None else None
        run_wal_per_record = run_wal / backlog if run_wal is not None and backlog else None
        if run_wal_per_record is not None:
            self.wal_per_record = max(self.wal_per_record or 0.0, run_wal_per_record)
        metrics = {
            "backlog": backlog,
            "consumed": consumed,
            "input_end_growth": end - first_end,
            "drain_s": round(drain_s, 1),
            "drain_rate": round(consumed / drain_s, 1) if drain_s > 0 else None,
            # The drain's end is seen at the first reading after the job committed its last offsets, and the job
            # commits on each checkpoint, so drain_s runs long by up to a reading interval plus a checkpoint interval.
            "resolution_s": options.interval_s,
            "events_per_record": round(fill["accepted"] / backlog, 3) if backlog else None,
            "vertices": {vertex: {"busy_ms": round(load.busy_ms), "backpressured_ms": round(load.backpressured_ms)}
                         for vertex, load in averaged.items()},
            "taskmanager_cpu_cores": {"avg": round(cpu_avg, 3) if cpu_avg is not None else None,
                                      "max": round(max(cpu), 3) if cpu else None},
            "taskmanager_memory_bytes_max": max(memory) if memory else None,
            "wal_bytes_drain": wal_bytes,
            "wal_bytes_run": run_wal,
            "wal_bytes_per_record": run_wal_per_record,
            "wal_cap": reading.wal.cap if reading.wal else None,
            **self.cluster.counters(job, restore.running_at),
        }
        if self.job.name == COUNTED_OUTPUT:
            metrics["output_events"] = self.wait_for_outputs(tail, counted_before, fill["accepted"])
        metrics["limiter"] = limiter(averaged, cpu_avg, self.parallelism)
        self.log(f"{name}: drained {consumed} records in {drain_s:.1f} s, limiter {metrics['limiter']}")
        return metrics

    def quiet(self, name: str, last: BenchReading) -> int:
        """Waits until WAL grows no faster than before the bench, so the jobs downstream have written what the run
        caused. Returns the WAL position then."""
        options = self.options
        allowed = max(2 * self.idle_wal_bytes_per_s, QUIET_FLOOR_BYTES_PER_S) * options.interval_s
        previous = last.wal.lsn if last.wal else None
        deadline = self.clock() + options.drain_timeout_s
        while True:
            self.sleep(options.interval_s)
            wal = self.guarded("quiet", name).wal
            if wal is not None and previous is not None and wal.lsn - previous <= allowed:
                return wal.lsn
            previous = wal.lsn if wal else None
            if self.clock() >= deadline:
                raise BenchError(f"{name}: WAL kept growing faster than before the bench for"
                                 f" {options.drain_timeout_s:g} s after the drain, so its cost per record is unknown")

    def wait_for_outputs(self, tail: Tail, before: int, expected: int) -> int:
        """The run's events event parse wrote to snowplow-parsed or the dead letters during the drain."""
        deadline = self.clock() + max(self.options.settle_s, 60.0)
        while sum(tail.counts.values()) - before < expected and self.clock() < deadline and not tail.error:
            self.sleep(self.options.interval_s)
        return sum(tail.counts.values()) - before

    def argo_check(self) -> ExpectationResult:
        """Puts back the automated sync the bench removed, unless a job may still be without its savepoint. A freeze
        that failed may or may not have removed it, so the bench reads it first."""
        expectation = "Argo CD's automated sync of cdp-root is back as it was"
        removed, job, savepoint = self.argo_before, self.job.name, self.suspended_at
        if savepoint and self.resume_sent:
            return ExpectationResult(
                "bench", expectation, ("SIM-FR-21",), "fail", evidence={"removed": removed, "suspended_at": savepoint},
                reason=(f"the bench set {job} running from savepoint {savepoint} but did not see it run from there,"
                        " and left automated sync off. Its spec already says running, so do not resume it again."
                        " Wait for STABLE/RUNNING, check that its restored checkpoint (latest.restored of"
                        f" /jobs/<id>/checkpoints) is {savepoint}, then put back syncPolicy.automated: {removed}"))
        if savepoint and self.resume_attempted:
            return ExpectationResult(
                "bench", expectation, ("SIM-FR-21",), "fail", evidence={"removed": removed, "suspended_at": savepoint},
                reason=(f"the bench was resuming {job} from savepoint {savepoint} when it stopped, and left automated"
                        " sync off. It may have set the job running. Read its spec.job.state first: if it is"
                        " running, do not resume it again, and check that its restored checkpoint is the savepoint;"
                        " if it is suspended, resume it from the savepoint by hand. Then put back"
                        f" syncPolicy.automated: {removed}"))
        if savepoint:
            return ExpectationResult(
                "bench", expectation, ("SIM-FR-21",), "fail", evidence={"removed": removed, "suspended_at": savepoint},
                reason=(f"the bench left {job} suspended at savepoint {savepoint} and automated sync off. Resume the"
                        " job from that savepoint by hand, check where it restored from, then put back"
                        f" syncPolicy.automated: {removed}"))
        if not self.argo_frozen:
            return self.unconfirmed_freeze_check(expectation)
        try:
            now = self.cluster.argo_automated()
            if now is None:
                self.cluster.restore_argo(removed)
                now = self.cluster.argo_automated()
        except Exception as error:  # noqa: BLE001  The report must say so, and how to put it back.
            return ExpectationResult("bench", expectation, ("SIM-FR-21",), "fail", evidence={"removed": removed},
                                     reason=f"{type(error).__name__}: {error}. Put back syncPolicy.automated: {removed}")
        ok = now == removed
        return ExpectationResult("bench", expectation, ("SIM-FR-21",), "pass" if ok else "fail",
                                 evidence={"removed": removed, "now": now},
                                 reason=None if ok else f"automated is {now}, not {removed}")

    def unconfirmed_freeze_check(self, expectation: str) -> ExpectationResult:
        """The freeze raised, so the bench may not have removed anything and puts nothing back. A test op that failed
        because another actor removed or changed automated sync must not be undone by the bench (lesson 54)."""
        removed = self.argo_before
        try:
            now = self.cluster.argo_automated()
        except Exception as error:  # noqa: BLE001  The report must say what to look at.
            now, unread = None, f"{type(error).__name__}: {error}"
        else:
            unread = None
        if unread is None and now == removed:
            return ExpectationResult("bench", expectation, ("SIM-FR-21",), "pass",
                                     evidence={"read": removed, "now": now, "note": "the freeze changed nothing"})
        return ExpectationResult(
            "bench", expectation, ("SIM-FR-21",), "fail", evidence={"read": removed, "now": now},
            reason=(f"the bench did not confirm its freeze, so it put nothing back. automated is now"
                    f" {unread or now}, where the bench read {removed}. Find out who changed it. Only if the"
                    f" bench's own freeze removed it, put back syncPolicy.automated: {removed}"))

    def unlock_check(self) -> ExpectationResult:
        expectation = "The bench lock is released"
        try:
            self.cluster.unlock_bench(self.run_id)
        except Exception as error:  # noqa: BLE001  The next bench would refuse, so the report says what to delete.
            return ExpectationResult("bench", expectation, ("SIM-FR-21",), "fail",
                                     reason=f"{type(error).__name__}: {error}. Once no bench Job runs, delete it:"
                                            " kubectl -n cdp delete lease cdp-sim-bench")
        return ExpectationResult("bench", expectation, ("SIM-FR-21",), "pass")

    def checks(self, spec_before: dict) -> list[ExpectationResult]:
        finished = [run for run in self.result.runs if run.phase != "probe"]
        values = tuple(run.metrics["drain_rate"] for run in finished if run.result == "pass")
        limiters = tuple(run.metrics.get("limiter") for run in finished if run.result == "pass")
        self.result.measurements.append(Measurement(self.measurement_name, "records/s", values, limiters))
        checks = [self.stop_check(), self.restore_check(), self.delivery_check(), self.sender_check(),
                  self.deployed_check(spec_before)]
        return checks

    def stop_check(self) -> ExpectationResult:
        complete = len([run for run in self.result.runs if run.phase != "probe"]) == self.options.runs
        return ExpectationResult(
            "bench", "Every run finished with no stop condition", ("SIM-FR-12", "SIM-FR-21"),
            "fail" if self.stop_reason else ("pass" if complete else "not run"), reason=self.stop_reason,
            evidence={"runs": [run.phase for run in self.result.runs], "wanted": self.options.runs})

    def restore_check(self) -> ExpectationResult:
        expectation = "Every run resumed from the savepoint it suspended with"
        evidence = {"restores": [{"savepoint": savepoint, "restored_from": restore.path,
                                  "is_savepoint": restore.is_savepoint} for savepoint, restore in self.restores]}
        if not self.restores:
            return ExpectationResult("bench", expectation, ("SIM-FR-21",), "not run", evidence=evidence,
                                     reason="no run suspended the job")
        bad = [savepoint for savepoint, restore in self.restores
               if not (restore.is_savepoint and same_path(restore.path, savepoint))]
        return ExpectationResult("bench", expectation, ("SIM-FR-21",), "fail" if bad else "pass", evidence=evidence,
                                 reason=f"not restored from {', '.join(bad)}" if bad else None)

    def delivery_check(self) -> ExpectationResult:
        expectation = "Each run consumed its backlog with no errors, restarts, or failed checkpoints"
        drained = [run for run in self.result.runs if "consumed" in run.metrics]
        if not drained:
            return ExpectationResult("bench", expectation, ("SIM-FR-24",), "not run", reason="no run drained")
        evidence = {run.phase: {key: run.metrics.get(key) for key in (
            "backlog", "consumed", "accepted", "send_errors", "output_events", "exceptions", "restarts",
            "checkpoints_failed")} for run in drained}
        failed = [f"{run.phase}: {run.reason}" for run in drained if run.result == "fail"]
        return ExpectationResult("bench", expectation, ("SIM-FR-24",), "fail" if failed else "pass",
                                 evidence=evidence, reason="; ".join(failed) or None)

    def sender_check(self) -> ExpectationResult:
        expectation = "The sender is not the limiter: no input arrived during a drain"
        drained = [run for run in self.result.runs if "input_end_growth" in run.metrics]
        if not drained:
            return ExpectationResult("bench", expectation, ("SIM-FR-25",), "not run", reason="no run drained")
        growth = {run.phase: run.metrics["input_end_growth"] for run in drained}
        grew = {phase: records for phase, records in growth.items() if records > 0}
        return ExpectationResult(
            "bench", expectation, ("SIM-FR-25",), "fail" if grew else "pass",
            evidence={"input_end_growth": growth},
            reason=f"records arrived on {self.job.input_topic} during the drain: {grew}" if grew else None)

    def deployed_check(self, spec_before: dict) -> ExpectationResult:
        expectation = "The job ran as deployed, and the bench changed nothing but its running state"
        try:
            spec_after = self.cluster.deployed(self.job.name)
        except Exception as error:  # noqa: BLE001
            return ExpectationResult("bench", expectation, ("SIM-FR-27",), "not run",
                                     reason=f"cannot read the job after the bench: {type(error).__name__}: {error}")
        before, after = deployed_without_state(spec_before), deployed_without_state(spec_after)
        config = spec_before.get("flinkConfiguration", {})
        evidence = {"image": spec_before.get("image"), "parallelism": parallelism_of(spec_before),
                    "state_backend": config.get("state.backend.type"),
                    "taskmanager": spec_before.get("taskManager", {}).get("resource"),
                    "state_after": spec_after.get("job", {}).get("state")}
        ok = before == after and evidence["state_after"] == "running"
        return ExpectationResult("bench", expectation, ("SIM-FR-27",), "pass" if ok else "fail", evidence=evidence,
                                 reason=None if ok else "the job's spec after the bench differs from before")


def mib(size: float) -> str:
    return f"{size / 2**20:.0f}"


def lag(reading: BenchReading) -> int:
    return reading.offsets[1] - reading.offsets[0] if reading.offsets else 0


def same_path(left: str | None, right: str | None) -> bool:
    return bool(left and right) and left.rstrip("/") == right.rstrip("/")


def run_failure(metrics: dict, job: str) -> str | None:
    reasons = []
    if metrics["consumed"] < metrics["backlog"]:
        reasons.append(f"consumed {metrics['consumed']} of a {metrics['backlog']} record backlog")
    for counter in ("exceptions", "restarts", "checkpoints_failed"):
        if metrics.get(counter):
            reasons.append(f"{metrics[counter]} {counter.replace('_', ' ')} during the drain")
    if metrics["input_end_growth"] > 0:
        reasons.append(f"{metrics['input_end_growth']} records arrived during the drain")
    if job == COUNTED_OUTPUT and metrics.get("output_events", 0) < metrics["accepted"]:
        reasons.append(f"{metrics.get('output_events')} of {metrics['accepted']} accepted events reached"
                       " snowplow-parsed or the dead letters")
    return "; ".join(reasons) or None


def run(options: BenchOptions, run_id: str, cluster: Cluster, **kwargs) -> BenchResult:
    return Bench(options, run_id, cluster, **kwargs).run()
