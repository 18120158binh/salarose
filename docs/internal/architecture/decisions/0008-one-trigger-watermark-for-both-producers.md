---
title: One trigger watermark for both producers
id: "0008"
status: proposed
date: 2026-10-18
tags: [flink, kafka, journeys, watermark]
supersedes: []
superseded_by: []
---

# 0008. One trigger watermark for both producers

## Context

Customer decision and the watch timers write triggers to one Kafka topic, `journey-engine-matched-events`. The state machine reads it with one watermark, which trails the newest trigger by the allowed out-of-orderness, 10 minutes by default. A trigger at or before the watermark when it arrives is dropped as late. Watch deadline triggers are exempt.

The watermark started to move in October 2026. Before that it never advanced, and nothing was dropped as late. With it moving, a customer decision outage longer than 10 minutes has a new effect. The watch timers keep writing timeouts with current deadlines, so the watermark keeps moving. When customer decision catches up, its backlog is older than the watermark and is dropped as late.

## Decision

Keep one topic and one watermark. A customer decision backlog more than the allowed out-of-orderness behind the watermark is dropped as late. Late drops are counted, and operations alert on the count.

A topic or partition set per producer, with a watermark each, is deferred until production shows that such outages happen.

## Why

The per-producer split changes the trigger topic, the timer flow's sink, the state machine's sources, and the deploy order of three jobs. Whether outages that long happen in production is not known yet. The count makes the loss visible when it happens, so the split can be built on evidence.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| One topic or partition set per producer, each with its own watermark | A lag in one producer would hold back only its own watermark, and its backlog would apply when it catches up. It costs a topic, two sources, and a coordinated deploy, for an outage not yet seen to happen. |
| A larger allowed out-of-orderness | Every buffered trigger would wait longer before it is released, and an outage longer than the new bound still loses its backlog. |

## Consequences

- A customer decision outage longer than the allowed out-of-orderness loses the journey moves of its backlog.
- The late count must reach an alert. Without the alert, the loss is silent.
- If the alert fires in production, revisit this record and build the per-producer split.

## Related

- [Journey execution](../components/journey-execution.md)
- [Customer decision](../components/customer-decision.md)
