---
title: Recheck a user's rows to carry merges to the user's devices
id: "0021"
status: proposed
date: 2026-10-18
tags: [identity, state, postgres, flink]
supersedes: []
superseded_by: []
---

# 0021. Recheck a user's rows to carry merges to the user's devices

## Context

Each device keeps its own identity set in keyed state and trusts it once seeded ([decision 0005](0005-keep-live-state-in-flink.md)). When a merge on one device, such as a shared device where two accounts log in, changed a user's `canon_id`, the user's other devices never read the newer `identity_graph` row. They kept the old root for as long as they stayed active (IDS-KI-17). A device whose first read came before another device's row was written kept the older root the same way (IDS-KI-16). Events without a device took the root of whichever device wrote last, so they switched between the two. Metrics and journeys then grew under two ids for one person, which breaks IDS-FR-05.

The owner asked for every known issue to be fixed. The owner did not choose how merges reach other devices. Announcing a merge keyed by `user_id`, through a side output looped back or a CDC read of `identity_graph`, was the fix direction recorded in the known issues, and it was weighed here as one option.

## Decision

A device whose set holds a `user_id` reads `identity_graph` again once its last read is `IDENTITY_RECHECK_INTERVAL` old, 1 minute by default. Every lookup now reads the device's row and up to 10 of the user's newest rows in one query. After seeding new identifiers as before, the resolver joins the user's identifier with the `canon_id` on each of those rows, as a merge by priority. Each such root names a set that holds the user, so the join is the merge that the other device already made. User roots all have priority 3, so the root that sorts first wins on every device, and the devices converge. Events without a device do the same join, so they take the converged root.

A recheck that fails keeps the device's state and restarts the interval. A read that misses an identifier still fails as before.

The recheck, its 1-minute default, the 10-row limit, and the join of the user's rows were chosen during the fix for IDS-KI-16 and IDS-KI-17. They are pending owner review.

## Why

Stitching systems keep devices coherent in one of two ways. Segment Unify, mParticle IDSync, and Amplitude resolve each event against one central identity graph, so a merge is visible to the next event. Snowplow and RudderStack recompute the stitched id from a mapping table. Per-device caches like ours stay coherent either by invalidation messages, often driven by change data capture, or by bounded staleness, where a cached entry is re-read after a fixed time.

An announcement inside this job needs a cycle from the stitcher back to itself. Flink 2.2 has no DataStream iteration: `IterativeStream` is gone from `flink-streaming-java` 2.2.0, after FLIP-357 deprecated it. So the loop has to leave the job:

- A Kafka topic of merges needs a new topic, a sink, a source, an operator keyed by `user_id` that remembers each user's devices with a TTL matched to device state, and a two-input stitcher. A device that sends only anonymous events would stop refreshing that index and miss later merges.
- A CDC read of `identity_graph` needs a replication slot on the job's busiest table. The slot decodes every upsert, one per event, on one reader, and holds WAL while the job is down. The deployment notes already spend pages on slot hygiene for quiet tables.

A recheck needs neither. It reuses the lookup path that [decision 0020](0020-read-the-identity-graph-off-the-streams-thread-inside-the-stitcher.md) moved off the stream's thread, and the index on `(user_id, updated_at desc)` that already covers it. It also fixes IDS-KI-16 with the same code: a row written after a device's read is in the next recheck. It heals itself after lost messages, restarts, and expired state, because each recheck reads the durable copy afresh. The price is staleness of up to one interval and one write batch, and one read per active logged-in device per interval.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Announce merges through a Kafka topic and a `user_id`-keyed device index | Seconds instead of a minute, but a new topic, two connectors, a new keyed operator, and a two-input stitcher. The device index drifts from device state for devices that send anonymous events. |
| Announce merges through a CDC read of `identity_graph` | A replication slot on a table written once per event, decoded on one reader, holding WAL while the job is down. |
| Re-key the stitcher by `user_id` | Rejected in [decision 0012](0012-resolve-events-without-a-device-from-the-durable-copy.md): anonymous devices have no `user_id`, and the key change needs a fresh start. |
| Recheck only the user's newest row | Each active device keeps rewriting its own row, so the newest row is often the device's own stale root, and the devices never converge. |
| Rewrite `canon_id` downstream through an alias table keyed by `canon_id` | Fixes published ids without touching device state, but chains of merges need more than one hop, which again needs a loop. |

## Consequences

- All devices of a user resolve to one `canon_id` within one recheck interval and one write batch of the last merge. IDS-FR-05 and IDS-NFR-01 now say so.
- Events without a device take the root the user's rows join into, not the newest row's, as [decision 0012](0012-resolve-events-without-a-device-from-the-durable-copy.md) described.
- The primary gets about one more read per active logged-in device per interval, on the stitcher's lookup threads.
- Later stages still learn nothing of a merge. State under the old `canon_id` stays there.
- A shared device, such as a kiosk, joins every account that signs in on it, as before. The recheck now carries that joined root to every other device of each of those accounts within one interval. Before, the joined root stayed on the shared device and on new devices. This makes the shared-device open question in the contract weigh more.
- If the interval proves too slow, an announcement can be added later without changing the join, because the join is idempotent and commutative.

## Related

- [Identity stitching](../components/identity/identity-stitching.md)
- [0005. Keep live state in Flink and a durable copy in Postgres](0005-keep-live-state-in-flink.md)
- [0012. Resolve events without a device from the durable copy](0012-resolve-events-without-a-device-from-the-durable-copy.md)
- [0020. Read the identity graph off the stream's thread inside the stitcher](0020-read-the-identity-graph-off-the-streams-thread-inside-the-stitcher.md)
- Apache Flink, [FLIP-357: Deprecate Iteration API of DataStream](https://cwiki.apache.org/confluence/spaces/FLINK/pages/263427544/FLIP-357+Deprecate+Iteration+API+of+DataStream)
- Segment Unify, [Identity resolution](https://www.twilio.com/docs/segment/unify/identity-resolution)
- Snowplow, [What latency should I expect from real-time identity resolution?](https://snowplow.io/snowplow-frequently-asked-questions/what-latency-should-i-expect-from-real-time-identity-resolution)
