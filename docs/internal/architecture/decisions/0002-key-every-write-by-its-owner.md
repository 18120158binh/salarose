---
title: Key every stateful write by its owner
id: "0002"
status: accepted
date: 2026-06-23
tags: [flink, postgres, concurrency, sinks]
supersedes: []
superseded_by: []
---

# 0002. Key every stateful write by its owner

## Context

In June 2026 the campaign matching job ran with parallelism above 1 under a stress test. Its tasks crashed and entered a restart loop. The JDBC sink logged this error:

```text
org.postgresql.util.PSQLException: ERROR: deadlock detected
  Detail: Process 30734 waits for ExclusiveLock on advisory lock [16384,4294967295,2915923139,1]; blocked by process 30733.
Process 30733 waits for ExclusiveLock on advisory lock [16384,0,972443451,1]; blocked by process 30734.
  Where: SQL statement "SELECT pg_advisory_xact_lock(hashtext(NEW.user_id || ':' || NEW.campaign_id))"
PL/pgSQL function evaluate_state_transitions() line 23 at PERFORM
```

## Decision

Before a stream reaches an operator or a sink that writes shared rows, key it by the owner of those rows. The owner is usually `canon_id`, or the journey key `canon_id` + U+001F + `campaign_id`. Then one subtask writes each row, in order. Add a database lock only if keying cannot give that guarantee.

## Why

The deadlock had three parts:

1. The table `user_events_log` had a trigger that took an advisory lock per user and campaign, to make journey transitions safe.
2. The event stream was not keyed. Events for one user went to any subtask.
3. Subtask A received a batch with events for user 1 and then user 2. Subtask B received a batch with user 2 and then user 1. Both flushed at the same time. A locked user 1 and waited for user 2. B locked user 2 and waited for user 1. Postgres broke the cycle by aborting one transaction, and Flink restarted the job.

Keying the stream by `user_id` before the matching operator fixed it. A `keyBy` routes every event for one user to one subtask, so no two subtasks hold locks for the same user, and the cycle cannot form. Parallelism could then grow to any number. The fix turned the matching function into a keyed broadcast function.

The lesson is general. Two writers that touch the same rows in different orders can deadlock, and a lock only moves the problem. Giving each row one writer removes it.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Parallelism 1 for the sink | Removes the deadlock and the throughput with it. |
| Sort each batch by user before the flush | Prevents this cycle, but two batches can still interleave across flushes. It also hides the ownership rule instead of stating it. |
| Retry the aborted transaction | Turns a deadlock into repeated aborts under load. |

## Consequences

- Every job keys by `canon_id` or by journey key before a stateful operator. A new sink that writes rows owned by a person or a journey must do the same.
- An unkeyed stream may write only rows that no other subtask writes, or rows that an idempotent upsert makes safe to race. See [decision 0006](0006-at-least-once-delivery-with-idempotent-writes.md).
- The trigger that deadlocked no longer runs. [Decision 0001](0001-run-the-journey-engine-in-flink.md) moved the journey engine to Flink, where keying alone protects a journey.

## Related

- [0001. Run the journey engine in Flink](0001-run-the-journey-engine-in-flink.md)
- [Journey execution](../components/journey-execution.md)
- [Customer decision](../components/customer-decision.md)
