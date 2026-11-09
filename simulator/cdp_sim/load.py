"""Load: shopper traffic at a rate profile, measured per phase while it runs (SIM-FR-10, SIM-FR-11, SIM-FR-12).

The profile is ramp, steady, peak, and soak. Ramp climbs from 0 to its rate; the others hold theirs. Every interval
the run reads lag and volume use, prints one line (SIM-NFR-05), and checks the stop conditions. When the profile ends
it drains: it waits until every event the collector accepted has reached snowplow-parsed or the dead letters, so the
report can confirm the work happened (SIM-FR-24).
"""

from __future__ import annotations

import math
import random
import threading
import time
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal, Protocol

from cdp_sim.report import ExpectationResult, PhaseResult
from cdp_sim.sender import Client, Pacer, Sender, Sent

PhaseName = Literal["ramp", "steady", "peak", "soak"]
PHASE_NAMES: tuple[PhaseName, ...] = ("ramp", "steady", "peak", "soak")
# NFR-03 and the stop condition's dead-letter share.
MAX_SEND_ERROR_RATE = 0.01
# A phase whose sender sent fewer events than this share of its target fell behind.
KEPT_UP_SHARE = 0.99
# The rate is defined per second, so a phase whose requests start over a second after they were due, at p99, did not
# hold its target rate even when every event went out in the end.
MAX_SEND_DELAY_MS = 1000.0
# The simulator's own CPU, in cores, at which the sender counts as the limiter. One process holds one core at most.
SENDER_CPU_LIMIT = 0.85


@dataclass(frozen=True)
class Phase:
    name: PhaseName
    eps: float
    duration_s: float

    @property
    def start_eps(self) -> float:
        return 0.0 if self.name == "ramp" else self.eps

    def events_after(self, elapsed_s: float) -> float:
        """The target events in the first `elapsed_s` of the phase: the area under its rate."""
        x = min(max(elapsed_s, 0.0), self.duration_s)
        return self.start_eps * x + (self.eps - self.start_eps) * x * x / (2 * self.duration_s)

    @property
    def target_events(self) -> float:
        return self.events_after(self.duration_s)


@dataclass(frozen=True)
class Profile:
    """The phases with a duration, in order. Built only by `parse_profile`, which drops a phase of 0 seconds."""

    phases: tuple[Phase, ...]

    @property
    def duration_s(self) -> float:
        return sum(phase.duration_s for phase in self.phases)

    def starts(self) -> list[float]:
        starts, t = [], 0.0
        for phase in self.phases:
            starts.append(t)
            t += phase.duration_s
        return starts

    def index_at(self, t: float) -> int:
        """The phase running at profile time t. After the end, the last phase."""
        index = 0
        for n, start in enumerate(self.starts()):
            if t >= start:
                index = n
        return index

    def events_by(self, t: float) -> float:
        return sum(phase.events_after(t - start) for phase, start in zip(self.phases, self.starts()))


def parse_phase(name: PhaseName, value: str) -> Phase:
    """`EPS:SECONDS`, as the engineer writes it on the command line."""
    try:
        eps_text, seconds_text = value.split(":")
        eps, seconds = float(eps_text), float(seconds_text)
    except ValueError:
        raise ValueError(f"--{name} {value!r}: expected EPS:SECONDS, such as 3000:600") from None
    if eps < 0 or seconds < 0 or not math.isfinite(eps) or not math.isfinite(seconds):
        raise ValueError(f"--{name} {value!r}: the rate and the duration must be 0 or more")
    return Phase(name, eps, seconds)


def parse_profile(values: dict[PhaseName, str]) -> Profile:
    phases = tuple(phase for name in PHASE_NAMES if (phase := parse_phase(name, values[name])).duration_s > 0)
    if not any(phase.eps > 0 for phase in phases):
        raise ValueError("the load profile sends nothing: give at least one phase a rate and a duration")
    return Profile(phases)


