---
title: The first trigger to arrive completes a node
id: "0011"
status: accepted
date: 2026-10-17
accepted: 2026-10-18
tags: [flink, journeys, watermark, ordering]
supersedes: []
superseded_by: []
---

# 0011. The first trigger to arrive completes a node

## Context

The journey execution contract asked that triggers up to 10 minutes out of order be applied in event-time order (JEX-NFR-01). The state machine never did that. It applies a trigger as soon as the trigger can apply, and a node completes once. So when two triggers for one node arrive out of order, the later event completes the node, and the earlier one is ignored. A child trigger with an event time between the two is then earlier than its parent's completion, and it is dropped as unreachable when the watermark passes it. A watch's timeout that arrives before an earlier `success` completes the watch the same way.

Triggers that wait in the buffer, for a parent or for the campaign graph, are already retried in event-time order. The gap was only in triggers that apply as soon as they arrive.

The owner was away when this came up. The decision below was taken on 2026-10-17 under the owner's delegation.

The owner accepted it on 2026-10-18 on PR #171, with one clarification: a trigger that cannot apply yet waits up to the late window, applies if the missing event arrives in it, and is otherwise dropped while the journey stays open for later events.

## Decision

Change the contract to match the engine. A trigger applies as soon as it arrives, if it can, without waiting for the watermark. Among triggers that can complete the same node, the first to arrive completes it.

A trigger that cannot apply yet, such as a child whose parent's trigger has not arrived, waits in the buffer until the watermark passes its event time, the 10-minute late window by default. If the missing event arrives in that window, the trigger applies. If not, the trigger is dropped as unreachable. The journey does not end: the person stays at the node they reached and moves on with any later trigger that can apply.

Event time still decides the parent check, the watch deadlines, the order in which buffered triggers are retried, late drops, and the time each completed node records.

## Why

- Event-time order for every trigger means holding each one until the watermark passes it. The watermark trails the newest trigger by the allowed out-of-orderness, 10 minutes by default, and it holds while no trigger arrives. Every node would complete at least 10 minutes after its event, so every message would go out at least 10 minutes late.
- Journey products act on events as they arrive. A message that follows a product view is meant to go out within seconds of it.
- The buffer already retries the triggers that wait in event-time order. The cases left to arrival order are narrow: two qualifying events for one node out of order within 10 minutes, or a `success` that reaches the engine after its watch's timeout.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Hold every trigger until the watermark passes it, then apply in event-time order | Adds at least the allowed out-of-orderness to every node, and more while the watermark holds. The latency cost hits every journey to fix a narrow ordering case. |
| Let an earlier trigger replace a completion | A completion is published at once. Replacing it needs a retraction in the transition table, the outbox, and the timer flow, and a message already sent cannot be taken back. |

## Consequences

- A node can record a later event's time than the person's first qualifying event, and a child event between the two does not move the person on.
- A watch can take its `timeout` branch although a `success` happened before the deadline, if the `success` arrives after the timeout.
- A trigger that cannot apply on arrival must still wait in the buffer and be retried in event-time order. Code must not apply buffered triggers in arrival order.
- If ordering errors show up in production, revisit this record. A child trigger lost this way is counted as an unreachable drop, among other causes.

## Related

- [Journey execution](../components/journey-execution.md)
- [Event ingestion](../components/event-ingestion.md)
- [0008. One trigger watermark for both producers](0008-one-trigger-watermark-for-both-producers.md)
