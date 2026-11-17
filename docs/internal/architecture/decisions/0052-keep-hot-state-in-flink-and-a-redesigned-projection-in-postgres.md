---
title: Keep hot state in Flink and a redesigned projection in Postgres, with no new database
id: "0052"
status: accepted
date: 2026-11-17
tags: [storage, postgres, flink, state, wal, cdc]
supersedes: []
superseded_by: []
---

# 0052. Keep hot state in Flink and a redesigned projection in Postgres, with no new database

## Context

The platform must carry 100 million to 500 million events a month. That is about 38 to 190 events a second on average, with peaks of 5 to 10 times that. [Platform capacity](../capacity.md) already sets 500 events a second sustained and 2,000 for 10 minutes, which covers the average and most of the peak.

Postgres does two jobs today. It holds the configuration that `studio` writes and the jobs read through CDC: `campaigns`, `campaign_nodes`, `segments`, `user_metric_definitions`, the event catalog, staff, and drafts. It also holds the projection of the per-person state that the Flink jobs keep: `identity_graph`, `user_metrics`, and `user_campaign_state_transitions` ([decision 0005](0005-keep-live-state-in-flink.md)). The second job writes most of the WAL. On 2026-11-07, 3,000 events a second wrote about 6 MB/s of WAL, mostly to those three tables, and every replication slot was invalidated ([decision 0039](0039-shorten-the-cdc-restore-window.md)).

Decision 0039 named a second step, moving the busy tables to a second Postgres cluster. [Decision 0040](0040-import-through-a-batch-path-and-a-separate-store.md) added another Postgres cluster for imported records. The owner reviewed the storage design as a whole on 2026-11-17.

## Decision

Hot storage has two tiers, and both stay on technology the platform already runs. No MongoDB, no third database.

**Tier 1 is Flink keyed state, on RocksDB.** It serves every read on the decision path. While the jobs run, it is the source of truth for metrics, identity, segment flags, and journey progress. [Decision 0054](0054-recover-flink-state-in-four-layers.md) says how it survives loss.

**Tier 2 is Postgres, redesigned as a projection.** Postgres keeps the configuration role unchanged and stays the CDC source for the jobs. The projection changes in five ways:

| Part | Today | Target |
|---|---|---|
| Metrics, `user_metrics` | One upsert per changed series per event | Coalesced per person: each row written at most once per coalescing window, such as once per checkpoint. Narrow rows that write only the changed buckets are an option, not a decision. |
| Journey progress, `user_campaign_state_transitions` | One table that grows forever | Partitioned by event time. Only recent partitions stay in Postgres. Older ones move to the lakehouse ([decision 0053](0053-store-raw-events-transition-history-and-imports-in-an-iceberg-lakehouse.md)). |
| Notification outbox CDC | Publication `outbox_transitions_pub` on the transitions table | The outbox keeps its own publication, and it covers only the transitions table. Moving a partition out publishes no change to it. |
| Identity graph, `identity_graph` | Device to person rows | Unchanged. |
| Profile read model | None. `studio` assembles a person from several tables | One row per person in a `jsonb` read model, written by the profile writer. |

The coalescing window and the Postgres retention of transitions are open. The owner left both undecided on 2026-11-17. The contracts list them under "Open questions".

This decision replaces the second step of decision 0039. The busy tables stay in the main Postgres, and their WAL falls because they write less, not because they move. It amends [decision 0005](0005-keep-live-state-in-flink.md). Flink state is the source of truth, and the Postgres copy is a projection that may lag by one coalescing window.

## Why

**The decision path already avoids Postgres.** Every decision reads Flink state. Postgres is read only on a state miss (decision 0005). A faster or larger database would not speed a decision. It would only hold the projection, and the projection's cost is its write rate, not its read rate.