class Histogram:
    """Milliseconds in buckets about 5% wide, so a long run keeps its percentiles in bounded memory."""

    _PER_E = 20

    def __init__(self) -> None:
        self._buckets: Counter[int] = Counter()
        self.count = 0
        self.max = 0.0

    def add(self, ms: float) -> None:
        self._buckets[round(math.log1p(max(ms, 0.0)) * self._PER_E)] += 1
        self.count += 1
        self.max = max(self.max, ms)

    def percentile(self, q: float) -> float:
        rank, seen = q * self.count, 0
        for bucket in sorted(self._buckets):
            seen += self._buckets[bucket]
            if seen >= rank:
                return min(math.expm1(bucket / self._PER_E), self.max)
        return self.max

    def summary(self) -> dict:
        if not self.count:
            return {"count": 0}
        return {"count": self.count, **{f"p{q}": round(self.percentile(q / 100), 1) for q in (50, 95, 99)},
                "max": round(self.max, 1)}


@dataclass
class PhaseMeter:
    """What one phase measured. A hit belongs to the phase whose target it was released for; a latency to the phase
    its event was sent in."""

    events_sent: int = 0
    send_errors: int = 0
    requests: int = 0
    responses: Counter[str] = field(default_factory=Counter)
    response_ms: Histogram = field(default_factory=Histogram)
    delay_ms: Histogram = field(default_factory=Histogram)
    latency_ms: Histogram = field(default_factory=Histogram)
    lag: dict[str, list[int]] = field(default_factory=dict)
    volumes: dict[str, float] = field(default_factory=dict)
    backpressure_s: float = 0.0
    cpu_s: float = 0.0
    wall_s: float = 0.0

    def add_reading(self, reading: Reading) -> None:
        for topic, lag in reading.lag.items():
            if lag is not None:
                self.lag.setdefault(topic, []).append(lag)
        for volume, ratio in reading.volumes.items():
            if ratio is not None:
                self.volumes[volume] = max(self.volumes.get(volume, 0.0), ratio)


class Meter:
    """Per-phase measurements, fed by the sender's workers, the run tail, and the main loop. Thread-safe."""

    def __init__(self, profile: Profile) -> None:
        self.profile = profile
        self.phases = [PhaseMeter() for _ in profile.phases]
        self.interval = PhaseMeter()
        self._lock = threading.Lock()

    def _targets(self, at: float) -> tuple[PhaseMeter, PhaseMeter]:
        return self.phases[self.profile.index_at(at)], self.interval

    def record(self, sent: Sent) -> None:
        with self._lock:
            for meter in (self.phases[sent.phase], self.interval):
                meter.requests += 1
                meter.events_sent += sent.events
                meter.send_errors += 0 if sent.ok else sent.events
                meter.responses[sent.response] += 1
                meter.response_ms.add(sent.elapsed_ms)
                meter.delay_ms.add(sent.delay_ms)

    def latency(self, sent_at: float, ms: float) -> None:
        with self._lock:
            for meter in self._targets(sent_at):
                meter.latency_ms.add(ms)

    def backpressure(self, at: float, waited_s: float) -> None:
        with self._lock:
            for meter in self._targets(at):
                meter.backpressure_s += waited_s

    def add_reading(self, at: float, reading: Reading) -> None:
        with self._lock:
            self.phases[self.profile.index_at(at)].add_reading(reading)

    def add_time(self, at: float, cpu_s: float, wall_s: float) -> None:
        with self._lock:
            for meter in self._targets(at):
                meter.cpu_s += cpu_s
                meter.wall_s += wall_s

    def take_interval(self) -> PhaseMeter:
        with self._lock:
            interval, self.interval = self.interval, PhaseMeter()
            return interval

    @property
    def accepted(self) -> int:
        with self._lock:
            return sum(meter.events_sent - meter.send_errors for meter in self.phases)


@dataclass(frozen=True)
class Reading:
    """One look at the deployment. A gauge that could not be read is None, with its error in `errors`."""

    lag: dict[str, int | None]
    volumes: dict[str, float | None]
    errors: dict[str, str]
    dead_letters: int | None
    parsed: int
    accepted: int


