"""What a load run reads from the deployment while it sends: its own events downstream, consumer lag, volume use.

None of it moves a pipeline offset. The run tail assigns partitions by hand and never commits. Lag reads the
pipeline groups' committed offsets, which Flink commits on each checkpoint, so lag is current to the last checkpoint.
"""

from __future__ import annotations

import json
import re
import threading
import time
import urllib.parse
import urllib.request
from collections.abc import Callable

from kafka import KafkaAdminClient, KafkaConsumer, TopicPartition

from cdp_sim.db import Database
from cdp_sim.load import Meter, Parts, Reading
from cdp_sim.sender import KeepAliveCollector
from cdp_sim.settings import Settings

PARSED, DEAD_LETTERS = "snowplow-parsed", "snowplow-parsed-dead-letters"
# The consumer group of the job that reads each topic: the jobs' defaults, which the deployment does not override.
LAG_GROUPS = {
    "snowplow-good": "event-processor-group",
    PARSED: "customer-decision-events",
    "customer-profile-mutations": "customer-profile-writer",
    "journey-engine-matched-events": "campaign-state-machine-group",
}
EVENT_ID = re.compile(rb'"event_id"\s*:\s*"([^"]+)"')
# How often the tail measures how far its own reads are behind the topics' ends.
TAIL_BEHIND_EVERY_S = 5.0
# How long any Kafka request of a load run waits for the broker. kafka-python's defaults, 305 s for a consumer and 30 s
# for the admin client, would let one reading outlast many stop-guard intervals.
REQUEST_TIMEOUT_MS = 10_000


class RunCount:
    """Counts the run's records on snowplow-parsed and the dead letters, and times sampled events to snowplow-parsed.

    A record is the run's when its bytes hold the run id, which every event carries in its data and its run entity.
    `latency(sent_at, ms)` gets each sampled event's send time and its delay to the moment the tail read it, so the
    delay includes how far the tail itself is behind.
    """

    def __init__(self, run_id: str, latency: Callable[[float, float], None], now: Callable[[], float]) -> None:
        self._run = run_id.encode()
        self._latency = latency
        self._now = now
        self._sampled: dict[bytes, float] = {}
        self._lock = threading.Lock()
        self.counts = {PARSED: 0, DEAD_LETTERS: 0}

    def sent_at(self, event_id: str, at: float) -> None:
        with self._lock:
            self._sampled[event_id.encode()] = at

    def count(self, topic: str, value: bytes | None) -> None:
        if not value or self._run not in value:
            return
        self.counts[topic] += 1
        if topic == PARSED and (match := EVENT_ID.search(value)):
            with self._lock:
                sent = self._sampled.pop(match.group(1), None)
            if sent is not None:
                self._latency(sent, (self._now() - sent) * 1000)


class RunTail:
    """Reads snowplow-parsed and the dead letters from their end offsets into a RunCount, on its own thread.

    `behind` is how many records the tail's reads are behind the topics' ends, measured every few seconds.
    """

    def __init__(self, brokers: str, run_id: str, group_id: str, latency: Callable[[float, float], None],
                 now: Callable[[], float]) -> None:
        self._run_count = RunCount(run_id, latency, now)
        self.counts = self._run_count.counts
        self.sent_at = self._run_count.sent_at
        self.behind: int | None = None
        self.error: str | None = None
        self._stop = threading.Event()
        self._consumer = KafkaConsumer(
            bootstrap_servers=brokers, group_id=group_id, client_id=group_id, enable_auto_commit=False,
            auto_offset_reset="latest", request_timeout_ms=REQUEST_TIMEOUT_MS,
            # kafka-python requires a request timeout above the session timeout. The tail never joins its group.
            session_timeout_ms=REQUEST_TIMEOUT_MS // 2,
            heartbeat_interval_ms=REQUEST_TIMEOUT_MS // 10,
        )
        self._partitions = []
        for topic in (PARSED, DEAD_LETTERS):
            partitions = self._consumer.partitions_for_topic(topic)
            if not partitions:
                raise RuntimeError(f"topic {topic} not found")
            self._partitions += [TopicPartition(topic, partition) for partition in sorted(partitions)]
        self._consumer.assign(self._partitions)
        for partition, offset in self._consumer.end_offsets(self._partitions).items():
            self._consumer.seek(partition, offset)
        self._thread = threading.Thread(target=self._read, daemon=True, name="sim-tail")

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=3 * REQUEST_TIMEOUT_MS / 1000)
        if not self._thread.is_alive():
            self._consumer.close(autocommit=False)

    def _read(self) -> None:
        next_behind = 0.0
        try:
            while not self._stop.is_set():
                for batch in self._consumer.poll(timeout_ms=500).values():
                    for message in batch:
                        self._run_count.count(message.topic, message.value)
                if time.monotonic() >= next_behind:
                    ends = self._consumer.end_offsets(self._partitions)
                    self.behind = sum(end - self._consumer.position(partition) for partition, end in ends.items())
                    next_behind = time.monotonic() + TAIL_BEHIND_EVERY_S
        except Exception as error:  # noqa: BLE001  The run reports a dead tail instead of crashing mid-send.
            self.error = f"{type(error).__name__}: {error}"


