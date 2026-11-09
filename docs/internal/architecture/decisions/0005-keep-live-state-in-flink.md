---
title: Keep live state in Flink and a durable copy in Postgres
id: "0005"
status: accepted
date: 2026-08-07
tags: [flink, postgres, state, metrics, identity]
supersedes: []
superseded_by: []
---

# 0005. Keep live state in Flink and a durable copy in Postgres

## Context

Three kinds of per-person state drive decisions: the identity graph, the metric history, and journey progress. Each must be read on every event, fast. Each must also survive state expiry, and people want to query it with SQL.

## Decision

Keep the live copy in Flink keyed state, on RocksDB with a TTL. Publish each change, and let a separate writer project it into Postgres. A job reads Postgres only when its keyed state has no entry for a key, and then merges its own state over what it reads, so current values win.

| State | Live copy | Durable copy | Written by |
|---|---|---|---|
| Identity graph | `EventParseJob` state, 7 days | `identity_graph` | `EventParseJob`, on each event |
| Metric history | `CustomerDecisionJob` state, 31 days | `user_metrics` | `CustomerProfileWriterJob`, from `customer-profile-mutations` |
| Journey progress | `StateMachineJob` state, 90 days | `user_campaign_state_transitions` | `StateMachineJob`. Never read back. |

## Why

The decision path must not wait on Postgres. If the decision job read metrics from Postgres, it would have to wait for the writer to store the current event, which is the race that [decision 0004](0004-compute-metrics-and-decisions-in-one-keyed-job.md) removes.

The durable copy still matters. Keyed state expires, a job can start without a savepoint, and analysts query the tables. A copy that lags by seconds serves all three.

A replayed or delayed message must not overwrite a newer row. The writer guards each upsert with an ordering value carried in the message.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Postgres as the only copy | Puts a database read, and a race with the writer, on every decision. |
| Flink state as the only copy | State is lost when it expires or when a job starts fresh, and nobody can query it. |
| An exactly-once sink for the projection | The July 2026 plan proposed one Kafka transaction for the mutation and the trigger. The code uses at-least-once with idempotent upserts. See [decision 0006](0006-at-least-once-delivery-with-idempotent-writes.md). |

## Consequences

- Postgres rows lag the live state. Code on the decision path must not read them except on a state miss.
- The schema and the writer must agree on the ordering column. When they disagree, every write fails. See the [profile writer known issues](../../known-issues/components/profile-writer.md).
- Journey state is never reloaded from Postgres. A fresh start of the state machine forgets every journey in progress.

## Related

- [Identity stitching](../components/identity/identity-stitching.md)
- [Customer decision](../components/customer-decision.md)
- [Profile writer](../components/profile-writer.md)
- [Journey execution](../components/journey-execution.md)
