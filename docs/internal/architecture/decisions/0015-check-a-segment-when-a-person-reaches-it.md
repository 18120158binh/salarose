---
title: Check a segment when a person reaches it
id: "0015"
status: proposed
date: 2026-10-18
tags: [flink, kafka, journeys, state-machine, metrics]
supersedes: []
superseded_by: []
---

# 0015. Check a segment when a person reaches it

## Context

A segment node is a check on metrics only. It completes on `yes` when its metric condition holds, and never on `no`. Since the segment change in PR #172, customer decision evaluated a segment only when an event changed one of its metrics. A person who already met the condition when the segment's parent completed, for example `COUNT(m_purchase_count) >= 2` after two purchases, waited at the segment until their next purchase. A person whose metric never changed again stayed there for good.

The owner decided on 2026-10-18 that a segment is also evaluated the moment a person reaches it, that is, when its parent completes. The evaluation on a metric change stays.

The two facts this needs live in two jobs. The state machine knows when a parent completes, keyed by journey instance. Customer decision holds each person's metric series, keyed by `canon_id`, with the loader for series missing from state ([decision 0004](0004-compute-metrics-and-decisions-in-one-keyed-job.md), [decision 0005](0005-keep-live-state-in-flink.md)).

## Decision

The state machine asks customer decision to check the segment, and customer decision answers with an ordinary trigger.

1. When the state machine completes a node, it sends one segment check for each segment child on the completed branch that has not completed. It sends the check to the Kafka topic `journey-engine-segment-checks`, keyed by `canon_id`. The check names the person, the campaign, and the segment node, and carries the `event_id`, `event_name`, and `event_time` of the trigger that completed the parent.
2. Customer decision reads the topic, keyed by `canon_id`, into the operator that holds the person's series. A check counts nothing. It takes the person's snapshot and goes through the same steps as an event's candidates: the series missing from state are loaded from `user_metrics`, and the metric evaluator decides. The metric window ends at the check's `event_time`, the parent's completion.
3. If the condition holds and the campaign is active, customer decision emits a trigger for the segment on `yes`, with the check's `event_id`, `event_name`, and `event_time`, to `journey-engine-matched-events`. If it does not hold, it emits nothing, and the person waits for a metric change as before.
4. The state machine applies that trigger like any other. Its time equals the parent's completion, which passes the parent check.

## Why

- **One decider.** The metric evaluator, the snapshot, and the loader of missing series stay in customer decision. The state machine does not read `user_metrics` or know metric functions.
- **The live series, not the durable copy.** `user_metrics` trails customer decision's state by the profile writer's lag. A check against `user_metrics` alone would miss the purchase that has just been counted. Customer decision merges state over what it loads, the same rule as for events (DEC-FR-06).
- **Same shape as watch timers.** A timer is another job's answer that comes back to the state machine as a trigger on `journey-engine-matched-events`. A segment check does the same, so the state machine needs no new input and no new completion rule.
- **Replay converges.** Both hops are at least once ([decision 0006](0006-at-least-once-delivery-with-idempotent-writes.md)). A state machine replay sends a check again, and a customer decision replay evaluates it again. Each extra `yes` reaches a segment that has already completed, and the state machine ignores it (JEX-FR-01). The transitions sink inserts a row once per node. A check that fails can be followed by a metric change that passes. The first `yes` to arrive completes the segment ([decision 0011](0011-the-first-trigger-to-arrive-completes-a-node.md)).
- **Keyed by owner.** The check is keyed by `canon_id`, the key of the state it reads. The trigger it produces is keyed by journey instance, the key of the state it changes ([decision 0002](0002-key-every-write-by-its-owner.md)).

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| The state machine reads `user_metrics` and evaluates the segment itself | A second copy of the metric functions, windows, and truncation rules. It reads the durable copy, which trails the live series, so it misses a purchase counted seconds earlier. |
| Customer decision evaluates segments on every event, not only on a metric change | Still waits for the person's next event of any kind. It also evaluates every segment of every campaign for people who are not at it. |
| The outbox job sends the check from the transition rows, as the timer flow does | The transition row lists only watch children. Listing segments changes a stored column. Adding a flow to the outbox job also moves the generated id of its `user_campaign_state_transitions` CDC source, which has no uid, and a restore that loses the source position re-sends every notification (JEX-KI-08). |
| Customer decision consumes the transition rows through CDC | A second CDC slot on a busy table, and customer decision would need the graph to find segment children. |

## Consequences

- One new Kafka topic, `journey-engine-segment-checks`, keyed by `canon_id`. It needs at least as many partitions as customer decision's parallelism. `KAFKA_SEGMENT_CHECK_TOPIC` names it in both jobs.
- Customer decision has a second Kafka source, uid `segment-checks-source`. Its keyed operator `apply-behavior-state` takes events and checks. Its keyed state does not change.
- The state machine has a new side output and Kafka sink, uid `segment-check-sink`.
- The customer decision graph no longer has the shape it had at commit `7090417a`. The ids it carries from before the uids still restore a savepoint of that graph, but a test can no longer derive them again.
- A check takes a round trip through Kafka and two jobs, and its answer carries the parent's time, which the watermark can pass meanwhile. The state machine therefore never drops a segment trigger at exactly its parent's completion time as late, the same exemption a watch deadline has. The owner chose the exemption on 2026-10-18.
- The answer is recognized by its time, not by a field. The state machine keeps buffered triggers with Kryo, and a field added to the trigger record made a test restore of saved state fail. A trigger from a metric change at the parent's exact time is exempt too. Its parent has completed, so it applies as it would have in order.
- A metric change that reaches customer decision after the check, from an event before the parent's completion, yields a segment trigger earlier than the parent. When it arrives after the parent completed, the state machine sends the check again at the parent's completion time instead of completing the segment on it, even when the trigger is behind the watermark. This was chosen during the fix, pending owner review.
- A segment that a save adds under a parent that already completed is not checked, the same as any child added behind a person ([decision 0013](0013-apply-a-campaign-save-as-one-change.md)).

## Related

- [Journey execution](../components/journey-execution.md)
- [Customer decision](../components/customer-decision.md)
- [Journey builder](../../features/journey-builder.md#node-types)
- [0004. Compute metrics and decisions in one keyed job](0004-compute-metrics-and-decisions-in-one-keyed-job.md)
- [0006. At-least-once delivery with idempotent writes](0006-at-least-once-delivery-with-idempotent-writes.md)
- [0008. One trigger watermark for both producers](0008-one-trigger-watermark-for-both-producers.md)
- [0011. The first trigger to arrive completes a node](0011-the-first-trigger-to-arrive-completes-a-node.md)
