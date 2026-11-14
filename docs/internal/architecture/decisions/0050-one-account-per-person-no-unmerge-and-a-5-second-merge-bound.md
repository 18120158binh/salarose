---
title: One account per person, no unmerge, and a 5 second merge bound
id: "0050"
status: accepted
date: 2026-11-14
tags: [identity, graph, merge, limits]
supersedes: []
superseded_by: []
---

# 0050. One account per person, no unmerge, and a 5 second merge bound

## Context

The [identity graph contract](../components/identity/identity-graph.md) is a draft with six open questions: what happens when a second account logs in on a shared device, which identifier types get a limit, whether an operator can split a wrong merge, how fast every device must see a merge, how tenancy applies, and who reads the graph.

Today the platform merges two accounts that share a device. A household tablet joins two shoppers into one person, who then gets one set of metrics and one journey. [Decision 0047](0047-email-and-phone-are-guarded-match-keys-from-import-and-the-api.md) already refuses that merge when the link is an email or a phone.

How the graph is stored is a separate record that amends [decision 0005](0005-keep-live-state-in-flink.md), written after these answers, as the [identity overview](../components/identity/README.md#what-changes-when-the-drafts-are-accepted) says. This record does not choose the storage.

## Decision

1. **Shared devices: refuse the merge.** A set holds at most one `user_id`. When an event links two sets that each hold a `user_id`, the graph refuses the merge, counts it, and resolves the event to the set of its `user_id`. The device stays in the set it already belongs to. No identifier moves between sets.
2. **Limits.** `user_id` 1, `email` 5, `phone` 5. `domain_userid` has no limit of its own beyond the resolver's bound of 200 entries for each structure.
3. **No unmerge.** The graph offers no split. A wrong merge stays.
4. **Convergence bound: 5 seconds.** IDG-NFR-02 keeps 5 seconds, at the 99th percentile.
5. **Tenancy: one customer per deployment.** Identifiers and merge records carry no tenant, as [decision 0049](0049-the-ingestion-api-writes-plain-json-to-its-own-topic-and-leaves-history-to-import.md) records for the platform.
6. **Staff read the graph in customer lookup.** [Customer lookup](../../features/customer-lookup.md) shows a person's identifiers and merge history, read-only, with email and phone masked as [decision 0042](0042-keep-imported-contact-details-plain-behind-masking-and-tombstones.md) requires. Jobs read the graph through identity stitching only.

## Why

**Refuse, not merge or move.** Two accounts on one device are almost always two people: a family tablet, a shop's demo phone, a shared laptop. Merging them sends one shopper's cart reminders to the other and folds their journeys together, which [identity merges](../components/identity/identity-merges.md) cannot undo. [Segment Unify](https://www.twilio.com/docs/segment/unify/identity-resolution/identity-resolution-settings) handles it with a limit: when an event would bring a second `user_id` into a profile, it drops the event's lower-priority identifiers and resolves on the rest, and its [onboarding guide](https://www.twilio.com/docs/segment/unify/identity-resolution/identity-resolution-onboarding) advises a `user_id` limit of 1. [Amplitude](https://amplitude.com/docs/data/data-assistant-user-solutions/multiple-user-ids-engineering) never merges two established user ids. Moving the device to the last account would match the shopper on the device now, but it takes an identifier out of a set, which IDG-FR-12 forbids, and it flips back and forth on every login. Refusing keeps both people whole, and the event still reaches the right person through its `user_id`.

**Limits.** One `user_id` is the rule above. Five emails and five phones let a person change address or carry a work and a home address, and stop one value from pulling an unbounded number of anonymous sets together. Devices grow without anyone doing anything wrong: a cleared cookie or a new browser makes a new `domain_userid` for the same person, so a low device limit would refuse good merges. The 200-entry bound already caps a runaway set.

**No unmerge.** A split cannot unfold the state that jobs merged: metric buckets were added together, and journey instances were folded. Amplitude's unmap only removes a mapping going forward and restores no history. With a `user_id` limit of 1, the merge that most needs a split, two accounts, no longer happens. What remains is an anonymous device folded into an account, which is the purpose of the graph. A split needs its own contract if a customer shows a case.

**5 seconds.** With the limit, a merge almost always folds an anonymous set into a set that holds a `user_id`, and the `user_id` root wins by priority. Every device of the account keeps its `canon_id`. Only the members of the retired anonymous set change, and those are usually the one device that caused the merge, which sees the result at once. So the bound costs little in practice, and it is short enough that a journey step a few seconds after login sees one person.

**Tenancy and readers.** The owner chose one customer per deployment on 2026-11-05. Staff need to see why two ids are one person when a shopper asks, and the merge records exist for that. Customer lookup is the page where staff already find a person.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Merge two accounts on a shared device, as today | Joins two people, and folded state cannot be split. |
| Move the device to the last account | Breaks IDG-FR-12 and flips the device on every login. |
| A low `domain_userid` limit | Refuses good merges for people who clear cookies or use several browsers. |
| An operator split | Cannot unfold merged metrics and journeys, and the limit removes the main case for it. |
| A 1 minute bound, as the recheck gives today | Lets a journey see two people for a minute after a login, for a saving that is small once merges fold only anonymous sets. |
| Show the graph only to operators | Support questions come to staff, who use customer lookup. |

## Consequences

- A shopper who logs in to two accounts on one device stays two people. The device's anonymous history belongs to the first account that claimed it.
- The refused-merge count by type shows how often devices are shared.
- Customer lookup gains an identifiers and merges view. Its contract changes when that view is built.
- The storage record that amends decision 0005 can now be written.

## Related

- [Identity graph](../components/identity/identity-graph.md)
- [Identifiers](../components/identity/identifiers.md)
- [Identity merges](../components/identity/identity-merges.md)
- [Customer lookup](../../features/customer-lookup.md)
- [0047. Email and phone are guarded match keys, learned from imports and the API](0047-email-and-phone-are-guarded-match-keys-from-import-and-the-api.md)
