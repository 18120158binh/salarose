---
title: Read recent analytics from Postgres and history from the lakehouse
id: "0058"
status: accepted
date: 2026-11-17
tags: [analytics, lakehouse, athena, postgres, transitions]
supersedes: ["0053"]
superseded_by: []
---

# 0058. Read recent analytics from Postgres and history from the lakehouse

## Context

[Decision 0053](0053-store-raw-events-transition-history-and-imports-in-an-iceberg-lakehouse.md) moved journey analytics and the home KPIs off the hot transitions table: they were to read transition history in the lakehouse, and the hot table was to keep only the indexes the engine and the outbox use. It left open who reads the numbers, how fresh they must be, and with which engine (#111).

The owner answered on 2026-11-17 (#111), and refined the answer on 2026-11-18, in the review of PR #173. The answer keeps recent ranges on the hot table, which reverses part of 0053, so the decisions README calls for a new record.

## Decision

Analytics read recent ranges from Postgres and history from the lakehouse.

- A range that starts no more than 90 days ago reads `user_campaign_state_transitions` in Postgres only, seconds fresh, with no lakehouse query. It may leave out late transitions, the rows written straight to `transition_history` ([LKH-FR-22](../components/lakehouse.md#functional-requirements)).
- A range that starts earlier, such as All time, and a person's whole history in customer lookup read both stores: the hot partitions from Postgres and the moved ones from `transition_history` through Athena, a serverless engine, split at the move boundary so that each transition counts once ([LKH-FR-17](../components/lakehouse.md#functional-requirements)).
- No query engine runs between queries.
- The hot table keeps the indexes its analytics reads use ([JEX-NFR-13](../components/journey-execution.md#non-functional-requirements)).

This supersedes in part decision 0053's third point, "Analytics off the hot table". The rest of 0053 stands, and so does the amendment of [decision 0035](0035-compute-journey-analytics-from-transitions-on-read.md) by 0053 for history: the definitions and the compute-on-read approach stay.

## Why

**Recent numbers must be seconds fresh.** Transitions reach `transition_history` only when their partition moves, up to 90 days after their entry starts. The lakehouse cannot serve a dashboard of today's entries.

**Late transitions are rare.** Every entry lives at most 90 days from its start ([JEX-NFR-03](../components/journey-execution.md#non-functional-requirements)), and a partition moves only once all its entries have expired. A late transition comes only from a replay after a restore, or from an entry that completes a node at the exact 90-day edge, in its last moments, while a move has its partition closed. A partition moves only once every entry in it has expired (JEX-NFR-12), so the second case is rare. Leaving them out of a recent range keeps every recent page off Athena, whose latency would break the 2-second bounds of HOM-NFR-01 and JBD-NFR-03.

**A serverless engine costs nothing when nobody reads history.** Long ranges are occasional. Athena bills per query, and nothing runs between them.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| All analytics from the lakehouse, as 0053 said | Seconds-fresh numbers would need transitions streamed to the lakehouse and an always-on engine. |
| Recent ranges read both stores, exactly | Every page load would query Athena for the rare late transition. |
| An always-on engine, such as Trino | A service to run for occasional long ranges. |

## Consequences

- The hot table keeps its analytics indexes, so the state machine's inserts keep their cost. The WAL saving 0053 expected from dropping them does not happen ([platform capacity](../capacity.md#coalesced-writes)).
- A recent range can undercount by the late transitions in it. The contracts state this limit (HOM-NFR-04, JBD-NFR-04).
- `campaign_node_stats` does not read the lakehouse. [Decision 0059](0059-compute-node-stats-as-a-materialized-view-over-hot-and-moved-counts.md) makes it a materialized view that counts moved partitions from the counts the move writes to Postgres.

## Related

- [0053. Store raw events, transition history, and imports in an Iceberg lakehouse](0053-store-raw-events-transition-history-and-imports-in-an-iceberg-lakehouse.md), superseded in part: its third point
- [0035. Compute journey analytics from the transitions on read](0035-compute-journey-analytics-from-transitions-on-read.md)
- [Lakehouse sink](../components/lakehouse.md#read-across-both-stores), [home overview](../../features/home-overview.md), [journey builder](../../features/journey-builder.md#node-analytics), [customer lookup](../../features/customer-lookup.md)