@dataclass(frozen=True)
class Limits:
    volume_ratio: float = 0.70
    dead_letter_ratio: float = MAX_SEND_ERROR_RATE
    # Readings in a row with a stop-condition gauge unread, after which the run stops: it can no longer watch them.
    missed_readings: int = 3


class StopGuard:
    """The stop conditions of SIM-FR-12, checked on each reading. Returns why the run must stop, or None."""

    def __init__(self, limits: Limits) -> None:
        self.limits = limits
        self._missed = 0

    def check(self, reading: Reading) -> str | None:
        for volume in ("kafka", "postgres"):
            ratio = reading.volumes.get(volume)
            if ratio is not None and ratio > self.limits.volume_ratio:
                return f"the {volume.capitalize()} volume is {ratio:.0%} full, over {self.limits.volume_ratio:.0%}"
        dead = reading.dead_letters
        if dead is not None and reading.accepted and dead / reading.accepted > self.limits.dead_letter_ratio:
            return (f"{reading.dead_letters} of {reading.accepted} accepted events "
                    f"({reading.dead_letters / reading.accepted:.2%}) reached the dead-letter topic, over "
                    f"{self.limits.dead_letter_ratio:.0%}")
        unread = unread_gauges(reading)
        self._missed = self._missed + 1 if unread else 0
        if self._missed >= self.limits.missed_readings:
            return f"cannot read {describe_unread(reading, unread)} in {self._missed} readings in a row"
        return None

    def unreadable(self, reading: Reading) -> str | None:
        """Before any send: a gauge that cannot be read means the run could not stop in time, so it must not start."""
        unread = unread_gauges(reading)
        if not unread:
            return None
        return f"cannot read {describe_unread(reading, unread)}, so the stop conditions cannot be watched"


def unread_gauges(reading: Reading) -> list[str]:
    unread = [volume for volume in ("kafka", "postgres") if reading.volumes.get(volume) is None]
    return unread + (["dead_letters"] if reading.dead_letters is None else [])


def describe_unread(reading: Reading, unread: list[str]) -> str:
    return "; ".join(f"{gauge}: {reading.errors.get(gauge, 'no reading')}" for gauge in unread)


class Tail(Protocol):
    counts: dict[str, int]
    behind: int | None
    error: str | None

    def start(self) -> None: ...

    def sent_at(self, event_id: str, at: float) -> None: ...

    def stop(self) -> None: ...


@dataclass(frozen=True)
class LoadOptions:
    profile: Profile
    batch: int = 25
    pixel_share: float = 0.05
    connections: int = 32
    sample_every: int = 20
    interval_s: float = 15.0
    # A reading that has not finished by then counts as unread, so a hung broker or database cannot stall the guard.
    reading_deadline_s: float = 15.0
    drain_s: float = 300.0
    seed: int | None = None

    def parameters(self) -> dict:
        return {
            "phases": [{"phase": phase.name, "eps": phase.eps, "duration_s": phase.duration_s,
                        "start_eps": phase.start_eps} for phase in self.profile.phases],
            "batch": self.batch, "pixel_share": self.pixel_share, "connections": self.connections,
            "sample_every": self.sample_every, "interval_s": self.interval_s,
            "reading_deadline_s": self.reading_deadline_s, "drain_s": self.drain_s,
        }


@dataclass
class LoadResult:
    phases: list[PhaseResult]
    checks: list[ExpectationResult]
    samples: list[dict]


@dataclass(frozen=True)
class Parts:
    """The run's connections to the deployment, made by the caller so a test can hand in fakes."""

    connect: Callable[[], Client]
    tail: Callable[[Meter, Callable[[], float]], Tail]
    read: Callable[[Meter, Tail], Reading]


