---
title: Identity graph
slug: identity-graph
purpose: Keep one record of every identity set, shared by every device and job, so that a merge recorded anywhere applies everywhere.
status: draft
implementation: planned
area: event-processor
tags: [identity, graph, merge, state]
created: 2026-10-21
updated: 2026-10-21
version: 0.1
known_issues: ../../../known-issues/components/identity/identity-graph.md
---

# Identity graph

## Purpose

Today each device keeps its own copy of its identity set. When a merge on one device changes a person's `canon_id`, the person's other devices learn of it by rechecking the user's rows once a minute ([decision 0021](../../decisions/0021-recheck-a-users-rows-to-carry-merges-to-the-users-devices.md)). Until then their events build metrics and journeys under the old id, and nothing records the merge itself. The identity graph is one record of which identifiers belong to which identity set, shared by every device and every job. A merge recorded anywhere applies to every later resolution, and the graph keeps the history of every merge. It also holds the rules that allow or refuse a merge. This contract is a draft. The [open questions](#open-questions) must have answers before it is accepted.

## Scope

In scope:

- The mapping from each identifier to its identity set and its `canon_id`.
- Recording merges, one at a time for each identity set.
- Merge rules: which `canon_id` wins, and when a merge is refused.
- Merge history: every retired `canon_id`, and the `canon_id` that replaced it.
- Lookups by identifier and by `canon_id`.

Out of scope:

