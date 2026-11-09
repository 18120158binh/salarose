---
title: At-least-once delivery with idempotent writes
id: "0006"
status: accepted
date: 2026-08-21
tags: [flink, kafka, postgres, delivery]
supersedes: []
superseded_by: []
---

# 0006. At-least-once delivery with idempotent writes

## Context

After a failure, Flink restores the last checkpoint and replays the records after it. A CDC source whose slot was dropped re-reads a snapshot of its table. Every sink therefore sees some records twice.

The August 2026 customer decision plan proposed one exactly-once Kafka sink, so that the metric mutation and the journey trigger for an event would commit in one transaction.

## Decision

Every sink is at-least-once. Every write is idempotent: writing a record twice leaves the same state as writing it once. Downstream consumers deduplicate on a natural id.

The exactly-once sink from the plan was not built. The reason is not recorded.

## Why

At-least-once with idempotent writes is correct whatever the cause of the repeat: a checkpoint replay, a CDC snapshot, or a producer retry. Exactly-once Kafka covers only the first, and only between Flink and Kafka. It does not cover Postgres sinks or the consumers of the notification topic.

## Rules that follow

- Write rows with an upsert keyed on a natural id, or with an insert that skips existing rows.
- Never generate a random id inside a sink path. A replay would write a second row.
- Keep in Flink state what a job has already done: the event ids it has counted, and the nodes it has completed.
- Give every outbound message an id that a consumer can deduplicate on.
- Treat CDC snapshot rows as possibly seen before.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Exactly-once Kafka sinks | Proposed and not built. Would not cover Postgres sinks or external consumers. |

## Consequences

- Consumers see duplicates and must tolerate them.
- A sink that breaks the rules above fails only on replay, which is rare and hard to test. Review sink code for random ids and plain inserts.

## Related

- [0002. Key every stateful write by its owner](0002-key-every-write-by-its-owner.md)
- [0005. Keep live state in Flink and a durable copy in Postgres](0005-keep-live-state-in-flink.md)