class Watchdog:
    """Runs each reading on its own thread and waits for it at most `deadline_s`.

    A reading that does not finish in time is None. While it still runs, the next reading does not start and is None
    at once, so a hung call never runs twice and never holds up the stop guard.
    """

    def __init__(self, read: Callable[[], Reading], deadline_s: float) -> None:
        self._read = read
        self._deadline_s = deadline_s
        self._running: threading.Thread | None = None

    def __call__(self) -> Reading | None:
        if self._running is not None and self._running.is_alive():
            return None
        outcome: list[Reading | BaseException] = []

        def read() -> None:
            try:
                outcome.append(self._read())
            except BaseException as error:  # noqa: BLE001  Raised again on the caller's thread.
                outcome.append(error)

        self._running = threading.Thread(target=read, daemon=True, name="sim-reading")
        self._running.start()
        self._running.join(self._deadline_s)
        if not outcome:
            return None
        if isinstance(outcome[0], BaseException):
            raise outcome[0]
        return outcome[0]


def unfinished(meter: Meter, tail: Tail, deadline_s: float) -> Reading:
    error = f"the reading did not finish within {deadline_s:g} s"
    return Reading(lag={}, volumes={"kafka": None, "postgres": None},
                   errors={"kafka": error, "postgres": error, "dead_letters": error}, dead_letters=None,
                   parsed=tail.counts["snowplow-parsed"], accepted=meter.accepted)


STOP_REQUIREMENTS = ("SIM-FR-12",)
DELIVERY_REQUIREMENTS = ("SIM-FR-24",)


def not_run(profile: Profile, reason: str) -> list[PhaseResult]:
    return [PhaseResult(phase.name, "not run", target_of(phase), reason=reason) for phase in profile.phases]


def target_of(phase: Phase) -> dict:
    return {"start_eps": phase.start_eps, "eps": phase.eps, "duration_s": phase.duration_s,
            "events": round(phase.target_events)}


def run(options: LoadOptions, run_id: str, parts: Parts, clock: Callable[[], float] = time.monotonic,
        log: Callable[[str], None] = lambda line: print(line, flush=True)) -> LoadResult:
    profile = options.profile
    meter = Meter(profile)
    guard = StopGuard(Limits())
    start = clock()

    def now() -> float:
        return clock() - start

    tail = parts.tail(meter, now)
    tail.start()
    watchdog = Watchdog(lambda: parts.read(meter, tail), options.reading_deadline_s)

    def read() -> Reading:
        return watchdog() or unfinished(meter, tail, options.reading_deadline_s)

    samples: list[dict] = []
    try:
        first = read()
        samples.append(sample(0.0, None, first, PhaseMeter(), tail, options))
        if reason := guard.unreadable(first):
            check = ExpectationResult("load", "The stop conditions can be watched", STOP_REQUIREMENTS, "not run",
                                      evidence=asdict_reading(first), reason=reason)
            return LoadResult(not_run(profile, reason), [check], samples)
        if reason := guard.check(first):
            check = ExpectationResult("load", "No stop condition holds", STOP_REQUIREMENTS, "fail",
                                      evidence=asdict_reading(first), reason=f"before sending: {reason}")
            return LoadResult(not_run(profile, reason), [check], samples)

        pacer = Pacer(run_id, profile, random.Random(options.seed), options.batch, options.pixel_share,
                      options.sample_every)
        sender = Sender(pacer, parts.connect, options.connections, meter.record, tail.sent_at, meter.backpressure, now)
        stop_reason, stopped_at = None, None
        start = clock()
        sender.start()
        cpu, wall = time.process_time(), clock()
        next_reading = options.interval_s
        while not sender.done:
            time.sleep(min(1.0, options.interval_s))
            now_cpu, now_wall = time.process_time(), clock()
            meter.add_time(now(), now_cpu - cpu, now_wall - wall)
            cpu, wall = now_cpu, now_wall
            if now() < next_reading:
                continue
            next_reading += options.interval_s
            at = min(now(), profile.duration_s)
            reading = read()
            meter.add_reading(at, reading)
            samples.append(sample(at, profile.phases[profile.index_at(at)], reading, meter.take_interval(), tail,
                                  options))
            log(sample_line(samples[-1]))
            if stop_reason := guard.check(reading):
                stopped_at = at
                log(f"stopping: {stop_reason}")
                sender.abort()
                break
        sender.join()
        drain = drained(meter, tail, options.drain_s, clock)
        log(f"drain: {drain}")
    finally:
        tail.stop()

    phases = phase_results(profile, meter, stopped_at, stop_reason)
    stop_check = ExpectationResult(
        "load", "No stop condition holds", STOP_REQUIREMENTS, "fail" if stop_reason else "pass",
        evidence={"stopped_at_s": round(stopped_at, 1) if stopped_at is not None else None,
                  "limits": {"volume_ratio": guard.limits.volume_ratio,
                             "dead_letter_ratio": guard.limits.dead_letter_ratio}},
        reason=stop_reason,
    )
    return LoadResult(phases, [stop_check, delivery_check(drain)], samples)


