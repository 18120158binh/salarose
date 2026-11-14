---
title: Fold to the earliest instance, accept the fold window, and count nodes through merge history
id: "0051"
status: accepted
date: 2026-11-14
tags: [identity, merge, journeys, metrics]
supersedes: []
superseded_by: []
---

# 0051. Fold to the earliest instance, accept the fold window, and count nodes through merge history

## Context

The [identity merges contract](../components/identity/identity-merges.md) folds every job's state under a retired `canon_id` into the winner. It is a draft with five open questions:

1. When both `canon_id` values have an instance of one campaign, which survives?
2. Between the graph recording a merge and a job folding it, must journey execution hold the winner's triggers, or is a second completion in that window accepted?
3. Does a fold that makes a metric condition true count as a change that makes a rule a candidate?
4. Should a fold rewrite `user_campaign_state_transitions` rows to the winner, or should `campaign_node_stats` read the merge history?
5. Which profile do conditions use when one person holds two accounts?

[Decision 0050](0050-one-account-per-person-no-unmerge-and-a-5-second-merge-bound.md) settled that a set holds one `user_id`. With it, a merge folds an anonymous set into a set that holds an account, or two anonymous sets together.

## Decision

1. **The instance that started first survives.** An instance is one entry ([decision 0033](0033-a-journey-instance-is-one-entry.md)). When both `canon_id` values have an entry with the same entry id, or entries the segment re-entry setting would not allow for one person (`never`, or `after` within the period), journey execution keeps the one with the earlier entry time, on a tie the one whose `canon_id` sorts first. It drops the other: its watch timers emit nothing, and its buffered triggers are discarded. The dropped instance's completed node ids join the survivor as completed-elsewhere guards, so no node that completed under either `canon_id` completes again (IMG-FR-09). They do not move the survivor along. Entries with different ids that re-entry allows, such as two business events, all move to the winner.
2. **The window is accepted.** Journey execution does not hold triggers until a fold. A node that completes a second time inside the window is counted by campaign and node. IMG-NFR-01 keeps the window to 10 seconds.
3. **A fold is not a change.** A fold makes no rule a candidate. A rule whose condition the fold made true is checked at the person's next event that changes its metric. The causing event is evaluated against the folded state as IMG-FR-06 says.
4. **Read the merge history.** Transition rows keep the `canon_id` they were written with. `campaign_node_stats` maps each row's `canon_id` to its current `canon_id` through the merge records, and counts each person once per node and branch.
5. **Two accounts no longer reach one person.** Decision 0050 refuses that merge, so every set matches at most one `cdp_uuid`. The platform has never run in production, so no merged account pair exists to repair.

## Why

**Earliest instance.** The earlier instance is the journey the person actually started, and its messages are the ones they already got. Keeping it makes the next message follow the last one. "Further along" has no order across branches: a node on one branch is not ahead of a node on another. "The winner's instance" depends on root priority, which says which id names the set, not which journey is real. Merging the two instances node by node needs a rule for every pair of branches and every buffered trigger, and its result would be a path neither journey took. The guard keeps IMG-FR-09 without that: a node done anywhere is done. The rule depends only on the two instances, so every replay reaches the same survivor ([decision 0006](0006-at-least-once-delivery-with-idempotent-writes.md)).

**Accept the window.** Holding triggers would delay every event of every person who might be merged, which is anyone with an account, to protect against a race that needs the same node to complete on two devices within seconds of a login. The bound of 10 seconds and decision 0050's 5 second graph bound make that rare, and the count shows whether it happens. As an analogy, [Braze](https://www.braze.com/docs/user_guide/data/user_data_collection/user_profile_lifecycle/#merging-duplicate-users) merges duplicate profiles as a step of its own, after each profile has already acted on its events.

**A fold is not a change.** A fold is a login, not a behavior. Firing a rule on it would send "you viewed 5 products" the moment someone logs in, for views they made before. The next event that changes the metric fires it, which is how [decision 0029](0029-model-a-rule-as-a-trigger-and-person-conditions.md) defines a candidate, and the person's next action comes within the session that caused the merge.

**Merge history, not rewrites.** Transition rows are an append-only log that [decision 0035](0035-compute-journey-analytics-from-transitions-on-read.md) reads on demand. Rewriting them changes rows analysts may have exported, makes the fold a large write in the sink path, and breaks IMG-FR-14's rule that published records keep their `canon_id`. The merge records already exist (IDG-FR-08), and one retired-to-current map is small next to the transition table.

**Two accounts.** This follows from decision 0050.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Keep the instance further along | No order across branches. |
| Keep the winner's instance | Root priority says which id names the set, not which journey the person is in. |
| Merge the two instances node by node | A rule for every branch pair and buffered trigger, producing a path neither journey took. |
| Hold the winner's triggers until the fold | Delays every event of every account holder for a rare race. |
| Treat a fold as a change | Sends behavior messages at login, for behavior already past. |
| Rewrite transition rows to the winner | Changes exported rows, makes a large write in the sink path, and breaks IMG-FR-14. |

## Consequences

- Journey execution keeps a set of completed-elsewhere node ids on an instance, which counts toward its state bounds (IMG-NFR-03).
- A second completion inside the fold window can send a message twice. The count by campaign and node measures it.
- `campaign_node_stats` joins transitions to a retired-to-current map built from the merge records.
- The merges contract can be accepted. The identity stitching contract changes when the graph and merges are built, as the [identity overview](../components/identity/README.md#what-changes-when-the-drafts-are-accepted) says.

## Related

- [Identity merges](../components/identity/identity-merges.md)
- [Identity graph](../components/identity/identity-graph.md)
- [0033. A journey instance is one entry](0033-a-journey-instance-is-one-entry.md)
- [0035. Compute journey analytics from transitions on read](0035-compute-journey-analytics-from-transitions-on-read.md)
- [0050. One account per person, no unmerge, and a 5 second merge bound](0050-one-account-per-person-no-unmerge-and-a-5-second-merge-bound.md)
