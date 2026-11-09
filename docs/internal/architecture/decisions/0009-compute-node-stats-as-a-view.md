---
title: Compute node stats as a view, not a trigger-maintained table
id: "0009"
status: accepted
date: 2026-10-18
tags: [postgres, journeys, concurrency, studio]
supersedes: []
superseded_by: []
---

# 0009. Compute node stats as a view, not a trigger-maintained table

## Context

The journey builder shows how many people completed each node. It reads `campaign_node_stats` by `campaign_id` and takes `node_id` and `user_count` from each row, every 5 seconds while a campaign is open.

`campaign_node_stats` was a table of counters. A statement trigger on `user_campaign_state_transitions` added the rows of each insert to it, with an upsert per (`campaign_id`, `node_id`). That design had two faults:

- The trigger skipped rows on the `no` branch, so a node that completed on `no` was never counted. JEX-FR-11 says every branch counts.
- Every journey on a node shares that node's counter row. The state machine's sink is keyed by journey and sends up to 100 inserts per batch, so each subtask held row locks on several shared counters until its batch ended. Two subtasks that touch the same nodes in a different order can deadlock. JEX-NFR-07 says the engine takes no database locks, and [decision 0002](0002-key-every-write-by-its-owner.md) records the same deadlock from an earlier trigger.

## Decision

`campaign_node_stats` is a view over `user_campaign_state_transitions`. It keeps the table's name and columns. For each `campaign_id` and `node_id`, `user_count` is the number of distinct `canon_id` values, that is, the journey instances that completed the node on any branch. An index on `user_campaign_state_transitions` (`campaign_id`, `node_id`, `canon_id`) serves the builder's read.

## Why

The transition table already holds one row per completed node per journey instance, and the sink writes it idempotently. A count derived from it on read is exact by construction. It cannot miss a branch, and it cannot drift from the transitions after a manual fix. Writing a transition now touches only rows its journey owns, so the sink takes no lock that another subtask needs.

The builder's read stays the same SQL against the same name and columns, so `studio` needs no change and no deploy order.

The cost moves to the read. Postgres pushes the builder's `campaign_id` filter into the view, and the index lets it count from the index alone, so one read scans one index entry per transition of that campaign. The old table read one row per node. A campaign with a few hundred thousand transitions should still answer well within the 5 second poll. This is inferred from how Postgres plans a grouped view, not measured. Millions of transitions per campaign, or many builders open at once, would need one of the alternatives below.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Fix the trigger's branch filter and keep the table | Fixes the count but keeps the shared row locks of JEX-NFR-07. |
| Sort each batch by node before the flush, or retry on deadlock | [Decision 0002](0002-key-every-write-by-its-owner.md) rejected both: batches still interleave across flushes, and a retry turns a deadlock into repeated aborts. |
| A materialized view refreshed on a schedule | Counts lag by the refresh interval, and a refresh rescans every transition of every campaign. Worth it only when the view's read cost shows up. |
| Count in a Flink job keyed by (`campaign_id`, `node_id`) and upsert the counts | One writer per counter row removes the locks, but it adds a job, state, and replay logic to keep counts that the transitions already imply. |

## Consequences

- A transition insert fires no trigger. A new trigger or rule on `user_campaign_state_transitions` that writes shared rows needs a decision of its own.
- Counts follow `node_id`. When a node's id changes, as an End node's id did on every save before [stable End node ids](../../operations/deployment.md#stable-end-node-ids), the new id counts from zero and the old id keeps its count in the view. The builder shows only the ids of the current nodes.
- The view cannot be written. Cleanup that deleted stale counter rows has nothing to delete. A count disappears only when its transitions are deleted.
- `schema.sql` drops a leftover `campaign_node_stats` table and its trigger function. The view goes with the transition table when `schema.sql` drops that table.
- If the builder's read becomes slow, measure it with `EXPLAIN (ANALYZE, BUFFERS)` before choosing between the materialized view and the Flink counter.

## Related

- [Journey execution](../components/journey-execution.md)
- [Journey builder](../../features/journey-builder.md)
- [0001. Run the journey engine in Flink](0001-run-the-journey-engine-in-flink.md)
- [0002. Key every stateful write by its owner](0002-key-every-write-by-its-owner.md)
- [Upgrade note: node stats view](../../operations/deployment.md#node-stats-view)
- [0035. Compute journey analytics from the transitions on read](0035-compute-journey-analytics-from-transitions-on-read.md), which accepted this record on 2026-11-07
