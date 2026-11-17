---
title: Recover Flink state in four layers
id: "0054"
status: accepted
date: 2026-11-17
tags: [flink, state, recovery, savepoints, lakehouse]
supersedes: []
superseded_by: []
---

# 0054. Recover Flink state in four layers

## Context

[Decision 0052](0052-keep-hot-state-in-flink-and-a-redesigned-projection-in-postgres.md) makes Flink keyed state the source of truth for metrics, identity, segment flags, and journey progress while the jobs run. Postgres holds a projection that may lag by one coalescing window. So losing Flink state is losing data, and the platform needs a stated way back from each kind of loss.

Today the jobs checkpoint to S3 and upgrade through savepoints, but nothing in the manifests sets checkpoint retention or schedules savepoints, the savepoint bucket keeps no versions, and the CI restore check covers one job (read from the manifests and the CI workflow at `a29730c`, listed in the [state recovery known issues](../../known-issues/components/state-recovery.md)). Past Kafka's 72 hours of retention, no copy of the raw events remains to rebuild from.

## Decision

Flink state must not be easy to lose and must be recoverable, in four layers. Each layer covers the losses the one above it cannot.

| Layer | What it is | Covers | Loses |
|---|---|---|---|
| 1. Checkpoints | Checkpoints on S3, retained when a job is cancelled | A crash, a restart, a node loss | Nothing past the last completed checkpoint. The sources replay the rest. |
| 2. Savepoints | Scheduled savepoints, daily and before every deploy, kept N days on versioned S3. Every operator has a fixed id. CI restores a real savepoint. | A deploy that breaks state, a bad upgrade, a deleted checkpoint | The changes after the savepoint that the sources can no longer replay |
| 3. Postgres projection | The tier-2 copy of metrics and identity, read on a state miss | A start without saved state, for the state that has a projection | Up to one coalescing window of metric changes. Journey progress, which is never read back. |
| 4. Replay from raw events | A batch run of the jobs over the raw events in the lakehouse, which rebuilds state from scratch and ends with a new savepoint | Every loss, including the loss of every savepoint | Nothing. It is exact, but slow. |

The order of trust is raw events in the lakehouse, then Flink state, then the Postgres projection. When two disagree, the higher one wins, and a rebuild from a higher layer replaces a lower one.

N, the days a savepoint is kept, is open. The owner left it undecided on 2026-11-17.

## Why

**Each layer fails in a different way.** A checkpoint survives a crash but not a deploy that changes the state layout. A savepoint survives a bad deploy but not a lost bucket or a savepoint taken after a bug wrote bad state. The projection survives both for metrics and identity, but it lags and it holds no journey progress. Only the raw events survive everything, because they hold the inputs, not a derived copy.

**Retained checkpoints and fixed ids are cheap.** A checkpoint deleted on cancel leaves the next start with nothing. An operator without a fixed id gets a generated one that changes when the job graph changes, and its state cannot be matched in a savepoint. Both are configuration, not code.

**A restore test that runs is the only proof.** A savepoint that no job has restored is a file, not a backup. CI already restores event parse's production savepoint with the new build on every change to the jobs. Every job with keyed state needs the same check.

**Versioned storage protects against the operator.** A savepoint deleted by a cleanup script or overwritten by a misconfigured path is gone unless the bucket keeps versions.

**The projection is a fallback, not a backup.** Decision 0005 already reads Postgres on a state miss and merges its own state over it. That stays. With coalesced writes, the projection is behind by at most one window, and decision 0052 accepts that. Journey progress is never read back from Postgres (decision 0005), so layer 3 does not cover it, and layers 2 and 4 must.

**A rebuild from raw events is the exact answer.** The jobs are deterministic over their inputs. Metrics use event time ([decision 0028](0028-store-metrics-as-tiered-time-buckets.md)), and every sink converges on replay ([decision 0006](0006-at-least-once-delivery-with-idempotent-writes.md)). Running them over the raw events reproduces the state. A batch run over months of events is slow, so it is the last resort, and it ends with a savepoint so that the streaming jobs start from it.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Checkpoints only, as today | A deploy that breaks state, or a cancelled job, leaves nothing to restore. |
| Rebuild from the Postgres projection | The projection lags by a window, holds no journey progress, and is a lower layer of trust than the state it would rebuild. |
| Keep raw events in Kafka for months and replay from Kafka | Broker disk at that size is expensive, and Kafka shares a disk with Postgres today ([PLT-KI-20](../../known-issues/platform.md#plt-ki-20-the-6-gib-kafka-volume-cannot-hold-72-hours-of-snowplow-good-at-the-target-load)). The lakehouse holds the same records on S3. |
| Savepoints on every checkpoint | Savepoints are full copies and slow. Retained incremental checkpoints cover the short horizon. |

## Consequences

- A new contract, [state recovery](../components/state-recovery.md), holds the requirements of all four layers.
- The [lakehouse sink](../components/lakehouse.md) keeps raw events long enough to rebuild the longest-lived state. The exact retention follows from the state TTLs and is open there.
- A rebuild needs the jobs to run in batch over a bounded input. Code that reads wall-clock time on the decision path, such as processing-time watch timers, needs a stated rule for the rebuild. The [state recovery](../components/state-recovery.md#open-questions) contract lists it as open.
- Savepoint storage is versioned. The bucket also holds the import drop zone, whose files must leave no noncurrent version after a rewrite ([data import](../../features/data-import.md#privacy), DIM-NFR-08). Savepoints therefore need a bucket or a lifecycle rule of their own.
- A deploy takes a savepoint first, and a failed savepoint stops the deploy.

## Related

- [0005. Keep live state in Flink and a durable copy in Postgres](0005-keep-live-state-in-flink.md)
- [0006. At-least-once delivery with idempotent writes](0006-at-least-once-delivery-with-idempotent-writes.md)
- [0039. Shorten the CDC restore window](0039-shorten-the-cdc-restore-window.md): a savepoint restore past the CDC restore window skips CDC changes
- [0052. Keep hot state in Flink and a redesigned projection in Postgres](0052-keep-hot-state-in-flink-and-a-redesigned-projection-in-postgres.md)
- [0053. Store raw events, transition history, and imports in an Iceberg lakehouse](0053-store-raw-events-transition-history-and-imports-in-an-iceberg-lakehouse.md)
- [State recovery](../components/state-recovery.md)
