---
title: Identity merges
slug: identity-merges
purpose: When a merge retires a canon_id, move every job's state under it onto the winner, so that jobs count one person once and the person passes each journey node once.
status: draft
implementation: planned
area: event-processor
tags: [identity, merge, state, journeys, metrics]
created: 2026-10-21
updated: 2026-10-21
version: 0.1
known_issues: ../../../known-issues/components/identity/identity-merges.md
---

# Identity merges

## Purpose

Every job keys its per-person state by `canon_id`. When a merge retires a `canon_id` today, the metrics, journey instances, and rows under it stay where they are. The person's metrics restart from empty under the winning `canon_id`, and the person can pass a journey's nodes and get its messages a second time. This contract announces each merge and says how each job moves the retired `canon_id`'s state onto the winner. After a merge, metric conditions see all of the person's events, and each node of a campaign completes once for the person. This contract is a draft. The [open questions](#open-questions) must have answers before it is accepted.

## Scope

In scope:

- The merge record on `identity-merges`: its key, its fields, and its delivery.
- Folding metrics in [customer decision](../customer-decision.md) and the rows in `user_metrics`.
- Folding journey instances in [journey execution](../journey-execution.md), with their watch timers.
- Counting a merged person once in `campaign_node_stats`.
- Records that reach a job under a retired `canon_id` after the merge.

Out of scope:

- Deciding when sets merge and which `canon_id` wins. The [identity graph](identity-graph.md) does that.
- Rewriting history. Events in `snowplow-parsed` keep the `canon_id` they were published with. A reader maps a past `canon_id` to the current one through the graph's merge history (IDG-FR-05).
- Messages sent before the merge. The platform does not recall them.
- Profile attributes in `customer_profiles`. Another system owns them.
- Undoing a merge. The [identity graph](identity-graph.md) offers no split ([decision 0050](../../decisions/0050-one-account-per-person-no-unmerge-and-a-5-second-merge-bound.md)).

## Terms

The [identity resolution overview](README.md#terms) defines merge, winning `canon_id`, retired `canon_id`, and merge record. The [identity graph](identity-graph.md#terms) defines causing event.

| Term | Meaning |
|---|---|
| Fold | To add the state a job holds under a retired `canon_id` into its state under the winning `canon_id`, by the rules on this page. |
| Redirect | To handle a record that reaches a job under a retired `canon_id` as if it carried the winning `canon_id`. |
| Applied merge | A merge that a job has folded. From then on, the job redirects the retired `canon_id`. |

## Behavior

A shopper browses on a phone without logging in. The phone's `canon_id` is `C1`. The campaign "abandoned cart recovery" has a setup node `n1_view` on `view_product`, and an SMS after it.

1. At 10:00 the phone sends `view_product`. `n1_view` completes for `C1`, and the SMS goes out. The metric `m_view_count` for `C1` holds 3 occurrences.
2. The shopper already has an account, `usr_1001`, used on a laptop. Its `canon_id` is `C2`. `m_view_count` for `C2` holds 2 occurrences. `C2` has no instance of this campaign.
3. At 10:05 the shopper logs in on the phone and views another product. The graph retires `C1` into `C2` and publishes a merge record.
4. Customer decision folds `C1` into `C2`. `m_view_count` for `C2` now holds the 5 earlier occurrences, then the new view makes 6.
5. Journey execution moves `C1`'s instance of the campaign to `C2`, unchanged. The view at 10:05 gives a trigger for `n1_view` under `C2`, and the engine ignores it, because the node has already completed for this person.

Without this contract, step 4 starts `C2`'s count from 2, and step 5 completes `n1_view` a second time and sends the SMS again.

When both `canon_id` values have an instance of one campaign, which instance survives is an [open question](#open-questions).

## Algorithm

### Publish a merge

The identity graph publishes one merge record for each merge to `identity-merges`, keyed by the retired `canon_id`. The record carries the fields in [Interfaces](#interfaces). A retired `canon_id` is retired once (IDG-FR-12), so the `merge_id` is derived from the retired `canon_id`, and every copy of one merge has the same `merge_id`.

### Apply a merge in a job

Each job that keys state by `canon_id` applies each merge record once:

1. Fold the retired `canon_id`'s state into the winning `canon_id`'s state, by the rules for that job below.
2. Remove the state under the retired `canon_id`, and remember that it redirects to the winner.
3. Apply the causing event, and every later record of the winner, against the folded state.
4. Redirect every later record that arrives under the retired `canon_id`.

When a merge record's winner is itself retired in the job, the job applies the record to the end of the chain. Merge records that form a chain give the same state in any order of arrival.

### Fold metrics

Customer decision folds a person's metrics this way. The result is the series that counting the occurrences of both `canon_id` values into one would give, because a series depends only on which occurrences were counted (DEC-FR-26).

1. For each metric, add the two series bucket by bucket. Two buckets with the same size and start become one. To join them, add their counts and sums, keep the smaller minimum and the larger maximum, keep the two newest of their newest occurrences, and merge their summaries.
2. Set the series clock to the later of the two clocks. Merge the buckets that are now too old for their size, and drop the buckets past the retention period, as [customer decision](../customer-decision.md#buckets) does for a new event.
3. Set the person's behavior version to one more than the higher of the two versions.
4. Keep the most recent 512 event ids of both persons as the winner's recent event ids, newest event time first.
5. Emit one mutation for the winner with every series the fold changed, and one mutation that retires the retired `canon_id`'s rows.

### Fold stored metrics

The [profile writer](../profile-writer.md) writes the winner's mutation as any other mutation. On the retire mutation, it removes every `user_metrics` row of the retired `canon_id`. A mutation for the retired `canon_id` that arrives after the retire mutation, such as a replay, must not write a row.

### Fold journey instances

Journey execution folds each campaign separately:

- If only the retired `canon_id` has an instance, the instance becomes the winner's instance, unchanged. Its completed nodes, buffered triggers, and watch deadlines move with it.
- If only the winner has an instance, nothing changes.
- If both have an instance, the rule is an [open question](#open-questions).

Entries fold by entry id ([decision 0033](../../decisions/0033-a-journey-instance-is-one-entry.md)). Entries with different ids both move to the winner. Two entries with the same id, such as one business event that reached both `canon_id` values, are one entry, and the open question above decides which survives.

### Fold segment flags

Customer decision keeps the winner's flag for each tracked segment, or the retired `canon_id`'s flag where the winner has none. A fold publishes no membership change and starts no entry. The person's next event evaluates every tracked segment as usual.

A fold publishes no node completion. Journey execution published each node that completed under the retired `canon_id` when it completed, so moving the node must not publish it again, and the [notification outbox](../notification-outbox.md) sends nothing for it.

A watch timer of a moved instance keeps its deadline and fires for the winner. A timer of an instance that the fold drops must not emit a trigger.

### Count nodes once

`campaign_node_stats` counts each person once per node and branch, counting `user_campaign_state_transitions` rows under every `canon_id` the person had. How it maps retired ids, by rewriting rows or by reading the merge history, is an [open question](#open-questions).

## Functional requirements

| Id | Requirement |
|---|---|
| IMG-FR-01 | The identity graph must publish each merge record to `identity-merges`, keyed by the retired `canon_id`, with the fields in [Interfaces](#interfaces). |
| IMG-FR-02 | Every copy of one merge must carry the same `merge_id`. A job that applies a merge record twice must end in the same state as after applying it once. |
| IMG-FR-03 | Merge records that form a chain must give the same state in any order of arrival. |
| IMG-FR-04 | Customer decision must fold the retired `canon_id`'s series into the winner's series by the rules in [Fold metrics](#fold-metrics). |
| IMG-FR-05 | After a fold, the winner's behavior version must be higher than both versions before the fold. |
| IMG-FR-06 | Customer decision must evaluate the causing event against the folded metrics. |
| IMG-FR-07 | After a fold, `user_metrics` must hold no row for the retired `canon_id`. A later mutation for the retired `canon_id` must not create one. |
| IMG-FR-08 | Journey execution must move an instance that exists only under the retired `canon_id` to the winner, with its completed nodes, buffered triggers, and watch deadlines unchanged. |
| IMG-FR-09 | Once a job has applied a merge, a node that completed for the person under either `canon_id` must not complete again in that campaign. |
| IMG-FR-10 | A fold must not publish a node completion. |
| IMG-FR-11 | A watch timer of an instance that a fold drops must not emit a trigger. A moved instance's timers must fire for the winner at their original deadlines. |
| IMG-FR-12 | After a job applies a merge, it must redirect every record that arrives under the retired `canon_id`, for as long as the job keeps state for a person. |
| IMG-FR-13 | `campaign_node_stats` must count a merged person once per node and branch. |
| IMG-FR-14 | Events already published must keep the `canon_id` they were published with. |

## Non-functional requirements

Numbers marked "proposed" are starting values for review, not decisions.

| Id | Requirement |
|---|---|
| IMG-NFR-01 | Every job must apply a merge within 10 seconds after the identity graph records it. Proposed. |
| IMG-NFR-02 | Kafka delivers merge records at least once. Jobs make them idempotent by `merge_id`, as [decision 0006](../../decisions/0006-at-least-once-delivery-with-idempotent-writes.md) requires of every write. |
| IMG-NFR-03 | A fold must stay within the bounds the job already has: the bucket limit of each series, the 512 recent event ids, and the trigger buffer limits of journey execution. |

## Interfaces

| Direction | Interface | Contract |
|---|---|---|
| Out, from the identity graph | Kafka `identity-merges` | Key: the retired `canon_id`. Message below. |
| In | Customer decision, journey execution | Read `identity-merges`. |
| Out | Kafka `customer-profile-mutations` | The fold mutation for the winner, and a retire mutation for the retired `canon_id`. The retire mutation is a new message kind. The [customer decision](../customer-decision.md#interfaces) contract defines its shape when this contract is accepted. |
| Write | `user_metrics` | The profile writer removes the rows of a retired `canon_id`. |
| Read | `user_campaign_state_transitions`, `campaign_node_stats` | Node counts across merged ids. |

The merge record:

```json
{
	"merge_id": "5b1d6f0e-8c3a-3e2f-9d41-0a7c2e9b4f13",
	"retired_canon_id": "2f6a1c9e-0000-3000-8000-000000000001",
	"winning_canon_id": "7e9d0c1b-0000-3000-8000-000000000000",
	"cause_event_id": "6b0c8f3e-1d2a-4c55-9a77-1f0e2d3c4b5a",
	"cause_event_timestamp": "2026-10-21T10:05:12.400Z",
	"linking_identifiers": [
		{ "type": "user_id", "value": "usr_1001" },
		{ "type": "domain_userid", "value": "cookie_phone" }
	],
	"merged_at": "2026-10-21T10:05:12.611Z"
}
```

## Failure handling

| Case | Behavior |
|---|---|
| The same merge record arrives twice | The second copy changes nothing (IMG-FR-02). |
| The records of a chain arrive out of order | The job applies each to the end of the chain, and ends in the same state (IMG-FR-03). |
| A merge record for a `canon_id` the job holds no state for | The job only starts redirecting it. |
| A record under the retired `canon_id` arrives after the merge | The job redirects it to the winner (IMG-FR-12). This covers late events, mutations in flight, and watch timers. |
| A job restarts without a checkpoint | It has lost its redirects. On a state miss for a `canon_id`, it asks the identity graph for the current `canon_id` (IDG-FR-05) before it loads anything. |
| A replayed mutation for a retired `canon_id` reaches the profile writer | It writes nothing (IMG-FR-07). |

## Acceptance criteria

- Given a merge that retires `C1` into `C2`, then `identity-merges` holds a record keyed by `C1` with both `canon_id` values, the causing event's id and time, the linking identifiers, and `merged_at`. (IMG-FR-01)
- Given a merge record applied once, when the same record arrives again, then every job's state is unchanged. (IMG-FR-02)
- Given merges `A` into `B` and `B` into `C`, when a job receives the second record first, then after both it holds all of `A`'s and `B`'s state under `C`. (IMG-FR-03)
- Given `m_view_count` with 3 occurrences under `C1` and 2 under `C2`, when `C1` is retired into `C2`, then the series under `C2` counts 5 occurrences. (IMG-FR-04)
- Given a minute bucket at 10:05 with count 2 under `C1` and the same minute with count 1 under `C2`, when `C1` is folded into `C2`, then the folded series has one 10:05 bucket with count 3. (IMG-FR-04)
- Given behavior versions 7 under `C1` and 4 under `C2`, when `C1` is folded into `C2`, then the winner's behavior version is 8. (IMG-FR-05)
- Given a rule `m_view_count COUNT >= 5` on `view_product`, 3 views under `C1` and 1 under `C2`, when the causing event is a view under `C2`, then the rule fires for that event. (IMG-FR-06)
- Given `user_metrics` rows for `C1`, when `C1` is retired into `C2` and the profile writer then receives a replayed mutation for `C1`, then `user_metrics` holds no row for `C1`. (IMG-FR-07)
- Given an instance of campaign `CAMP-0001` only under `C1`, with `n1_view` completed and a watch deadline at 10:16, when `C1` is retired into `C2` at 10:05, then `C2`'s instance has `n1_view` completed and a watch deadline at 10:16. (IMG-FR-08, IMG-FR-11)
- Given `n1_view` completed under `C1`, when `C1` is retired into `C2` and the causing event gives a trigger for `n1_view` under `C2`, then `n1_view` does not complete again and the outbox sends nothing. (IMG-FR-09, IMG-FR-10)
- Given a moved instance, then `user_campaign_state_transitions` gets no new row from the fold. (IMG-FR-10)
- Given an applied merge of `C1` into `C2`, when a late event under `C1` arrives, then customer decision counts it in `C2`'s series. (IMG-FR-12)
- Given `n1_view` completed on `next` under `C1` before the merge, then after the merge `campaign_node_stats` counts the person once for `n1_view` on `next`. (IMG-FR-13)
- Given an event published under `C1` before the merge, then it still carries `C1` in `snowplow-parsed`. (IMG-FR-14)

## Open questions

- **Two instances of one campaign.** When both `canon_id` values have an instance, which survives? The options are the instance that started first, the instance further along, the winner's instance, or one instance that holds the completed nodes of both where their branches agree. Whatever the choice, IMG-FR-09 holds.
- **The window before a fold.** Between the moment the graph records a merge and the moment a job folds it, the winner's events from other devices can complete a node that the retired instance already completed. Must journey execution hold the winner's triggers until the fold, or is a second completion in that window accepted? IMG-NFR-01 bounds the window either way.
- **Rules that a fold satisfies.** A fold can make a metric condition true, for example a count that crosses 5. Today a rule with only a metric condition is a candidate only when an event changes its metric. Should the fold count as such a change, or wait for the next event?
- **Node counts.** Should a fold rewrite the retired `canon_id`'s rows in `user_campaign_state_transitions` to the winner, or should `campaign_node_stats` read the merge history? Rewriting changes rows that analysts may already have read. Reading the history adds a join to every count.
- **Two accounts in one person.** If the graph merges two accounts, as it does on a shared device today, the person has two `cdp_uuid` matches in `customer_profiles`. Which profile do conditions and messages use?

## Related

- [Identity resolution overview](README.md)
- [Identity graph](identity-graph.md)
- [Identity stitching](identity-stitching.md)
- [Customer decision](../customer-decision.md)
- [Profile writer](../profile-writer.md)
- [Journey execution](../journey-execution.md)
- [Notification outbox](../notification-outbox.md)
- [0004. Compute metrics and decisions in one keyed job](../../decisions/0004-compute-metrics-and-decisions-in-one-keyed-job.md)
- [0006. At-least-once delivery with idempotent writes](../../decisions/0006-at-least-once-delivery-with-idempotent-writes.md)
- [0011. The first trigger to arrive completes a node](../../decisions/0011-the-first-trigger-to-arrive-completes-a-node.md)
- [Known issues](../../../known-issues/components/identity/identity-merges.md)
