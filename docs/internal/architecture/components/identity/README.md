# Identity resolution

Identity resolution decides which person each event belongs to. One shopper uses a phone, a laptop, an account, and an email address. The platform must see one person, give that person one `canon_id`, and keep every metric, journey, and message under that id. That includes the moment the platform learns that two ids it treated as two people belong to one.

[Identity stitching](identity-stitching.md) does part of this today. It links a device to an account when an event carries both. The contracts in this folder cover the rest.

## The contracts

| Contract | What it decides | Contract | Implementation | Known issues |
|---|---|---|---|---|
| [Identifiers](identifiers.md) | Which ids the platform knows, the normalized form of each, and which ones may link two identity sets | Draft | Planned | [List](../../../known-issues/components/identity/identifiers.md) |
| [Identity stitching](identity-stitching.md) | How an event's identifiers resolve to a `canon_id`, and which root wins a merge | Accepted | Partial | [List](../../../known-issues/components/identity/identity-stitching.md) |
| [Identity graph](identity-graph.md) | One record of every identity set, shared by all devices and jobs, with the rules that allow or refuse a merge and the history of every merge | Draft | Planned | [List](../../../known-issues/components/identity/identity-graph.md) |
| [Identity merges](identity-merges.md) | What each job does with the metrics, journeys, and rows recorded under a `canon_id` that a merge retires | Draft | Planned | [List](../../../known-issues/components/identity/identity-merges.md) |

## How the contracts fit together

```mermaid
flowchart LR
	hit[Tracker hit or API event] --> norm[Normalize identifiers<br/>Identifiers]
	norm --> resolve[Resolve canon_id<br/>Identity stitching]
	resolve <--> graph[(Identity graph)]
	resolve --> parsed[snowplow-parsed<br/>event with canon_id]
	graph --> merges[identity-merges<br/>merge records]
	merges --> dec[Customer decision<br/>folds metrics]
	merges --> jex[Journey execution<br/>folds journey instances]
	dec --> prw[Profile writer<br/>user_metrics]
```

Event ingestion reads the identifiers from each hit and normalizes them by the rules in [Identifiers](identifiers.md). Identity stitching resolves them to a `canon_id` against the identity graph and records any merge the event causes. The graph publishes each merge, and the jobs that key state by `canon_id` move the retired id's state onto the winner by the rules in [Identity merges](identity-merges.md).

## What changes when the drafts are accepted

The accepted stitching contract describes the platform as it runs now. Each device keeps its own copy of its identity set. Since [decision 0021](../../decisions/0021-recheck-a-users-rows-to-carry-merges-to-the-users-devices.md), a device that holds a user rechecks the user's rows once a minute, so a merge on one device reaches the user's other devices within about a minute. Two problems remain:

- Merges are inferred, not recorded. Nothing says which `canon_id` retired into which, so a reader cannot map an old `canon_id` to the current one, and no rule can refuse a merge.
- Nothing announces a merge to later stages. After a login, the person's metrics restart from empty, and the person can pass a journey and get its messages a second time.

The identity graph and identity merges contracts address those. Both were accepted on 2026-11-14 ([decision 0050](../../decisions/0050-one-account-per-person-no-unmerge-and-a-5-second-merge-bound.md), [decision 0051](../../decisions/0051-fold-to-the-earliest-instance-and-count-nodes-through-merge-history.md)), and neither is built. When they are built, the stitching contract changes in the same change. Its algorithm reads and writes the graph, and its section "Merges reach the user's devices, not later stages" changes to say that merges reach later stages too.

How the graph is stored and keyed is an architecture choice, not a contract. It needs a decision record that amends [decision 0005](../../decisions/0005-keep-live-state-in-flink.md) for identity state. Their open questions now have answers, so that record can be written.

## What is not specified yet

These parts of identity resolution have no contract yet:

- **Profile unification.** The platform would keep one record of a person's attributes, with rules for which source wins when two disagree. Today another system fills `customer_profiles`, and jobs match it on `cdp_uuid`.
- **Consent and deletion.** Deleting a person must remove every identifier, metric, and journey instance under every `canon_id` the person ever had. The merge history in the [identity graph](identity-graph.md) is the input that work needs.
- **Probabilistic matching.** Matching people on IP address, device fingerprint, or name is not planned. A wrong merge sends one person's messages to another person, and matching only on ids that the customer's systems assign avoids most wrong merges.

## Terms

These terms have one meaning in every contract in this folder.

| Term | Meaning |
|---|---|
| Person | One human, as the platform knows them. |
| Identifier | A type and a normalized value that point at one person, such as (`user_id`, `usr_1001`). See [Identifiers](identifiers.md). |
| Identity set | The identifiers known to belong to one person. |
| `canon_id` | The id of an identity set. Every job keys its per-person state by it. |
| Merge | Joining two identity sets into one. One `canon_id` wins. The other is retired. |
| Winning `canon_id` | The `canon_id` of the set after a merge. |
| Retired `canon_id` | The `canon_id` that a merge replaced. It never names a set again. |
| Merge record | The record of one merge: the winning and retired `canon_id`, and what caused the merge. |
