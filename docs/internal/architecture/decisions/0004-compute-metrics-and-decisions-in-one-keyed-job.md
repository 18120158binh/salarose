---
title: Compute metrics and decisions in one keyed job
id: "0004"
status: accepted
date: 2026-08-07
tags: [customer-decision, metrics, consistency]
supersedes: []
superseded_by: []
---

# 0004. Compute metrics and decisions in one keyed job

## Context

A journey node can test behavior over time, such as "added to cart at least 3 times in the last 7 days". That needs a metric per person.

Metrics were first computed in Postgres. The state machine trigger ran `COUNT(*)` or `SUM(...)` over `user_events_log` for each aggregation node. On a 4.3 GB table these queries took up to 2.31 seconds per batch, and the time grew with the table.

A July 2026 proposal moved the aggregation to a Flink job, `EngagementMetricsJob`. It kept windowed values in RocksDB and upserted them into a Postgres table, so the trigger could read a metric by primary key in under 0.1 ms. That design ran two jobs on the same input: one updated metrics, the other matched rules. A rule could then read a metric before the metric job had counted the current event.

The Flink algorithm spec of July 2026 patched this race with "speculative delta compensation". If the event that reached Postgres was the metric's target event and the stored metric had not yet met its target, the trigger added 1 to the stored value. That worked only for counts, and only for the one event that raced.

## Decision

Run metric updates and rule decisions in one Flink job, `CustomerDecisionJob`, keyed by `canon_id`. For each event, the job first updates the person's metrics in keyed state, then evaluates the rules against the metrics after the update. Postgres holds a lagging copy of the metrics and is not on the decision path. [Decision 0005](0005-keep-live-state-in-flink.md) covers that copy.

The job replaced `CampaignFilterJob` and `UserMetricsJob` in commits `a0b71ec1` and `1789920e`.

## Why

When both steps run on the same key in the same operator chain, the metric a rule sees always includes the current event. No timing window exists for a race to fall into, so no compensation rule is needed. The fix covers every function, not only counts.

It also removes a Postgres read from the hot path. A metric is read from Postgres only when its keyed state has expired.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Metrics in Postgres, computed by the trigger | Seconds per batch on a large table, and the cost grows with the table. |
| A separate metrics job that writes Postgres, read by the matcher | The matcher can read before the metrics job writes. |
| Speculative delta compensation | Correct only for counts and for the one event that races. Every new function would need its own rule. |

## Consequences

- One job owns a person's metrics. Another job must not update them.
- Rule selection must consider both the event's name and the metrics the event changed. A rule that tests only a metric must still run when that metric changes.
- A rule must be evaluated against the person's whole metric snapshot, not only the metrics this event changed. The [customer decision](../components/customer-decision.md) contract states this. The current code does not meet it. See [its known issues](../../known-issues/components/customer-decision.md).
- Keyed state needs bounds: metrics per person, occurrences per metric, and a TTL. The contract gives the defaults.

## Related

- [Customer decision](../components/customer-decision.md)
- [Profile writer](../components/profile-writer.md)
- [0005. Keep live state in Flink and a durable copy in Postgres](0005-keep-live-state-in-flink.md)
