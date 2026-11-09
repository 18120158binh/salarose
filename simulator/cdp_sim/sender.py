"""The load sender: shoppers from the scenario model, paced to a rate profile, over keep-alive connections.

A pacer releases whole visits until the run has released as many events as the profile's target by now. It packs the
visits into POST batches and sends a share of visits as GET pixels (SIM-FR-04). Workers send the hits, each over its
own connection. When every worker is busy the pacer's queue fills, and the pacer waits for a slot holding one hit:
it builds a hit only when it can queue it, so what it owes stays a count. That wait is the collector's backpressure,
and the report counts it, so a run that falls behind its target says whether the sender or the collector held it back.
Events still owed a second after the profile's end are the run's shortfall, not a backlog it sends late.
"""

from __future__ import annotations

import http.client
import queue
import random
import threading
import urllib.parse
from contextlib import closing
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Literal, Protocol

from cdp_sim.model import Shopper, TrackedEvent, browse, pick_persona
from cdp_sim.tracker import GET_PATH, POST_PATH, pixel_query, post_body

# Load shoppers start above the readiness probes' indexes (900 and 950 onward), so no device id repeats in a run.
FIRST_SHOPPER = 1000
# A hit still waiting for a free connection this long after the profile's end is dropped, so a slow collector does
# not stretch the run to send its backlog. A request over a second late fails its phase anyway.
LATE_S = 1.0


@dataclass(frozen=True)
class Hit:
    """One POST batch, or one visit sent as GET pixels in order.

    `phase` is the profile phase whose target the events belong to, and `due_at` the profile time they were due.
    `sampled` are the event ids timed to snowplow-parsed.
    """

    kind: Literal["POST", "GET"]
    events: tuple[TrackedEvent, ...]
    sampled: tuple[str, ...] = ()
    phase: int = 0
    due_at: float = 0.0


@dataclass(frozen=True)
class Sent:
    """The outcome of one request. `at` is the profile time it started; `delay_ms` how long after its due time."""

    at: float
    events: int
    status: int | None
    error: str | None
    elapsed_ms: float
    phase: int = 0
    delay_ms: float = 0.0

    @property
    def ok(self) -> bool:
        return self.status == 200

    @property
    def response(self) -> str:
        return str(self.status) if self.status is not None else (self.error or "error").split(":")[0]


class Profile(Protocol):
    duration_s: float

    def events_by(self, t: float) -> float: ...

    def starts(self) -> list[float]: ...


class Pacer:
    """Releases visits until `events_by(t)` events are out, one hit at a time as the sender asks for it.

    Visits stay whole, so a shopper's events keep their order. The events not yet released are owed: a count, not
    built hits, so a collector slower than the target grows a number, not memory. A hit holds the events of one
    phase, the one whose share of the target they fill. It is due when the profile owed its last event, so a late
    release measures its delay from when its events were due.
    """

    def __init__(
        self, run_id: str, profile: Profile, rng: random.Random, batch: int, pixel_share: float, sample_every: int,
        first_shopper: int = FIRST_SHOPPER,
    ) -> None:
        self._run_id = run_id
        self._profile = profile
        self._rng = rng
        self._batch = batch
        self._pixel_share = pixel_share
        self._sample_every = sample_every
        self._first_shopper = first_shopper
        self._starts = profile.starts() + [profile.duration_s]
        self._ends = [profile.events_by(end) for end in self._starts[1:]]
        self.released = 0
        self.shoppers = 0

    @property
    def duration_s(self) -> float:
        return self._profile.duration_s

    def owed(self, t: float) -> float:
        return max(0.0, self._profile.events_by(t) - self.released)

    def due(self, t: float) -> Iterator[Hit]:
        """The hits owed by profile time t, each built only when asked for. Visits in a batch the caller stops before
        it is sent go back to being owed."""
        target = self._profile.events_by(t)
        batch: list[TrackedEvent] = []
        phase = 0
        try:
            while self.released < target:
                visit_phase = self._phase_of(self.released)
                if batch and visit_phase != phase:
                    hit, batch = self._hit("POST", batch, phase), []
                    yield hit
                phase = visit_phase
                shopper = Shopper(self._run_id, self._first_shopper + self.shoppers, pick_persona(self._rng))
                self.shoppers += 1
                visit = browse(shopper, self._rng)
                self.released += len(visit)
                if self._rng.random() < self._pixel_share:
                    yield self._hit("GET", visit, phase)
                    continue
                batch.extend(visit)
                if len(batch) >= self._batch:
                    hit, batch = self._hit("POST", batch, phase), []
                    yield hit
            if batch:
                hit, batch = self._hit("POST", batch, phase), []
                yield hit
        finally:
            self.released -= len(batch)

    def _phase_of(self, event: int) -> int:
        """The phase whose share of the target holds event number `event`, counted from 0."""
        return next((index for index, end in enumerate(self._ends) if event < end), len(self._ends) - 1)

    def _due_time(self, events: int, phase: int) -> float:
        """The profile time by which `events` events were owed, within the phase."""
        low, high = self._starts[phase], self._starts[phase + 1]
        if self._profile.events_by(high) <= events:
            return high
        for _ in range(40):
            middle = (low + high) / 2
            low, high = (middle, high) if self._profile.events_by(middle) < events else (low, middle)
        return high

    def _hit(self, kind: Literal["POST", "GET"], events: list[TrackedEvent], phase: int) -> Hit:
        sampled = tuple(event.event_id for event in events if self._rng.randrange(self._sample_every) == 0)
        return Hit(kind, tuple(events), sampled, phase, self._due_time(self.released, phase))


