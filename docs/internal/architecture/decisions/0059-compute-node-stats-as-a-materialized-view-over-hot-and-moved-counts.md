---
title: Compute node stats as a materialized view over the hot and moved counts
id: "0059"
status: accepted
date: 2026-11-18
tags: [postgres, journeys, studio, lakehouse, analytics]
supersedes: ["0009", "0053"]
superseded_by: []
---

# 0059. Compute node stats as a materialized view over the hot and moved counts

## Context

[Decision 0009](0009-compute-node-stats-as-a-view.md) made `campaign_node_stats` a view over `user_campaign_state_transitions`: for each `campaign_id` and `node_id`, the distinct entries that completed the node, counted when the view is read. The Journey tab reads it every 5 seconds ([JBD-FR-09](../../features/journey-builder.md#functional-requirements)).

[Decision 0052](0052-keep-hot-state-in-flink-and-a-redesigned-projection-in-postgres.md) partitions the table by entry start, and the lakehouse sink moves each partition to `transition_history` once its whole range is 90 days old ([JEX-NFR-12](../components/journey-execution.md#non-functional-requirements)). A view over the hot table then loses the moved partitions, and an all-time count must include them ([JEX-FR-23](../components/journey-execution.md#functional-requirements)). [Decision 0058](0058-read-recent-analytics-from-postgres-and-history-from-the-lakehouse.md) sends analytics to Athena for a range older than 90 days. For this view, that would be an Athena query every 5 seconds per open Journey tab. PR #173 left the question open, and until it was answered the view held every partition in Postgres ([JEX-FR-24](../components/journey-execution.md#functional-requirements)), so no partition could move.

## Decision

The owner chose, on 2026-11-18, after the review of PR #173, a Postgres materialized view that unifies and computes the counts. This record carries the lead's reading of that choice, which the contracts state:

- When a partition moves, the move writes its count per node to `campaign_node_moved_counts`, one row per (`campaign_id`, `node_id`) keyed by the partition, before it removes the partition ([LKH-FR-23](../components/lakehouse.md#functional-requirements)).
- `campaign_node_stats` becomes a materialized view. For each (`campaign_id`, `node_id`), it adds the distinct entries in the hot partitions to the sum of the moved counts ([JEX-FR-25](../components/journey-execution.md#functional-requirements)). It keeps its name and columns, and it reads no lakehouse.
- The view is refreshed every 5 seconds, in place and without blocking its readers ([JEX-NFR-14](../components/journey-execution.md#non-functional-requirements)). The Journey tab keeps its 5-second refresh. Both intervals are the lead's default, pending owner review.

This supersedes decision 0009 in part: the plain view, and its rejection of a materialized view. The rest of 0009 stands, except that a moved count stays when its hot rows are deleted. It also supersedes in part [decision 0053](0053-store-raw-events-transition-history-and-imports-in-an-iceberg-lakehouse.md)'s consequence that the view must combine both stores or move to the lakehouse. No trigger maintains the counts, and the engine's write path takes no lock on a shared row.

## Why

**An entry is in one partition.** The partitions are cut by entry start, which never changes ([JEX-FR-20](../components/journey-execution.md#functional-requirements)). Once a move has closed a partition, its count of distinct entries per node is final, and the sum of those counts over partitions counts each entry once. So the move can keep one number per node where it would otherwise have to keep the rows.

**The counts stay in Postgres.** The Journey tab polls every 5 seconds. Athena bills per query and answers in seconds, which would break that poll ([JBD-FR-09](../../features/journey-builder.md#functional-requirements)). The view answers from one index read.

**The move already reads every row of the partition.** It closes the partition, checks it against the history, and removes it ([LKH-FR-21](../components/lakehouse.md#functional-requirements)). Counting it between the check and the removal adds one grouped query to a step that already scans the partition, and the write is an upsert keyed by the partition, so a move run twice converges.

**A materialized view, not a plain view over both.** A plain view over the hot table and the counts table would answer at read time, exact and lag-free, as 0009's view does today. The owner chose a materialized view. The read cost of the hot count moves from the Journey tab's poll to the refresh, and the counts lag by up to one interval.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Read `transition_history` through Athena | From a plain view, a query per open Journey tab every 5 seconds. From a scheduled refresh, a query every interval. Either way seconds of latency, billed per query, and no count to show while a query runs. |
| Keep every partition in Postgres while the view reads it | No partition could move, so the table never shrinks, which decision 0052 set out to fix. |
| A plain view over the hot table and the moved counts | Exact and lag-free. The owner chose the materialized view, which keeps the hot count's read cost off the Journey tab's poll. |
| A counter table maintained by a trigger on the transitions | Decision 0009 rejected shared counter rows on the engine's write path ([JEX-NFR-07](../components/journey-execution.md#non-functional-requirements)). |

## Consequences

- A count lags its transition by up to one refresh interval plus one refresh (JEX-NFR-14), and the Journey tab adds its own refresh on top ([JBD-NFR-05](../../features/journey-builder.md#non-functional-requirements)). Decision 0009's counts were exact at read time.
- The view does not count a late transition, which goes straight to `transition_history` ([JEX-FR-22](../components/journey-execution.md#functional-requirements)). All time in journey analytics does count it. The two can differ by those rows.
- A moved count is fixed at the move. Whether a later identity merge should change it is not decided. [Identity merges](../components/identity/identity-merges.md) counts a merged person once through the merge records, which the view can do for the hot partitions only. The conflict is an open question in [journey execution](../components/journey-execution.md#open-questions) and [identity merges](../components/identity/identity-merges.md#open-questions).
- Simulator clean-up deletes hot rows only ([SIM-FR-28](../../features/traffic-simulator.md#functional-requirements)), so a `sim_` campaign's moved counts stay in the view after its hot rows are gone. Decision 0009's rule that a count disappears only with its transitions does not hold for moved counts.
- The move commits the counts and the removal in one transaction, so the lock the removal takes on the parent table also covers the count write. That is a cost to measure with the move, not a contract rule.
- The refresh rescans the hot partitions' index every interval, for every campaign, so its cost grows with the hot table, up to 90 days of transitions. That is why the interval is pending owner review. Measure a refresh on the deployed database before shortening the interval, and lengthen it if a refresh does not finish within it.
- Who runs the refresh is an [open question in journey execution](../components/journey-execution.md#open-questions).
- `campaign_node_stats` leaves the list of readers that hold partitions in Postgres (JEX-FR-24). A partition can move once the other readers read both stores.
- The schema gains `campaign_node_moved_counts`, the materialized view with the unique index its refresh needs, and the move's write. [The data model](../data-model.md) lists them as planned.

## Related

- [Journey execution](../components/journey-execution.md)
- [Lakehouse sink](../components/lakehouse.md#move-a-hot-partition)
- [Journey builder](../../features/journey-builder.md#journey-pages)
- [Data model](../data-model.md)
- [0009. Compute node stats as a view, not a trigger-maintained table](0009-compute-node-stats-as-a-view.md), superseded in part
- [0053. Store raw events, transition history, and imports in an Iceberg lakehouse](0053-store-raw-events-transition-history-and-imports-in-an-iceberg-lakehouse.md), superseded in part: its consequence on `campaign_node_stats`
- [0035. Compute journey analytics from the transitions on read](0035-compute-journey-analytics-from-transitions-on-read.md)
- [0052. Keep hot state in Flink and a redesigned projection in Postgres](0052-keep-hot-state-in-flink-and-a-redesigned-projection-in-postgres.md)
- [0058. Read recent analytics from Postgres and history from the lakehouse](0058-read-recent-analytics-from-postgres-and-history-from-the-lakehouse.md)
