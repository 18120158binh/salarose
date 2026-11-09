"""Reading pipeline topics without moving any pipeline offset."""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Hashable, Iterable
from dataclasses import dataclass

from kafka import KafkaConsumer, TopicPartition


@dataclass(frozen=True)
class Record:
    topic: str
    partition: int
    offset: int
    key: bytes | None
    value: bytes | None

    def json(self) -> dict | None:
        """The value as a JSON object, or None when it is not one. Topics are input from other jobs, so parse here."""
        try:
            value = json.loads(self.value) if self.value else None
        except ValueError:
            return None
        return value if isinstance(value, dict) else None

    def where(self) -> dict[str, object]:
        return {"topic": self.topic, "partition": self.partition, "offset": self.offset}


class TopicTail:
    """The messages of one topic that arrive after the tail opens.

    The group id is the run's own. The tail assigns partitions by hand and seeks to their end offsets, so it joins no
    pipeline group, and it never commits.
    """

    def __init__(self, brokers: str, topic: str, group_id: str) -> None:
        self.topic = topic
        self.records: list[Record] = []
        self._consumer = KafkaConsumer(
            bootstrap_servers=brokers,
            group_id=group_id,
            client_id=group_id,
            enable_auto_commit=False,
            auto_offset_reset="latest",
        )
        partitions = self._consumer.partitions_for_topic(topic)
        if not partitions:
            raise RuntimeError(f"topic {topic} not found")
        assigned = [TopicPartition(topic, partition) for partition in sorted(partitions)]
        self._consumer.assign(assigned)
        for partition, offset in self._consumer.end_offsets(assigned).items():
            self._consumer.seek(partition, offset)

    def poll(self, timeout_ms: int = 500) -> None:
        for batch in self._consumer.poll(timeout_ms=timeout_ms).values():
            self.records.extend(
                Record(message.topic, message.partition, message.offset, message.key, message.value) for message in batch
            )

    def collect(
        self, key_of: Callable[[Record], Hashable | None], wanted: Iterable[Hashable], deadline: float
    ) -> dict[Hashable, Record]:
        """The first record for each wanted key, polling until every key is found or the monotonic deadline passes."""
        wanted = set(wanted)
        found: dict[Hashable, Record] = {}
        scanned = 0
        while True:
            for record in self.records[scanned:]:
                key = key_of(record)
                if key in wanted and key not in found:
                    found[key] = record
            scanned = len(self.records)
            if wanted <= found.keys() or time.monotonic() >= deadline:
                return found
            self.poll()

    def all(self, key_of: Callable[[Record], Hashable | None]) -> dict[Hashable, list[Record]]:
        """Every record read so far, grouped by key. Records whose key is None are left out."""
        grouped: dict[Hashable, list[Record]] = {}
        for record in self.records:
            if (key := key_of(record)) is not None:
                grouped.setdefault(key, []).append(record)
        return grouped

    def read_until(self, deadline: float) -> None:
        while time.monotonic() < deadline:
            self.poll()

    def close(self) -> None:
        self._consumer.close(autocommit=False)