def drained(meter: Meter, tail: Tail, drain_s: float, clock: Callable[[], float]) -> dict:
    """Waits until the run's accepted events all reached snowplow-parsed or the dead letters, or drain_s passes."""
    accepted, started = meter.accepted, clock()
    reached = 0
    while True:
        reached = tail.counts["snowplow-parsed"] + tail.counts["snowplow-parsed-dead-letters"]
        if reached >= accepted or clock() - started >= drain_s or tail.error:
            break
        time.sleep(1.0)
    return {
        "accepted": accepted,
        "parsed": tail.counts["snowplow-parsed"],
        "dead_letters": tail.counts["snowplow-parsed-dead-letters"],
        "missing": max(0, accepted - reached),
        "extra": max(0, reached - accepted),
        "drain_s": round(clock() - started, 1),
        "tail_error": tail.error,
    }


def delivery_check(drain: dict) -> ExpectationResult:
    expectation = "Every event the collector accepted reached snowplow-parsed or the dead letters"
    if drain["tail_error"]:
        return ExpectationResult("load", expectation, DELIVERY_REQUIREMENTS, "not run", evidence=drain,
                                 reason=f"the run tail stopped: {drain['tail_error']}")
    if drain["missing"]:
        return ExpectationResult("load", expectation, DELIVERY_REQUIREMENTS, "fail", evidence=drain,
                                 reason=f"{drain['missing']} accepted events did not arrive within {drain['drain_s']} s")
    return ExpectationResult("load", expectation, DELIVERY_REQUIREMENTS, "pass", evidence=drain)


def phase_results(profile: Profile, meter: Meter, stopped_at: float | None, stop_reason: str | None) -> list[PhaseResult]:
    results = []
    for index, (phase, start) in enumerate(zip(profile.phases, profile.starts())):
        if stopped_at is not None and stopped_at < start:
            results.append(PhaseResult(phase.name, "not run", target_of(phase), reason=f"stopped: {stop_reason}"))
            continue
        ran_s = phase.duration_s if stopped_at is None else min(phase.duration_s, stopped_at - start)
        metrics = phase_metrics(phase, meter.phases[index], ran_s)
        if stopped_at is not None and stopped_at < start + phase.duration_s:
            results.append(PhaseResult(phase.name, "fail", target_of(phase), metrics, f"stopped: {stop_reason}"))
            continue
        reason = phase_failure(metrics)
        results.append(PhaseResult(phase.name, "fail" if reason else "pass", target_of(phase), metrics, reason))
    return results