- Identifier types and normalization. [Identifiers](identifiers.md) owns them.
- Resolving each event on the stream. [Identity stitching](identity-stitching.md) does that, and reads and writes the graph.
- Moving the state that jobs hold under a retired `canon_id`. [Identity merges](identity-merges.md) owns that.
- Deleting a person. Not specified yet. See [the overview](README.md#what-is-not-specified-yet).

## Terms

The [identity resolution overview](README.md#terms) defines identity set, `canon_id`, merge, winning `canon_id`, retired `canon_id`, and merge record.

| Term | Meaning |
|---|---|
| Causing event | The event whose identifiers linked two identity sets. |
| Linking identifiers | The identifiers on the causing event that belonged to the two sets. |
| Limit | The most identifiers of one type that one identity set may hold. |
| Refused merge | A merge that the rules do not allow. Both sets stay as they are. |
| Merge chain | A retired `canon_id` whose winner was itself retired later. `A` retired into `B`, then `B` into `C`. |

## Behavior

A household shares a tablet. The example uses the merge rules of [identity stitching](identity-stitching.md#merge) and no limits. Write `U(x)` for the derived root of `x`, and assume `U(u1)` sorts before `U(u2)`.

1. `u2` logs in on a laptop, device `dA`. The graph holds the set `{dA, u2}` with `canon_id` `U(u2)`.
2. `u2` logs in on a phone, device `dB`. The graph finds `u2` and adds `dB` to its set. The event gets `U(u2)`.
3. `u1` logs in on the tablet, device `dS`. The graph holds a second set `{dS, u1}` with `canon_id` `U(u1)`.
4. `u2` logs in on `dS`. The event links the two sets. Both roots are `user_id` roots, so the tie goes to the root that sorts first, and `U(u1)` wins. The graph records one merge: `U(u2)` retired into `U(u1)`.
5. The next event from `dA` gets `U(u1)`, and so does the next event from `dB`. Today `dA` and `dB` reach `U(u1)` at their first event after their next recheck, up to a minute later, and no record of the merge exists.

Whether step 4 should merge two accounts at all is an [open question](#open-questions). With a limit of one `user_id` for each set, the graph refuses the merge in step 4, both sets stay apart, and the event resolves to `U(u2)`, the set of its `user_id`.

## Algorithm

### Record a merge

When an event links two identity sets:

1. Find the root of each set.
2. If the roots are equal, the sets are already merged. Stop.
3. Check the limits. If the joined set would hold more identifiers of a type than that type's limit, refuse the merge. Count it and log both `canon_id` values. Stop.
4. Pick the winner by the [merge rules](identity-stitching.md#merge) of identity stitching. The higher priority wins, and on equal priority the root that sorts first as a string wins.
5. Point the retired root at the winning root. Every identifier of the retired set now resolves to the winning `canon_id`.
6. Write one merge record and publish it, as [identity merges](identity-merges.md) describes.

Steps 1 to 6 run as one change for both sets. No other change to either set runs between them.

### Follow a merge chain

A lookup by a retired `canon_id` follows the chain to the end and returns the current `canon_id`. `A` retired into `B` and `B` into `C` gives `C` for both `A` and `B`. A merge never splits a set, and a retired `canon_id` never names a set again, so the chain has no loop.

## Functional requirements

| Id | Requirement |
|---|---|
| IDG-FR-01 | Every identifier must belong to at most one identity set at a time. Every identity set must have exactly one `canon_id`. |
| IDG-FR-02 | The graph must apply changes to one identity set one at a time. Two merges that touch one set must give the same result as applying them one after the other, in the order the graph recorded them. |
| IDG-FR-03 | After the graph records a merge, every resolution of an identifier of either set must return the winning `canon_id`, within the bound in IDG-NFR-02. This holds for every device of the person, including a device whose identifiers are already in the resolver's state. |
| IDG-FR-04 | A lookup must see every merge that the graph recorded before the lookup started. |
| IDG-FR-05 | A lookup by a retired `canon_id` must return the current `canon_id` of its set, following any merge chain. |
| IDG-FR-06 | The graph must pick the winner of a merge by the rules of identity stitching (IDS-FR-02, IDS-FR-03), with the priority of each type from [Identifiers](identifiers.md#identifier-types). |
| IDG-FR-07 | The graph must refuse a merge that would break a limit. A refused merge must leave both sets as they are. The graph must count it and log it with both `canon_id` values. |
| IDG-FR-08 | The graph must keep one merge record for each merge, with the winning `canon_id`, the retired `canon_id`, the causing event's `event_id` and event time, the linking identifiers, and the time the graph recorded the merge. |
| IDG-FR-09 | Processing a causing event a second time must not record a second merge or change the winner. |
| IDG-FR-10 | The graph must not forget an identifier or a merge record because of inactivity. Only the deletion of a person, which is not specified yet, may remove them. |
| IDG-FR-11 | The graph must answer a lookup by identifier, and a lookup by `canon_id`, with the set's current `canon_id` and its identifiers. |
| IDG-FR-12 | A merge must never split a set. A retired `canon_id` must never name a set again. |

## Non-functional requirements

Numbers marked "proposed" are starting values for review, not decisions.

| Id | Requirement |
|---|---|
| IDG-NFR-01 | Resolving an identifier whose set has not changed must not query Postgres, as identity stitching requires today (IDS-NFR-01). |
| IDG-NFR-02 | After the graph records a merge, every resolution must return the winning `canon_id` within 5 seconds. Proposed. |
| IDG-NFR-03 | A recorded merge must survive a restart of any job, with or without a checkpoint. |
| IDG-NFR-04 | Lookups must read the copy where the graph records merges, never a replica that can lag it. |

## Interfaces

| Direction | Interface | Contract |
|---|---|---|
| In | Resolution requests from [identity stitching](identity-stitching.md) | The normalized identifiers of one event, and its `event_id` and event time |
| Out | The `canon_id` for a request | UUID string, or null for an event with no identifier |
| Read and write | Identity graph tables | Proposed. One row per identifier: type, value, `canon_id`. One row per merge record. They replace `identity_graph`, which holds one row per `domain_userid`. The decision record that chooses the storage names the tables. |
| Out | Kafka `identity-merges` | One message per merge record. [Identity merges](identity-merges.md#interfaces) defines the key and the message. |

## Failure handling

| Case | Behavior |
|---|---|
| The graph's store is unreachable, or a read times out | Resolve the event as identity stitching does after a failed read (IDS-FR-09). Record no merge. The next event that links the two sets records it. |
| The same causing event arrives twice | The second arrival finds the roots equal and records nothing (IDG-FR-09). |
| Two events link one set with two other sets at the same time | The graph applies the merges one after the other (IDG-FR-02). Each gets its own merge record. |
| A merge would break a limit | Refuse it, count it, and log both `canon_id` values (IDG-FR-07). |
| A job restarts without a checkpoint | The graph's durable copy holds every identifier and merge record (IDG-NFR-03). Resolvers read it on demand. |

## Acceptance criteria

- Given `(dA, u2)` resolved to `U(u2)`, when `u1` and then `u2` log in on a shared device `dS` and the graph retires `U(u2)` into `U(u1)`, then the next event `(dA, u2)` gets `U(u1)` within 5 seconds of the merge. (IDG-FR-03, IDG-NFR-02)
- Given a merge that retired `U(u2)` into `U(u1)`, when `u2` logs in on a new device `dN`, then the event gets `U(u1)`. (IDG-FR-04)
- Given `A` retired into `B` and then `B` into `C`, when a job looks up `A`, then the graph returns `C`. (IDG-FR-05)
- Given a merge recorded for causing event `e1`, when `e1` arrives again, then the graph holds one merge record for it, and the winner does not change. (IDG-FR-09)
- Given two events on two subtasks that each link set `S` with another set at the same moment, then every identifier of the three sets resolves to one `canon_id`, and the graph holds two merge records. (IDG-FR-01, IDG-FR-02)
- Given a device that sent its last event 30 days ago, when it sends an event, then it resolves to the current `canon_id` of its set. (IDG-FR-10)
- Given a limit of one `user_id` for each set, when `u2` logs in on a device in `u1`'s set, then the graph records no merge, the refused-merge count rises by 1, and the event gets the `canon_id` of `u2`'s set. (IDG-FR-07)
- Given a merge, then its record holds both `canon_id` values, the causing `event_id` and event time, the linking identifiers, and the time of the merge. (IDG-FR-08)
- Given a job restarted without a checkpoint, when a device of a merged set sends an event, then it gets the winning `canon_id`. (IDG-NFR-03)

## Open questions

- **Shared devices.** When a second account logs in on a device, should the graph merge the two accounts, as it does today, refuse the merge, or move the device to the account that logged in last? Platforms differ. Segment Unify gives each identifier type a limit and a priority. When an event would break a limit, it drops the event's lower-priority identifiers and resolves the event on the rest. Amplitude does not merge two different user ids. Moving a device takes an identifier out of a set, which IDG-FR-12 forbids today.
- **Limits.** Which types get a limit, and what is each value? Today no type has one, and the only bound is the 200 entries of a structure per device.
- **Unmerge.** Should an operator be able to split a wrong merge? Jobs fold state on a merge, as [identity merges](identity-merges.md) describes, and a split cannot unfold it. A split would need its own contract.
- **Convergence bound.** Is 5 seconds the right value for IDG-NFR-02? Today's recheck converges within 1 minute. A tighter bound costs more lookups or a faster way to tell resolvers about merges.
- **Tenancy.** With more than one customer on a deployment, every identifier and merge record belongs to a tenant. See [decision 0027](../../decisions/0027-multi-tenancy.md).
- **Who reads the graph.** Should `studio` show a person's identifiers and merge history to staff, for support and for checking a merge?

## Related

- [Identity resolution overview](README.md)
- [Identity stitching](identity-stitching.md)
- [Identifiers](identifiers.md)
- [Identity merges](identity-merges.md)
- [0002. Key every stateful write by its owner](../../decisions/0002-key-every-write-by-its-owner.md)
- [0005. Keep live state in Flink and a durable copy in Postgres](../../decisions/0005-keep-live-state-in-flink.md)
- [0012. Resolve events without a device from the durable copy](../../decisions/0012-resolve-events-without-a-device-from-the-durable-copy.md)
- [Known issues](../../../known-issues/components/identity/identity-graph.md)
- Segment Unify, [Identity resolution settings](https://www.twilio.com/docs/segment/unify/identity-resolution/identity-resolution-settings)
- Amplitude, [Track unique users](https://amplitude.com/docs/data/sources/instrument-track-unique-users)
