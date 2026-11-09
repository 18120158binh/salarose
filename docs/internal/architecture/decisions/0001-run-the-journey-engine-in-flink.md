---
title: Run the journey engine in Flink, not in Postgres triggers
id: "0001"
status: accepted
date: 2026-08-06
tags: [journey-execution, postgres, flink, state]
supersedes: []
superseded_by: []
---

# 0001. Run the journey engine in Flink, not in Postgres triggers

## Context

The first design was a hybrid. Flink matched events against journey nodes and inserted each match into a Postgres table, `user_events_log`. An `AFTER INSERT` trigger on that table, `evaluate_state_transitions`, was the state machine. For every inserted row it ran four phases:

1. **Build the context.** Merge the event's identity fields into its JSON context, so that message templates could render without another query.
2. **Evaluate the node.** For a segment node, run a stored behavioral query. For a node with an aggregation, run `COUNT(*)` or `SUM(...)` over `user_events_log` for the user, node, and time window.
3. **Record the transition.** Insert into `user_campaign_state_transitions` with `ON CONFLICT DO NOTHING` on a five-part key: `domain_userid`, `network_userid`, `campaign_id`, `node_id`, and `branch`. The constraint made repeated matches harmless.
4. **Cascade.** Walk the campaign graph breadth first, with an array as the queue, so the trigger could not overflow the stack. For each child node, look back in `user_events_log` for a child event that had arrived before its parent, first by `domain_userid` and then by `network_userid` or `user_id`. A late parent then completed its early children in the same transaction.

Two more ideas belonged to this design. Identity merges were to reach Postgres as a synthetic `__identity_merged__` event, and the trigger would rewrite the old identity in every state table. Watch timeouts were to come back as a `timeout` row in `user_events_log`, so that the trigger decided between the success path and the timeout path.

The trigger took a transaction-scoped advisory lock per user and campaign, `pg_advisory_xact_lock(hashtext(user_id || ':' || campaign_id))`, so that two transactions could not advance the same journey at once.

Benchmarks on the trigger were good at low load: a 100-row batch took 1.7 to 3.8 ms with a 99.9% buffer cache hit ratio, because the lookback queries were index-only scans. Aggregation was the exception. On a 4.3 GB `user_events_log`, the windowed `COUNT(*)` took up to 2.31 seconds per batch, and its cost grew with the table.

## Decision

Move the journey state machine into a keyed Flink job, `StateMachineJob`. Key the stream by journey: `canon_id` and `campaign_id`. Keep journey state, the buffer of early triggers, and completed nodes in Flink keyed state. Postgres receives the completed nodes as an append-only record in `user_campaign_state_transitions`, and runs no journey logic.

Commit `22356bbe` made the move. The trigger code stayed in `infra/db/state_machine.sql`, with nothing writing to its input table, until it was removed with that table. Git history keeps it.

## Why

**The trigger serialized every journey on one lock in one database.** Every matched event and every transition was a write to the primary, under an advisory lock. The architecture review in June 2026 named this the main bottleneck: at tens of thousands of events per second the locks contend and the primary's CPU spikes. A relational database is a poor high-throughput state machine.

**The lock deadlocked under parallel load.** With the matching job at parallelism above 1, two sink subtasks flushed batches that held the same users in a different order. Each took the lock for its first user and waited for the other's. Postgres aborted one transaction with `deadlock detected`, and Flink restarted the job in a loop. [Decision 0002](0002-key-every-write-by-its-owner.md) records the incident and the rule that came from it.

**The mitigations bought time but did not remove the limit.** The team tried:

- Hash partitioning `user_events_log` and `user_campaign_state_transitions` into 16 partitions by user, so that each trigger query touched one partition.
- Three Postgres instances, with identity and profile lookups sent to the two read replicas.
- Larger Flink caches: identity from 50,000 to 500,000 entries and profiles from 10,000 to 200,000.
- Larger JDBC batches: from 500 to 2000 rows, flushed every 2 seconds instead of every second.
- Postgres tuning: 64 MB WAL buffers, 2 GB shared buffers, aggressive autovacuum, and checkpoint tuning.

Each of these raised the ceiling. None of them removed the single lock path, and each transition still cost a write and a WAL record that CDC had to stream back to Flink. A loaded database delayed CDC, and a delayed CDC stream delayed every notification.

**Keying by journey gives the same guarantee without a lock.** When one Flink subtask owns each journey, two updates to one journey cannot run at once, so no lock is needed. State lives in RocksDB on the task managers and grows with the cluster, not with one database.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Keep the trigger and partition Postgres further | Partitioning spreads I/O, but every transition is still a locked write on the primary. It was tried, and it did not remove the deadlock or the CDC lag. |
| Recursive CTE instead of the BFS trigger | An earlier version used `WITH RECURSIVE`. The explicit BFS replaced it to control depth and branch order. Both run in the same locked transaction. |
| A lock-free, append-only Postgres design, with CDC to stream completed states back to Flink | Removes the advisory lock, but leaves sequence matching in SQL and every match as a database write. |
| Flink Stateful Functions | More machinery than a keyed process function needs for one state machine. |
| Redis for profile lookups | Saves query time but adds a network hop and a second store to keep consistent. |
| Cassandra or ScyllaDB for the event log | Handles the write rate, but journey state would have to be recomputed from the log. |

## Consequences

- One subtask owns each journey, so the engine needs no locks. Any new stateful write must keep that property. See [decision 0002](0002-key-every-write-by-its-owner.md).
- Journey state lives in Flink for 90 days. A job started without a savepoint loses it.
- An early child trigger waits in a buffer for its parent. The trigger's lookback query does the same job in the new design.
- Identity merges no longer rewrite journey state. The `__identity_merged__` event was never built in the Flink engine. See [identity stitching](../components/identity/identity-stitching.md).
- Watch timeouts come from Flink timers and go to the same Kafka topic as other triggers.
- Windowed metrics moved to Flink too. See [decision 0004](0004-compute-metrics-and-decisions-in-one-keyed-job.md).

## Related

- [Journey execution](../components/journey-execution.md)
- [0002. Key every stateful write by its owner](0002-key-every-write-by-its-owner.md)
- [0004. Compute metrics and decisions in one keyed job](0004-compute-metrics-and-decisions-in-one-keyed-job.md)
