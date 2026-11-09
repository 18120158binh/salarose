---
title: Make every rule decision in one keyed operator
id: "0030"
status: accepted
date: 2026-10-21
tags: [flink, rules, profile, ordering]
supersedes: []
superseded_by: []
---

# 0030. Make every rule decision in one keyed operator

## Context

[Decision 0004](0004-compute-metrics-and-decisions-in-one-keyed-job.md) put metric updates and rule decisions in one job, keyed by `canon_id`, so that a rule always sees the metrics after the current event. The job has three operators:

1. **Apply Behavior State and Select Candidates**, keyed by `canon_id`, with a broadcast copy of the metric definitions, campaigns, and nodes. It deduplicates, updates metrics, selects candidate rules, and reads only the series they reference. It reads `user_metrics` on a state miss without blocking the subtask ([decision 0026](0026-read-user-metrics-through-the-mailbox-of-the-behavior-operator.md)). It sends candidates that need a profile or a stored series to a side output.
2. **Async lookup**, with `unorderedWait`. It reads every column of the person's `customer_profiles` row, and series from `user_metrics`, with a cache on each subtask.
3. **Decision**, not keyed, fed by the union of the first operator and the lookup, with its own broadcast copy of campaigns and nodes. It checks profile and metric conditions and emits triggers.

That layout causes these problems:

- **Rule copies disagree.** The two copies apply rule changes when they arrive. When a rule changes between selection and evaluation, the decision operator finds a series that selection did not read, treats it as unknown, and makes no decision for that rule on that event. [Decision 0022](0022-version-each-published-graph.md) lets journey execution drop a trigger decided against an older graph, but it cannot bring back a decision that was never made.
- **Per-person order is lost.** After the first operator nothing is keyed, and `unorderedWait` lets a person's later event overtake an earlier one that waits for a lookup.
- **Profile lookups happen too early.** The first operator sends a candidate to the lookup when any of its rules has a profile condition, before any metric condition is evaluated, and the lookup reads the whole profile.
- **Stored metrics have two read paths.** The first operator reads `user_metrics` on a state miss to count an event, and the lookup reads it again for a series a rule references. The lookup's result does not go back into the person's state.

The owner did not want this layout, on 2026-10-21. The owner also did not want the job to keep every person's profile in state only to evaluate profile conditions.

## Decision

One operator, keyed by `canon_id`, holds the person's metric state and the only broadcast copy of the rules and metric definitions. For each event it deduplicates, updates metrics, selects the rules whose trigger matches, and evaluates their conditions cheapest first, by the group rules of [decision 0029](0029-model-a-rule-as-a-trigger-and-person-conditions.md). Behavior conditions read keyed state. The operator emits the triggers of every rule it can settle without the profile.

When rules still need the profile, the operator does not wait for it. It emits a pending decision: the event, its per-person sequence number, and for each unsettled rule, the profile conditions that remain and the branches they would fire. An unordered async lookup reads only the profile fields those conditions name, once per event, and keeps none of it in state. A second operator, keyed by `canon_id`, finishes the pending conditions from the data the record carries. It needs no rule state. It releases each person's outcomes in sequence order, so a person's triggers leave in the order their events arrived. Events that need no lookup pass through it with their sequence number too.

Every rule evaluated for one event comes from the rule version the first operator held when the event arrived, because the pending decision carries the conditions themselves.

`user_metrics` is read only to restore a series that the first operator's state does not hold, without blocking the subtask, as [decision 0026](0026-read-user-metrics-through-the-mailbox-of-the-behavior-operator.md) does today. The result goes into keyed state.

The owner chose one keyed operator for rule decisions, and lookups that keep no profile in state, on 2026-10-21. The unordered lookup, the per-person sequence number, and carrying the remaining conditions were chosen while writing this record, and are pending owner review. The owner's choices are in the decision log, `~/.claude/scripts/state/decisions.tsv`, from the design session of 2026-10-21.

## Why

Keeping the decision in one keyed operator is what [decision 0004](0004-compute-metrics-and-decisions-in-one-keyed-job.md) argued for. The current layout keeps that only for the metric update. Everything after it gave up keying to fit an asynchronous lookup, and each lost guarantee then needed a workaround: a third rule copy, a check for vanished rules, and a snapshot copied into every record.

With every rule decision in the first operator, the rules and the person's state are on the same subtask at the same time. The operator reads only the series that the selected rules reference, so the snapshot copy goes away. One broadcast copy means one rule version per event. The pending decision carries the few profile conditions left, not the rules, so the finishing operator cannot see a different rule version.

Flink's DataStream API has no keyed async I/O. Its async operator emits either in request order across the whole subtask or in completion order. A key-ordered mode exists only for SQL lookup joins ([FLIP-519](https://cwiki.apache.org/confluence/spaces/FLINK/pages/347933328/FLIP-519+Introduce+async+lookup+key+ordered+mode)). So the lookup runs unordered, which keeps one slow lookup from delaying other people, and the finishing operator restores each person's order with the sequence number.

A profile lookup per event, limited to the referenced fields, is the owner's choice over keeping profiles in state. It costs a lookup only for events whose rules reach a profile condition after their trigger and behavior conditions pass. The trigger filters and the groups that need no profile already rule out most events.

Holding a person's later outcomes behind a lookup keeps their triggers in arrival order, at the cost of that person's latency, not everyone's.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Keep the three operators and fix each problem in place | Each fix adds a workaround to the split, as the unknown-series rule and the graph version already show. |
| Keep every profile in keyed state, fed by a profile stream | No lookups and no stale cache, but the owner did not want the job to store profiles only for lookups. It also needs a feed that the platform does not receive today. |
| An ordered async lookup operator after the keyed operator | `orderedWait` keeps order across the whole subtask, so one slow lookup delays every person on it. |
| Look up the profile synchronously inside the keyed operator | Simplest, but a slow `customer_profiles` read blocks every person on the subtask. |
| Carry the rules, not the conditions, to the finishing operator | Puts a second rule copy behind the lookup, which brings back the version skew this decision removes. |

## Consequences

- The job's operator graph changes. A savepoint from the old graph does not restore into the new one. No deployment runs the job yet.
- The profile cache, if any, holds only referenced fields, with the bounds in DEC-NFR-08. A failed lookup still makes profile conditions false for that event.
- A person whose event waits for a lookup sees their later outcomes wait too. The lookup timeout bounds that wait.
- The first operator keeps a per-person sequence counter in state, and the finishing operator keeps the next expected number and any outcomes that arrived early. A sequence gap after a restore must not stall a person forever. The checkpoint holds both counters, and replay restores them together.
- Tests can drive every rule decision through the first operator's harness, and ordering through the second's.

## Related

- [Customer decision](../components/customer-decision.md)
- [0004. Compute metrics and decisions in one keyed job](0004-compute-metrics-and-decisions-in-one-keyed-job.md)
- [0003. Load rules through CDC and broadcast state](0003-load-rules-through-cdc-and-broadcast-state.md)
- [0029. Model a rule as a trigger and person conditions](0029-model-a-rule-as-a-trigger-and-person-conditions.md)