class LagProbe:
    """The lag of each pipeline group on its input topic: end offsets minus committed offsets, over all partitions."""

    def __init__(self, admin: KafkaAdminClient, consumer: KafkaConsumer) -> None:
        self._admin = admin
        self._consumer = consumer

    def offsets(self, topic: str, group: str) -> tuple[int, int] | None:
        """The group's committed offsets and the topic's end offsets, each summed over the partitions it committed.
        None when the group has committed nothing on the topic."""
        committed = {
            partition: meta.offset
            for partition, meta in self._admin.list_consumer_group_offsets(group).items()
            if partition.topic == topic and meta.offset >= 0
        }
        if not committed:
            return None
        ends = self._consumer.end_offsets(list(committed))
        return sum(committed.values()), sum(ends[partition] for partition in committed)

    def read(self) -> dict[str, int | None]:
        lag: dict[str, int | None] = {}
        for topic, group in LAG_GROUPS.items():
            try:
                offsets = self.offsets(topic, group)
                lag[topic] = offsets[1] - offsets[0] if offsets else None
            except Exception:  # noqa: BLE001  One unreadable group leaves its lag unknown, not the run broken.
                lag[topic] = None
        return lag


def prometheus_value(base_url: str, query: str, timeout_s: float = 10.0) -> float:
    """The largest value of an instant query's result. Raises when Prometheus fails or the result is empty."""
    url = f"{base_url.rstrip('/')}/api/v1/query?{urllib.parse.urlencode({'query': query})}"
    with urllib.request.urlopen(url, timeout=timeout_s) as response:
        body = json.load(response)
    results = body.get("data", {}).get("result", []) if body.get("status") == "success" else []
    values = [float(result["value"][1]) for result in results]
    if not values:
        raise RuntimeError(f"Prometheus returned no series for {query}")
    return max(values)


def postgres_bytes(db: Database) -> int:
    """The database's size plus the WAL its replication slots hold back. Both readable in a read-only session."""
    row = db.rows(
        "SELECT pg_database_size(current_database())"
        " + COALESCE((SELECT max(pg_current_wal_lsn() - restart_lsn) FROM pg_replication_slots"
        " WHERE restart_lsn IS NOT NULL), 0) AS bytes"
    )[0]
    return int(row["bytes"])


class Volumes:
    """How full the Kafka and Postgres volumes are, as ratios.

    Both volumes are local-path claims on the data node's root filesystem, which does not enforce a claim's size. So
    the node filesystem's use, from Prometheus, bounds both. Postgres also counts its own bytes against its claim's
    size, and takes the larger ratio. A reading that fails is None, with the error in `errors`.
    """

    def __init__(self, prometheus_url: str, volume_query: str, db: Database, pg_volume_bytes: int) -> None:
        self._prometheus_url = prometheus_url
        self._volume_query = volume_query
        self._db = db
        self._pg_volume_bytes = pg_volume_bytes

    def read(self) -> tuple[dict[str, float | None], dict[str, str]]:
        errors: dict[str, str] = {}
        node: float | None = None
        own: float | None = None
        try:
            node = prometheus_value(self._prometheus_url, self._volume_query)
        except Exception as error:  # noqa: BLE001  An unreadable volume is a reading the stop guard judges.
            errors["kafka"] = f"data node filesystem: {type(error).__name__}: {error}"
        try:
            own = postgres_bytes(self._db) / self._pg_volume_bytes
        except Exception as error:  # noqa: BLE001
            errors["postgres"] = f"Postgres size: {type(error).__name__}: {error}"
        readings = [ratio for ratio in (node, own) if ratio is not None]
        return {"kafka": node, "postgres": max(readings) if readings else None}, errors


def deployment_parts(settings: Settings, db: Database, run_id: str) -> Parts:
    """The load run's connections to the deployment: the collector, the run tail, lag, and volumes."""
    client_id = f"sim-{run_id}-lag"
    lag = LagProbe(
        KafkaAdminClient(bootstrap_servers=settings.kafka_brokers, client_id=client_id,
                         request_timeout_ms=REQUEST_TIMEOUT_MS),
        KafkaConsumer(bootstrap_servers=settings.kafka_brokers, client_id=client_id, enable_auto_commit=False,
                      request_timeout_ms=REQUEST_TIMEOUT_MS),
    )
    volumes = Volumes(settings.prometheus_url, settings.volume_query, db, settings.pg_volume_bytes)

    def tail(meter: Meter, now: Callable[[], float]) -> RunTail:
        return RunTail(settings.kafka_brokers, run_id, f"sim-{run_id}-load", meter.latency, now)

    def read(meter: Meter, run_tail: RunTail) -> Reading:
        ratios, errors = volumes.read()
        if run_tail.error:
            errors["dead_letters"] = f"the run tail stopped: {run_tail.error}"
        return Reading(lag=lag.read(), volumes=ratios, errors=errors,
                       dead_letters=None if run_tail.error else run_tail.counts[DEAD_LETTERS],
                       parsed=run_tail.counts[PARSED], accepted=meter.accepted)

    return Parts(connect=lambda: KeepAliveCollector(settings.collector_url), tail=tail, read=read)
