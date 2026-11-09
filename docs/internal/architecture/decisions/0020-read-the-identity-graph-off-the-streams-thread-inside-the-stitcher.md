---
title: Read the identity graph off the stream's thread inside the stitcher
id: "0020"
status: proposed
date: 2026-10-18
tags: [identity, flink, state, postgres]
supersedes: []
superseded_by: []
---

# 0020. Read the identity graph off the stream's thread inside the stitcher

## Context

The identity stitcher keeps each device's identity set in keyed state and reads `identity_graph` on a state miss, as [decision 0005](0005-keep-live-state-in-flink.md) prescribes. It read synchronously, on the stream's thread, through one pooled connection. While Postgres was slow or down, each read held the whole subtask for up to twice the lookup timeout. After a start without state, nearly every event read, the job fell behind, and checkpoint barriers queued behind those events could time out. This was IDS-KI-12.

Only the stitcher knows whether an event misses state. It needs keyed state to decide, and to apply the result.

## Decision

The stitcher starts each read itself, on a small pool of lookup threads, one per pooled connection. While a read runs, the key's events wait in keyed list state, in arrival order. A processing-time timer checks the read, after 1 ms and then backing off to every 50 ms, and publishes the waiting events when it completes. Events of other keys go on. A read that is complete when it starts is used at once.

A checkpoint holds the waiting events and their timer, not the read. After a restore, the timer fires, finds no read, and reads again for the first waiting event. At most 100 reads per subtask run at once. Past that, the stream waits for one of them to finish, so a slow database applies backpressure instead of growing an unbounded queue.

The pool size, the poll delays, and the limit of 100 were chosen during the fix for IDS-KI-12. They are pending owner review.

## Why

Flink's async I/O operator cannot use keyed state. Its runtime context refuses state access, because the key can change while a worker thread runs. So the common shape, an async operator ahead of a keyed one, cannot tell a state miss from a hit. It would have to read on every event, which breaks IDS-NFR-01 and multiplies the load on the primary, or keep its own cache of which identifiers the stitcher holds. That cache drifts from state: after a full structure is cleared, after a device's state expires, and after a restart. Each drift is a miss with no read, which then needs either a synchronous read, the problem being fixed, or a wrong result.

Keeping the read inside the keyed function keeps one owner for the decision and its result. Keyed list state and processing-time timers are the documented tools for buffering per key and for resuming work after a restart, and they survive a checkpoint without custom operator code.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| `AsyncDataStream.orderedWait` before the stitcher, reading every event | One read of the primary per event, against IDS-NFR-01. |
| `AsyncDataStream` before the stitcher with a cache of known identifiers | The cache cannot see clears, expiry, or restores, so some misses arrive with no read. Those need a synchronous fallback or give a wrong `canon_id`. |
| A custom operator that completes reads through the task mailbox | No polling, but it depends on Flink internals that the test harness does not cover, and it replaces a `KeyedProcessFunction` that the team knows. |
| Stop reading for a while after a run of failed reads | Bounds the stall during an outage, but a healthy slow database still holds the subtask on every miss. |

## Consequences

- A device's events wait while its read runs, and keep their order. Other devices are not held.
- Each stitcher subtask opens up to `IDENTITY_LOOKUP_CONCURRENCY` connections to the primary.
- A savepoint taken while reads wait holds those events. A version without this state does not publish them, so roll back from a savepoint taken while Postgres is healthy.
- Stop the job with a savepoint, without draining, so waiting events stay in state.

## Related

- [Identity stitching](../components/identity/identity-stitching.md)
- [0005. Keep live state in Flink and a durable copy in Postgres](0005-keep-live-state-in-flink.md)
- [0012. Resolve events without a device from the durable copy](0012-resolve-events-without-a-device-from-the-durable-copy.md)
- Apache Flink, [Asynchronous I/O for external data access](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/datastream/operators/asyncio/)
- Apache Flink, [Process function: timers](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/datastream/operators/process_function/)
