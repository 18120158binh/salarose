---
title: Compute journey analytics from the transitions on read
id: "0035"
status: accepted
date: 2026-11-07
tags: [postgres, journeys, studio, studio-v2, analytics]
supersedes: []
superseded_by: []
---

# 0035. Compute journey analytics from the transitions on read

## Context

Studio v2's phase 1 shows numbers that no table holds yet: entries, messages requested, and watch outcomes per time range on the [home overview](../../features/home-overview.md), and per-node Entered, Waiting, and Completed with a branch split and a time range in [journey analytics](../../features/journey-builder.md#node-analytics). Phase 1 may add read views and indexes, but no pipeline data.

The only per-node number today is `campaign_node_stats`, the view of [decision 0009](0009-compute-node-stats-as-a-view.md): distinct entries per node over all time, on every branch. Decision 0009 was proposed on 2026-10-18 and never accepted. The design asked phase 1 to accept it or replace it with a rollup, with evidence.

## Decision

1. Decision 0009 is accepted as it stands. `campaign_node_stats` stays a view, and the classic builder keeps reading it.
2. Studio v2 computes every phase 1 number from `user_campaign_state_transitions` when a page asks for it, with the definitions in the home overview and node analytics contracts. No trigger, rollup table, or Flink job counts them.
3. `schema.sql` adds these indexes in phase 1:

| Table | Index | Serves |
|---|---|---|
| `user_campaign_state_transitions` | (`campaign_id`, `node_id`, `branch`, `event_timestamp`) including `canon_id`, `entry_id` | The reach set of each node, and entries per journey in a range |
| `user_campaign_state_transitions` | (`node_type`, `event_timestamp`) including `campaign_id`, `branch` | The home KPIs across all journeys |
| `user_campaign_state_transitions` | (`node_type`, `transitioned_at`) including `event_timestamp`, `branch` | Engine lag by write time over `setup` and `check` transitions and `watch` transitions on `success`, and the newest `setup`, `check`, or `watch` transition |
| `identity_graph` | (`canon_id`) including `domain_userid`, `user_id`, `created_at`, `updated_at` | A profile's identities, including devices with no user id |

The primary key of `user_campaign_state_transitions` starts with (`canon_id`, `campaign_id`, `entry_id`, `node_id`), so it already serves the check "has this entry completed this node", and a customer's entries.

4. Before phase 1 is called done, the builder of each query runs it with `EXPLAIN (ANALYZE, BUFFERS)` on the deployed database, for Last 30 days, and records the plan and the time in the pull request. It also runs the query of `campaign_node_stats`. If that plan uses the first index above, the same change drops the older index on (`campaign_id`, `node_id`, `canon_id`, `entry_id`), so each insert maintains two more indexes, not three. A query slower than 2 seconds at the 95th percentile ships with its range limited to Last 7 days, and a rollup becomes a phase 2 item.

## Why

**Decision 0009's reasons still hold.** A view cannot miss a branch or drift from the transitions, and a transition insert takes no lock on a shared row, which JEX-NFR-07 requires. Nothing found since 2026-10-18 argues against it. Leaving it proposed only leaves the builder's counts without a recorded basis.

**The numbers need entry-level rows.** Node analytics count Completed among the entries that reached a node in the range. That is a join of two transitions of the same entry, which only the rows can answer. A rollup of daily counts per node and branch can give Entered, but not Completed or Waiting for the same entries. With a rollup, Completed would have to change meaning to "completions in the range", and then Entered minus Completed is no longer the number of people waiting. Computing on read keeps the definitions simple to state and to test.

**The volume fits, as far as we can tell without a measurement.** This part is inferred, not measured. The traffic simulator's average load is 25 million events a day (SIM-NFR-04). If one event in a hundred opens or advances an entry, the transition table grows by about 250,000 rows a day, or 7.5 million rows in 30 days. A Last 30 days query for one journey reads only that journey's rows through the first index, and the home KPIs read the rows of three node types through the second. Each is an index range scan without a sort over the whole table. The cluster's load today is lower than the simulator's average, because the simulator runs in bursts. So the 2-second bound should hold in phase 1, and step 4 checks it on the real data before anyone relies on it.

**A rollup has no good writer yet.** A trigger that adds to shared counter rows brings back the deadlock decision 0002 and decision 0009 describe. A Flink job keyed by node adds a job and replay rules to count what the rows already imply, which decision 0009 rejected. A periodic job in studio would make studio write, which phases 0 and 1 forbid ([decision 0034](0034-build-studio-v2-side-by-side-under-v2.md)). When step 4 shows that a rollup is needed, phase 2 picks its writer with that measurement in hand.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Replace decision 0009's view with a rollup table now | No measurement shows the view or the new queries are slow. A rollup cannot give Completed for the entries that reached a node, and every writer for it breaks a rule of decision 0002, 0009, or 0034. |
| A materialized view of daily counts, refreshed on a schedule | Counts lag by the refresh interval, a refresh rescans every transition, and it has the same Completed problem as a rollup. |
| Count by write time instead of event time | A replay or a backlog would move a day's entries into the day the engine caught up. Marketers ask what happened on a day, not when the engine wrote it. Lag is the one number that counts by write time. |
| Keep decision 0009 proposed | The design asked for it to be settled. Nothing in it is in doubt. |

## Consequences

- Decision 0009's text counts distinct `canon_id` per node. Since [decision 0033](0033-a-journey-instance-is-one-entry.md), `schema.sql` counts distinct (`canon_id`, `entry_id`), so a person with two entries counts twice. That amended count is the one accepted here.
- Every transition insert updates three more indexes, or two if step 4 drops the older one. The state machine's sink writes more per row. Its bench in the [traffic simulator](../../features/traffic-simulator.md) measures the transition write rate, and a drop there after phase 1 points here.
- A page view runs a query whose cost grows with the journey's transitions in the range. Studio must bound each query with a statement timeout so that a slow query fails one data region and not the database.
- Late transitions change the numbers of a past range. Most arrive within the engine's 10-minute late window. A watch timeout after a timer outage, and a condition split that completes when its conditions come to hold, can arrive hours later with an older event time.
- Node analytics and the classic badge agree: Completed over All time equals `campaign_node_stats.user_count`.
- `schema.sql` is the only place the indexes go ([decision 0019](0019-keep-schema-sql-the-only-ddl-source.md)), and the [data model](../data-model.md) lists them once they exist.
- If step 4 fails, the phase 2 rollup needs its own decision, which must say how it defines Completed.

## Related

- [0009. Compute node stats as a view](0009-compute-node-stats-as-a-view.md)
- [0002. Key every stateful write by its owner](0002-key-every-write-by-its-owner.md)
- [0034. Build studio v2 side by side under `/v2`](0034-build-studio-v2-side-by-side-under-v2.md)
- [Home overview](../../features/home-overview.md)
- [Journey builder: node analytics](../../features/journey-builder.md#node-analytics)
- [Customer lookup](../../features/customer-lookup.md)
- [Journey execution](../components/journey-execution.md)