class KeepAliveCollector:
    """One persistent HTTP connection to the collector, reopened after an error or a close."""

    def __init__(self, base_url: str, timeout_s: float = 10.0) -> None:
        url = urllib.parse.urlsplit(base_url)
        self._connection_type = http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection
        self._host, self._port = url.hostname, url.port
        self._prefix = url.path.rstrip("/")
        self._timeout_s = timeout_s
        self._connection: http.client.HTTPConnection | None = None

    def post(self, events: tuple[TrackedEvent, ...]) -> tuple[int | None, str | None]:
        headers = {"Content-Type": "application/json; charset=UTF-8"}
        return self._request("POST", POST_PATH, post_body(events), headers)

    def pixel(self, event: TrackedEvent) -> tuple[int | None, str | None]:
        return self._request("GET", f"{GET_PATH}?{pixel_query(event)}", None, {})

    def _request(self, method: str, path: str, body: bytes | None, headers: dict) -> tuple[int | None, str | None]:
        try:
            if self._connection is None:
                self._connection = self._connection_type(self._host, self._port, timeout=self._timeout_s)
            self._connection.request(method, self._prefix + path, body=body, headers=headers)
            response = self._connection.getresponse()
            response.read()
            if response.will_close:
                self.close()
            return response.status, None if response.status == 200 else f"HTTP {response.status}"
        except (http.client.HTTPException, OSError) as error:
            self.close()
            return None, f"{type(error).__name__}: {error}"

    def close(self) -> None:
        if self._connection is not None:
            self._connection.close()
            self._connection = None


class Client(Protocol):
    def post(self, events: tuple[TrackedEvent, ...]) -> tuple[int | None, str | None]: ...

    def pixel(self, event: TrackedEvent) -> tuple[int | None, str | None]: ...

    def close(self) -> None: ...


def deliver(
    client: Client, hit: Hit, now: Callable[[], float], sent_at: Callable[[str, float], None]
) -> Iterator[Sent]:
    """Sends one hit. A POST is one request; a GET visit is one pixel per event, in order.

    `sent_at` gets each sampled event's id and the start of the request that carries it.
    """
    requests = [(hit.events, lambda: client.post(hit.events))] if hit.kind == "POST" else [
        ((event,), lambda event=event: client.pixel(event)) for event in hit.events
    ]
    for events, send in requests:
        at = now()
        for event in events:
            if event.event_id in hit.sampled:
                sent_at(event.event_id, at)
        status, error = send()
        yield Sent(at, len(events), status, error, (now() - at) * 1000, hit.phase, max(0.0, at - hit.due_at) * 1000)


class Sender:
    """The pacer thread and its workers. `now` is the profile's clock, 0 when sending starts.

    `record` gets every Sent, and `sent_at` the start time of each sampled event.
    """

    def __init__(
        self,
        pacer: Pacer,
        connect: Callable[[], Client],
        connections: int,
        record: Callable[[Sent], None],
        sent_at: Callable[[str, float], None],
        on_backpressure: Callable[[float, float], None],
        now: Callable[[], float],
        tick_s: float = 0.05,
    ) -> None:
        self._pacer = pacer
        self._connect = connect
        self._record = record
        self._sent_at = sent_at
        self._on_backpressure = on_backpressure
        self.now = now
        self._tick_s = tick_s
        self._hits: queue.Queue[Hit | None] = queue.Queue(maxsize=connections * 2)
        self._stop = threading.Event()
        self._threads = [threading.Thread(target=self._work, daemon=True, name=f"sim-send-{n}") for n in range(connections)]
        self._pace_thread = threading.Thread(target=self._pace, daemon=True, name="sim-pacer")

    def start(self) -> None:
        for thread in self._threads:
            thread.start()
        self._pace_thread.start()

    def abort(self) -> None:
        """Stops releasing hits. Hits still queued are dropped unsent."""
        self._stop.set()

    def join(self) -> None:
        self._pace_thread.join()
        for thread in self._threads:
            thread.join()

    @property
    def done(self) -> bool:
        return not self._pace_thread.is_alive()

    def _pace(self) -> None:
        try:
            while not self._stop.is_set():
                t = min(self.now(), self._pacer.duration_s)
                with closing(self._pacer.due(t)) as hits:
                    if not all(self._put(hit) for hit in hits):
                        return
                if t >= self._pacer.duration_s:
                    return
                self._stop.wait(self._tick_s)
        finally:
            for _ in self._threads:
                self._hits.put(None)

    def _put(self, hit: Hit) -> bool:
        """Queues the hit, waiting for a free slot. The wait is the collector's backpressure. False when the run
        stops, or the profile ended LATE_S ago, before a slot frees: the hit is dropped unsent."""
        try:
            self._hits.put_nowait(hit)
            return True
        except queue.Full:
            pass
        waited_from = self.now()
        try:
            while not self._stop.is_set() and self.now() < self._pacer.duration_s + LATE_S:
                try:
                    self._hits.put(hit, timeout=self._tick_s)
                    return True
                except queue.Full:
                    continue
            return False
        finally:
            self._on_backpressure(waited_from, self.now() - waited_from)

    def _work(self) -> None:
        client = self._connect()
        try:
            while (hit := self._hits.get()) is not None:
                if self._stop.is_set():
                    continue
                for sent in deliver(client, hit, self.now, self._sent_at):
                    self._record(sent)
        finally:
            client.close()
