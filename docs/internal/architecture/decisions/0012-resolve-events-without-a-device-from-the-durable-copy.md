---
title: Resolve events without a device from the durable copy
id: "0012"
status: proposed
date: 2026-10-18
tags: [identity, state, postgres, flink]
supersedes: []
superseded_by: []
---

# 0012. Resolve events without a device from the durable copy

## Context

The event parse job keys the identity stitcher by `domain_userid`, and by `user_id` when an event has no `domain_userid`. Events with only a `user_id`, often sent from a server, so got a structure of their own under the user's key. That structure read `identity_graph` once and then trusted its state for 7 days after the user's last such event, as [decision 0005](0005-keep-live-state-in-flink.md) prescribes for every live copy.

That made two deciders for one user's `canon_id`: the user's devices, and the user's own key. The devices write `identity_graph`. The user's key never does, and never reads it again. When a merge on a device changed the user's `canon_id`, events without a device kept the old one. This broke IDS-FR-05, and was tracked as IDS-KI-15.

The identity stitching contract did not say how these events resolve.

## Decision

An event with a `user_id` and no `domain_userid` keeps no stitcher state. It reads `identity_graph` for its `user_id` on every event, and takes the `canon_id` of the user's newest row, or the derived root of the `user_id` when there is no row. It writes no `identity_graph` row. An event with neither identifier reads nothing and keeps nothing.

The keying does not change. Such events still go to the subtask that owns the user's key, but that key no longer holds state.

This is an exception to [decision 0005](0005-keep-live-state-in-flink.md) for events without a device. Their durable copy is the only copy, and the devices own it.

## Why

Only one party should decide a user's `canon_id`. The devices already decide it and write it to `identity_graph`. An event without a device has nothing to add to the identity set, because it carries one identifier. So it can read the decision instead of making its own.

Established platforms do the same. They keep one identity graph and resolve each event that carries a user id against it, without a second per-user store that can drift:

- Segment Unify matches the identifiers on each incoming event against its identity graph, then attaches the event to the matching profile, creates one, or merges by its rules.
- mParticle IDSync resolves the identifiers of a request to one MPID through its identity API. A partial match adds identifiers to the matched profile.
- Amplitude resolves `user_id` and `device_id` to one Amplitude ID. It prefers the user id, because several users can share a device, and it records merges in a merged-users table that its queries apply.
- Snowplow's dbt packages and RudderStack Profiles stitch in the warehouse. A mapping table holds the latest `user_id` for each device, and the `user_id` itself is the stitched id when no mapping exists.

None of them keeps a cache for user-id-only events that ignores a later merge. Our `identity_graph` is that mapping table, with an index on `(user_id, updated_at desc)` that covers the lookup.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Keep the user's state with a short TTL | It bounds the drift by the TTL but keeps a second decider. A TTL that is short enough to matter reads almost as often as a read per event, and Flink sets one TTL per state, so the device state would need a second state for the user. |
| Re-key the stitcher by `user_id` | An anonymous device has no `user_id`, and its later events must follow its login. Keying by user only moves the split to the device side, changes the key of every structure, and needs a fresh start or a state migration. |
| Keep state and read `identity_graph` again after an interval | Bounds the drift but keeps two deciders, and adds a timer or a timestamp to state for one class of events. A read per event is simpler and leaves no drift beyond the sink's batch interval. |
| Announce merges to the user's key | Needs a merge record keyed by `user_id`, a new stream, and replay rules. It is the fix direction of IDS-KI-17 for devices. If that lands, these events could keep state again and listen to it. |

## Consequences

- Each event without a `domain_userid` costs one indexed read of the primary. On a stream with many server-side events, this sets a floor on lookups, and it holds the subtask while the read runs, which IDS-KI-12 already records. Moving the lookup off the stream's thread, the fix direction of IDS-KI-12, covers both. If load needs it later, a read-through cache with a TTL near the sink's batch interval would cut reads and keep the drift that small.
- A failed read gives the derived root of the `user_id`, because there is no state to fall back on. Before, such an event fell back to its user's state.
- These events miss a row that is not written yet, for at most one write batch. Device lookups keep the longer miss that IDS-KI-16 records.
- The structures of the user's devices are unchanged, so a merge still does not reach other devices in state (IDS-KI-17).
- State already stored under user keys is no longer read or written. It expires through its 7-day TTL.

## Related

- [Identity stitching](../components/identity/identity-stitching.md)
- [Identity stitching known issues](../../known-issues/components/identity/identity-stitching.md)
- [0002. Key every stateful write by its owner](0002-key-every-write-by-its-owner.md)
- [0005. Keep live state in Flink and a durable copy in Postgres](0005-keep-live-state-in-flink.md)
- Segment Unify, [Identity resolution](https://www.twilio.com/docs/segment/unify/identity-resolution)
- mParticle, [Web IDSync](https://docs.mparticle.com/developers/sdk/web/idsync)
- Amplitude, [Track unique users](https://amplitude.com/docs/data/sources/instrument-track-unique-users)
- Snowplow, [Identity stitching](https://docs.snowplow.io/docs/modeling-your-data/modeling-your-data-with-dbt/package-features/identity-stitching/)
- RudderStack, [Identity stitching](https://rudderstack.com/docs/profiles/identity-stitching)