**The WAL comes from the write pattern, not from Postgres.** The three tables wrote about 2 KB of WAL per event in the run of 2026-11-07 (decision 0039, measured over the whole database). `user_metrics` rewrites a person's whole series on every event that changes it, and with full replica identity it also logs the old row ([PLT-KI-18](../../known-issues/platform.md#plt-ki-18-user_metrics-has-full-replica-identity-but-no-publication-covers-it)). A person who sends 20 events in a 30-second window writes their series 20 times. Coalesced, they write it once. The transitions table carries four indexes for analytics ([decision 0035](0035-compute-journey-analytics-from-transitions-on-read.md)) and never shrinks. Both are fixable in place. [Platform capacity](../capacity.md#coalesced-writes) gives the formulas.

**A second cluster for the busy tables moves the WAL but does not reduce it.** The busy tables need CDC, at least for the outbox, so a second cluster needs its own slots, its own cap on slot WAL, and its own disk. It doubles the Postgres operations work and leaves every write as large as it was.

**Moving transitions alone to Kafka leaves Postgres in place.** A transitions topic could feed the outbox without CDC. But metrics and identity would still be projected to Postgres, and configuration CDC would still run. The platform would carry the same database plus a new delivery path, for one of three busy tables.

**The alternatives add a database to run and keep the hard parts.** The platform must still read configuration through CDC from Postgres, so any other store is in addition to Postgres, not instead of it. Each needs its own backup, monitoring, deployment, and on-call knowledge, on a team that runs one Postgres today.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| MongoDB for the per-person projection | A third database to run beside Postgres and Kafka. Its change streams would replace CDC for one table only. A document per person still rewrites per event unless writes are coalesced, which Postgres can do as well. |
| DynamoDB for the per-person projection | Managed, but a second store with its own consistency model and cost per write unit. Per-event writes cost per event, so it needs coalescing too. Configuration CDC stays on Postgres. |
| ScyllaDB or Cassandra for the projection | High write throughput the platform does not need at 190 events a second on average. A cluster to operate, and no transactions for the configuration tables, which stay on Postgres anyway. |
| A second Postgres cluster for the busy tables, decision 0039's second step | Moves the WAL to a second set of slots and disks without reducing it. Twice the operations. |
| Move transitions to Kafka only, and let the outbox read the topic | Leaves metrics and identity on Postgres anyway. Removes one CDC slot but adds a delivery path with its own replay rules. Analytics still need the history somewhere. |
| Keep the projection as it is and raise the caps | Raising a cap to fit WAL nobody needs repeats the incident of 2026-11-07 at a larger number ([CAP-FR-11](../capacity.md#functional-requirements)). |

## Consequences

- The [profile writer](../components/profile-writer.md) coalesces metric writes per person and writes the profile read model. Its rows lag the live state by up to one coalescing window.
- [Journey execution](../components/journey-execution.md) writes transitions into time partitions keyed by the transition's event time, so a replay lands in the same partition and writes nothing new.
- The [notification outbox](../components/notification-outbox.md) reads its own publication. A start without its saved position reads only the partitions still in Postgres.
- [Platform capacity](../capacity.md) sizes `user_metrics` by distinct rows per window, not by events.
- A state miss after a fresh start reads values up to one coalescing window old. [Decision 0054](0054-recover-flink-state-in-four-layers.md) accepts that loss for layer 3 and gives the exact path, a rebuild from raw events.
- [PLT-KI-16](../../known-issues/platform.md#plt-ki-16-the-event-path-tables-share-the-database-whose-wal-every-cdc-slot-holds) is fixed by writing less WAL, not by moving tables.
- Decision 0039's caps and restore window stay. The sizing in [platform capacity](../capacity.md) checks them again once coalescing is measured.

## Related

- [0005. Keep live state in Flink and a durable copy in Postgres](0005-keep-live-state-in-flink.md), amended
- [0039. Shorten the CDC restore window](0039-shorten-the-cdc-restore-window.md), its second step replaced
- [0053. Store raw events, transition history, and imports in an Iceberg lakehouse](0053-store-raw-events-transition-history-and-imports-in-an-iceberg-lakehouse.md)
- [0054. Recover Flink state in four layers](0054-recover-flink-state-in-four-layers.md)
- [Platform capacity](../capacity.md)
- [Profile writer](../components/profile-writer.md), [journey execution](../components/journey-execution.md), [notification outbox](../components/notification-outbox.md)
