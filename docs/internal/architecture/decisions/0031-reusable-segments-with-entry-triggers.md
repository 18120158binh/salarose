---
title: Reusable segments with entry triggers
id: "0031"
status: accepted
date: 2026-10-21
tags: [segments, rules, journeys, studio]
supersedes: []
superseded_by: ["0038"]
---

# 0031. Reusable segments with entry triggers

> Superseded in part by [decision 0038](0038-store-segment-membership-and-evaluate-every-segment.md). The decision job now keeps a membership flag for every segment, not only those an entry trigger or audience uses, and membership is stored so that studio shows a segment's size. A segment-entry journey now starts only when the job sees a person go from out to in, so people who are members when the campaign is published do not enter at their next event. They enter once, paced, only if the marketer chooses **Also include current members** at publish. A segment's metrics stay `LIVE` while the segment exists, not only while an active campaign uses it. Live evaluation of `segment_membership` conditions, entry at events, the re-entry modes, and the ban on nested segments stay.

## Context

Every journey node carries its own conditions ([decision 0029](0029-model-a-rule-as-a-trigger-and-person-conditions.md)). A marketer who means "VIP shoppers in Hanoi" in ten campaigns writes the same conditions ten times, and has to change all ten when the definition changes. A campaign also cannot start when a person comes to match such a definition, only on an event.

The owner asked for segments that users configure, used both to start campaigns and as conditions, on 2026-10-21.

## Decision

A segment is a saved, named list of condition groups, of the same types a node uses: `profile_property` and `behavior`. Staff manage segments in `studio`. A segment cannot reference another segment.

Campaigns use a segment in two ways:

- **As a condition.** A `segment_membership` condition tests whether the person is or is not in a segment. The decision job evaluates the segment's conditions at that moment, the same way it evaluates a node's own conditions.
- **As a trigger.** A setup node can start the campaign when a person enters a segment. A person enters when the decision job sees them match after it last saw them not match. A re-entry setting on the trigger says whether a person can enter again: never, every time, or after a period.

The decision job keeps a membership flag per person only for segments that an entry trigger or a business-event audience uses. It updates the flag at each of the person's events. It never uses the flag to answer a `segment_membership` condition.

The owner chose segments as entry triggers and as conditions on 2026-10-21. Live evaluation for conditions, the three re-entry modes, and the ban on nested segments were chosen while writing this record, and are pending owner review. The owner's choices are in the decision log, `~/.claude/scripts/state/decisions.tsv`, from the design session of 2026-10-21.

## Why

Established tools model segments this way:

- **Klaviyo** segments use the same condition groups as its flows. A flow can start when a profile is "Added to segment", which means the profile newly qualifies, with a re-entry setting: no re-entry by default, re-entry on every qualification, or re-entry after a period. Segments are also flow filters.
- **Braze** uses segments as a Canvas entry audience and as filters, and computes exact membership before it sends.
- **Customer.io** starts campaigns on segment changes and filters with segments.
- **Segment** emits `Audience Entered` and `Audience Exited` events when membership changes, and journeys start on them.

Live evaluation keeps conditions correct. A stored flag goes stale when a window passes without an event, because nothing evaluates the person then. A condition that reads the definition at that moment cannot be stale. The stored flag exists only for what live evaluation cannot do: noticing a change from out to in.

Detecting entries at events fits the platform. The job has no event history to scan, and an entry means "newly qualifies", as in Klaviyo, so no backfill is needed. A person who already matches when a campaign starts enters at their next event that the job evaluates, because the job has no earlier flag for them.

A segment that references segments needs an evaluation order and cycle checks, and Braze forbids nesting segments that already use its membership filter. One level is enough for the use cases.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Segments as conditions only | The owner wanted campaigns to start on segment entry too. |
| Answer conditions from the stored membership flag | Stale after a window passes without an event, and the job would have to track every segment any condition names. |
| Timers that re-evaluate membership when a window boundary passes | Catches exits and window-based entries without an event, but needs a timer per person, segment, and window. Exit triggers are out of scope for now, and the open question about dormant users needs the same mechanism. |
| Nested segments | Needs ordering and cycle checks for little gain. |

## Consequences

- A profile change alone does not make a person enter a segment. The job notices at the person's next event, because it looks profiles up rather than streaming them ([decision 0030](0030-make-every-rule-decision-in-one-keyed-operator.md)).
- A segment with a profile condition costs a profile lookup at each of the person's events, within the cache period, when an entry trigger or an audience uses it.
- Leaving a segment starts nothing. Exit triggers wait for the timer mechanism.
- `studio` shows no segment size. Without event history, membership is known only for people the job has evaluated.
- Behavior conditions in a segment derive metric definitions, as in a campaign. A metric is `LIVE` while an active campaign uses a segment that names it.

## Related

- [Segments](../../features/segments.md)
- [Customer decision](../components/customer-decision.md)
- [Journey builder](../../features/journey-builder.md)
- [0029. Model a rule as a trigger and person conditions](0029-model-a-rule-as-a-trigger-and-person-conditions.md)
- [0033. A journey instance is one entry](0033-a-journey-instance-is-one-entry.md)
- Klaviyo, [Create a segment-triggered flow](https://help.klaviyo.com/hc/en-us/articles/360003040052)
- Braze, [Creating a segment](https://www.braze.com/docs/user_guide/engagement_tools/segments/creating_a_segment)
- Customer.io, [Campaign triggers, filters, and frequencies](https://docs.customer.io/journeys/campaign-triggers/)
- Twilio Segment, [Using Engage data](https://www.twilio.com/docs/segment/engage/using-engage-data)
