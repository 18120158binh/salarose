---
title: A journey instance is one entry
id: "0033"
status: accepted
date: 2026-10-21
tags: [journeys, state, flink, segments, business-events]
supersedes: []
superseded_by: []
---

# 0033. A journey instance is one entry

## Context

A journey instance is one person in one campaign, keyed by `canon_id` and `campaign_id`. A node completes at most once per instance, so a person goes through a campaign once, ever. The open question in journey execution, whether an instance can run more than once (UC-02), has waited on this.

Two new triggers need more than one pass. A person can get a price drop campaign for every price drop ([decision 0032](0032-fan-out-business-events-to-interested-people.md)). A segment entry trigger can let a person enter again when they qualify again ([decision 0031](0031-reusable-segments-with-entry-triggers.md)). The owner chose one entry per business event on 2026-10-21.

## Decision

A journey instance is one **entry**: one person's pass through one campaign, from its setup node. Its key is `canon_id`, `campaign_id`, and an entry id. The setup trigger carries the entry id:

| Setup trigger | Entry id | New entries |
|---|---|---|
| Person event | `first` | None. A person enters once, as today. |
| Segment entry | The `event_id` of the event at which the person entered | By the trigger's re-entry setting: never, every time, or once the last entry is at least a set period old |
| Business event | The business event's `event_id` | One per business event |

Kafka keys and Flink keys stay `canon_id` and `campaign_id`, so one subtask owns all of a person's entries in a campaign. A trigger for a node below the setup node carries no entry id and applies to each of the person's entries in that campaign, by the usual rules for each.

`user_campaign_state_transitions` rows, watch timers, and notification execution ids include the entry id.

The owner chose one entry per business event on 2026-10-21. The entry ids, applying later triggers to every entry, and the 20-entry cap were chosen while writing this record, and are pending owner review. The owner's choices are in the decision log, `~/.claude/scripts/state/decisions.tsv`, from the design session of 2026-10-21.

## Why

Making the entry the unit keeps every rule that holds per instance, such as "a node completes once", while letting a person pass again. The key stays the same, so state ownership and the topic layout do not change, and the entries of one person and campaign sit together in one keyed state, where the re-entry setting can see the earlier entries.

An entry id from the cause makes entries idempotent. A replayed business event, or two records for one person after an identity merge, carry the same entry id and so open one entry.

Applying later triggers to every entry is what a person expects. If two price drops are in flight and the person buys, the purchase moves both journeys along.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Keep one instance per person and campaign | A second price drop never reaches the person, which UC-08 forbids. |
| Key journey state by `canon_id`, `campaign_id`, and entry id | Spreads one person's entries over subtasks, so a re-entry setting cannot see earlier entries, and a later trigger would need to know every entry id. |
| Clear the instance when the journey ends, so the person can start over | Loses the history of completed nodes, and "ended" is not defined for a journey with a watch still pending. |

## Consequences

- `campaign_node_stats` counts entries. A person who enters twice counts twice at each node they reach.
- A person can have several entries open in one campaign. Journey execution caps them, with the oldest dropped first and counted.
- The outbox's execution id includes the entry id, so a sender that deduplicates sees two price drop messages as two.
- Identity merges fold entries by entry id. Two entries with the same id are one.
- The open question about running a journey more than once is answered for segment and business-event triggers. A campaign triggered by a person event still enters once.

## Related

- [Journey execution](../components/journey-execution.md)
- [Notification outbox](../components/notification-outbox.md)
- [Customer decision](../components/customer-decision.md)
- [0031. Reusable segments with entry triggers](0031-reusable-segments-with-entry-triggers.md)
- [0032. Fan out business events to interested people](0032-fan-out-business-events-to-interested-people.md)
