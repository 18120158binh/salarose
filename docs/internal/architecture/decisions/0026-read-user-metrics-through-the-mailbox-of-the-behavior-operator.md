---
title: Read user metrics through the mailbox of the behavior operator
id: "0026"
status: proposed
date: 2026-10-20
tags: [flink, state, postgres, metrics]
supersedes: []
superseded_by: []
---

# 0026. Read user metrics through the mailbox of the behavior operator

## Context

The customer decision job keeps each person's metric series and behavior version in keyed state. It reads `user_metrics` on a state miss, as [decision 0005](0005-keep-live-state-in-flink.md) prescribes. The metric update read synchronously, on the subtask thread. A slow database held every person on the subtask for up to two read timeouts per event. This was DEC-KI-10.

The owner decided on 2026-10-20 that Postgres stays the store that answers a state miss, and that the read must not block the subtask.

Only the operator that holds the state can tell a miss from a hit. It needs the person's state and the metric definitions in broadcast state to decide. It also needs both to apply the result.

## Decision

The operator that applies behavior state starts each read itself, on a pool of 5 threads per subtask. While a read runs, the person's later events and segment checks wait in keyed list state, in arrival order. Other people's events go on. The read returns through the task's mailbox, so the waiting records run on the task thread. With 5 reads running, the operator takes no more input until one returns.

The watermark stays below the oldest waiting record. A checkpoint holds the waiting records, not the read. After a restore, the operator finds the people with waiting records and reads again. A failed read fails the task, so the job restarts from the last checkpoint and reads again.

The pool size, the watermark rule, and the restart behavior were chosen during the fix. They are pending owner review.

## Why

An async I/O operator ahead of the keyed one cannot see keyed state or broadcast state, so it cannot tell when a read is needed. The known-issues entry for DEC-KI-10 weighed that design and rejected it.

[Decision 0020](0020-read-the-identity-graph-off-the-streams-thread-inside-the-stitcher.md) solved the same problem in the identity stitcher with a timer that polls the read. It rejected a mailbox operator because the test harness did not cover it. Here, the operator test harness runs the operator against a real task mailbox, and the tests drive it: they hold a read, check that other people's events pass, and release the read. A mailbox callback also applies the result as soon as the read returns, with no polling delay. Behavior state is already an operator with two inputs and broadcast state, so a custom operator replaces no simpler function.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Keep the synchronous read, bounded by the read timeout | A slow database still stalls everyone on the subtask. |
| Make keyed state the only store the decision path reads | It changes decision 0005 and the state TTL rules. The owner chose to keep Postgres. |
| A processing-time timer that polls the read, as in decision 0020 | It adds a polling delay to each miss. Behavior state already sits in a custom two-input operator, so the timer saves no operator code. |

## Consequences

- A person's events wait while their read runs, and keep their order. Other people are not held.
- Each subtask opens up to 5 connections to the read replica for these reads.
- The operator extends Flink's keyed broadcast operator and takes its mailbox from the containing task. A Flink upgrade must check both.
- The job connects the behavior updates with a broadcast partition, not a broadcast stream, because Flink accepts a custom operator only on connected streams.

## Related

- [Customer decision](../components/customer-decision.md)
- [0005. Keep live state in Flink and a durable copy in Postgres](0005-keep-live-state-in-flink.md)
- [0020. Read the identity graph off the stream's thread inside the stitcher](0020-read-the-identity-graph-off-the-streams-thread-inside-the-stitcher.md)