def phase_metrics(phase: Phase, meter: PhaseMeter, ran_s: float) -> dict:
    target = phase.events_after(ran_s)
    cpu = meter.cpu_s / meter.wall_s if meter.wall_s else None
    return {
        "ran_s": round(ran_s, 1),
        "events_sent": meter.events_sent,
        "send_errors": meter.send_errors,
        "send_error_rate": round(meter.send_errors / meter.events_sent, 5) if meter.events_sent else None,
        "target_events": round(target),
        "achieved_eps": round(meter.events_sent / ran_s, 1) if ran_s else None,
        "achieved_share": round(meter.events_sent / target, 4) if target else None,
        "requests": meter.requests,
        "responses": dict(meter.responses),
        "response_ms": meter.response_ms.summary(),
        "send_delay_ms": meter.delay_ms.summary(),
        "latency_to_parsed_ms": meter.latency_ms.summary(),
        "lag": {topic: {"max": max(values), "last": values[-1]} for topic, values in meter.lag.items()},
        "volumes_max": {volume: round(ratio, 3) for volume, ratio in meter.volumes.items()},
        "sender": {"cpu_cores": round(cpu, 3) if cpu is not None else None,
                   "backpressure_s": round(meter.backpressure_s, 1)},
    }


def phase_failure(metrics: dict) -> str | None:
    reasons = []
    if (rate := metrics["send_error_rate"]) is not None and rate >= MAX_SEND_ERROR_RATE:
        reasons.append(f"send errors {rate:.2%}, not under {MAX_SEND_ERROR_RATE:.0%}")
    if (share := metrics["achieved_share"]) is not None and share < KEPT_UP_SHARE:
        reasons.append(f"sent {share:.1%} of the target events; limiter: {limiter(metrics)}")
    elif (delay := metrics["send_delay_ms"].get("p99")) is not None and delay > MAX_SEND_DELAY_MS:
        reasons.append(f"requests started {delay:.0f} ms after they were due, at p99; limiter: {limiter(metrics)}")
    return "; ".join(reasons) or None


def limiter(metrics: dict) -> str:
    """Why the sender fell behind, from what it measured: its own CPU, or a collector that kept every worker busy."""
    sender = metrics["sender"]
    if sender["backpressure_s"] > 0:
        return f"the collector: every connection was busy for {sender['backpressure_s']} s"
    if sender["cpu_cores"] is not None and sender["cpu_cores"] >= SENDER_CPU_LIMIT:
        return f"the sender: the simulator used {sender['cpu_cores']} cores of the 1 one process can use"
    return "unknown: neither the sender's CPU nor collector backpressure explains it"


def asdict_reading(reading: Reading) -> dict:
    return {"lag": reading.lag, "volumes": reading.volumes, "errors": reading.errors,
            "dead_letters": reading.dead_letters, "parsed": reading.parsed, "accepted": reading.accepted}


def sample(at: float, phase: Phase | None, reading: Reading, interval: PhaseMeter, tail: Tail,
           options: LoadOptions) -> dict:
    """One interval's line of the timeline: its rates, errors, lag, latency, and volumes."""
    seconds = interval.wall_s or options.interval_s
    target = options.profile.events_by(at) - options.profile.events_by(at - seconds) if phase else 0.0
    return {
        "t_s": round(at, 1),
        "phase": phase.name if phase else "before",
        "target_eps": round(target / seconds, 1),
        "sent_eps": round(interval.events_sent / seconds, 1),
        "send_errors": interval.send_errors,
        "latency_p95_ms": interval.latency_ms.summary().get("p95"),
        "response_p95_ms": interval.response_ms.summary().get("p95"),
        "backpressure_s": round(interval.backpressure_s, 1),
        "cpu_cores": round(interval.cpu_s / interval.wall_s, 3) if interval.wall_s else None,
        **asdict_reading(reading),
        "tail_behind": tail.behind,
    }


def sample_line(entry: dict) -> str:
    volumes = " ".join(f"{name}={ratio:.0%}" if ratio is not None else f"{name}=?"
                       for name, ratio in entry["volumes"].items())
    lag = " ".join(f"{topic}={value if value is not None else '?'}" for topic, value in entry["lag"].items())
    return (f"t={entry['t_s']:.0f}s {entry['phase']} target={entry['target_eps']:.0f}eps sent={entry['sent_eps']:.0f}eps "
            f"errors={entry['send_errors']} latency_p95={entry['latency_p95_ms']}ms dead={entry['dead_letters']} "
            f"cpu={entry['cpu_cores']} lag[{lag}] volumes[{volumes}]")
