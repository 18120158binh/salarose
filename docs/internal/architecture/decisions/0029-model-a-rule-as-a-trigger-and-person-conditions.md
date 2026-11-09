---
title: Model a rule as a trigger and person conditions
id: "0029"
status: accepted
date: 2026-10-21
tags: [rules, conditions, journeys, studio, metrics]
supersedes: []
superseded_by: []
---

# 0029. Model a rule as a trigger and person conditions

## Context

A journey node that tests something saves its rule in three `campaign_nodes` columns, one per data source: `condition_json` for the event, `profile_condition_json` for the profile, and `aggregation_json` for metrics. Each column has its own shape. `condition_json` also carries a watch's time limit and path type, and a multi-branch check's branches. A metric condition names a metric id, which publish creates or reuses, and **Manage Properties** lets marketers create, edit, and delete metric definitions by hand.

The split by data source leaks into the decision job. The event condition is checked in one operator, and the profile and metric conditions in another, each with its own evaluator. A node cannot say "city is Hanoi or added to cart 3 times", because the two tests live in different columns that are always ANDed. Two campaigns that ask for different functions on one metric id conflict, and publish has to refuse one of them.

The owner did not want three columns, and did not want one free-form condition either. The owner asked how other providers model this, on 2026-10-21.

## Decision

A node's rule has two parts, split by role:

- **The trigger** is one event name and filters on that event's own attributes. It answers "which event moves this node". Setup, check, and watch nodes have one. A segment has none.
- **The conditions** test the person: profile properties, and behavior over a window. They answer "does this person qualify now".

Both are typed. A filter or condition is an object with a `type` and the fields of that type: `event_property`, `profile_property`, or `behavior`. Filters and conditions come in groups. Every group must pass, and a group passes when any of its conditions passes. A multi-branch check gives each branch its own filters and conditions in the same shape.

A behavior condition states what it counts: the event, the measure, the attribute when the measure needs one, filters on the event, and the window. Publish derives the metric definition from those fields. Marketers never pick or create a metric id.

`campaign_nodes` stores the rule in two JSON columns, `trigger_json` and `conditions_json`. How a node branches, its path type, a watch's time limit, and a multi-branch check's branches, moves to a third column, `paths_json`. `condition_json`, `profile_condition_json`, and `aggregation_json` go away.

The owner chose the inline behavior conditions, the two typed documents, and groups that are ANDed with alternatives ORed inside, on 2026-10-21. The `paths_json` column, the id derivation, and the field names were chosen while writing this record, and are pending owner review. The owner's choices are in the decision log, `~/.claude/scripts/state/decisions.tsv`, from the design session of 2026-10-21.

## Why

The journey and segmentation tools we looked at split a rule by role, not by data source, and they type each condition:

- **Klaviyo** separates a flow's trigger and trigger filters, which read only the triggering event's data, from flow filters, which read "any profile properties or actions of the user". Its segment API stores `condition_groups` that are ANDed together. The conditions inside a group are ORed. Each condition has a `type`, such as `profile-attribute`, `profile-metric`, or `profile-group-membership`, with its own fields. A `profile-metric` condition carries the metric, the measurement, a timeframe, and property filters inline.
- **Braze** Canvas has action-based entry on an event, an entry audience of segments and filters, and Decision Splits that query segments or filters.
- **Customer.io** campaigns start on an event or on a segment or attribute change, and narrow the audience with conditions on attributes and events.
- **Iterable** journeys start on an event. Its attribute split reads only profile fields, and only a yes/no filter can reach the triggering event's data.
- **Segment** audiences add conditions of distinct kinds: Performed an Event, Have a Computed Trait, Part of an Audience, Have a Custom Trait.
- **Bloomreach** filters customers on attributes or on event history, and computes aggregates inside a condition node.

Splitting by role matches how the job evaluates a rule. The trigger needs only the event, so it is the rule index. The conditions need the person's data, so they run after the trigger matches. Profile conditions, the only ones that need a lookup, run last ([decision 0030](0030-make-every-rule-decision-in-one-keyed-operator.md)).

Typed conditions in groups keep the editor and the evaluator simple. Every condition has a known shape that the editor can render and publish can check. Groups ANDed with alternatives ORed inside cover "city is Hanoi or HCMC, and added to cart at least 3 times" without a free-form tree. They let the job skip a profile lookup when a group without a profile condition already fails.

Inline behavior conditions remove a concept marketers had to manage. The metric id was an implementation detail shown in the UI, and it caused the function conflicts between campaigns. With the metric derived from the condition's own fields, two conditions that count the same thing share one series, and two that count different things never conflict.

`IN` takes a JSON array instead of a comma-separated string, so a value with a comma, a quote, or a parenthesis can match.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Keep three columns, one per data source | The split the owner rejected. It forces AND between data sources and splits evaluation across operators. |
| One free-form condition tree that mixes event, profile, and metric fields | Most expressive, but the editor must build arbitrary nesting, publish cannot check a typed shape, and the job cannot tell cheaply which conditions need a lookup. The owner rejected one column too. |
| Normalized rows, one per condition, in a new table | Queryable with SQL, but groups and type-specific fields spread over rows, and the decision job's change data capture would have to rebuild each node from several tables. |
| Behavior conditions that reference a saved metric id | Explicit reuse, but keeps metric ids in the UI and the function conflicts between campaigns. |

## Consequences

- The journey builder, publish, the decision job's rule parser, and the event catalog's rename change in one commit. The `campaign_nodes` schema changes with them, and the data model page follows.
- The trigger and the filters can test only the trigger's event. Profile and behavior tests go in conditions. A node cannot OR an event attribute with a profile property. None of the tools above allows that in one rule either.
- A check needs a trigger. A rule without a trigger, a segment, is evaluated when one of its behavior conditions' metrics changes, as today.
- Metric definitions are derived. Hand-made definitions and the edit and delete rules that protected them go away. Whether `studio` keeps a read-only list of derived metrics is an open question in [campaign management](../../features/campaign-management.md#open-questions).
- The runtime reads only the new format. No deployment holds campaigns in the old columns.

## Related

- [Journey builder](../../features/journey-builder.md)
- [Campaign management](../../features/campaign-management.md)
- [Customer decision](../components/customer-decision.md)
- [0028. Store metrics as tiered time buckets](0028-store-metrics-as-tiered-time-buckets.md)
- [0030. Make every rule decision in one keyed operator](0030-make-every-rule-decision-in-one-keyed-operator.md)
- Klaviyo, [Segments API overview](https://developers.klaviyo.com/en/reference/segments_api_overview)
- Klaviyo Community, [Trigger and filters](https://community.klaviyo.com/marketing-30/trigger-and-filters-2084)
- Braze, [Create a Canvas](https://braze.com/docs/user_guide/messaging/canvas/create_a_canvas)
- Customer.io, [Campaign triggers, filters, and frequencies](https://docs.customer.io/journeys/campaign-triggers/)
- Iterable Community, [Custom event data in attribute split tile](https://community.iterable.com/iterable-platform-2/custom-event-data-in-attribute-split-tile-1152)
- Twilio Segment, [Audiences](https://www.twilio.com/docs/segment/engage/audiences)
- Bloomreach, [Customer filters](https://documentation.bloomreach.com/engagement/docs/customer-filters)
