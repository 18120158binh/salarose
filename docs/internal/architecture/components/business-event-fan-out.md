---
title: Business event fan-out
slug: business-event-fan-out
purpose: Turn each business event, such as a price drop, into one record per person that a campaign should reach.
status: accepted
implementation: partial
area: event-processor
tags: [business-events, fan-out, flink, interest, segments]
created: 2026-10-21
updated: 2026-11-14
version: 1.0
known_issues: ../../known-issues/components/business-event-fan-out.md
---

# Business event fan-out

## Purpose

A business event is about an item, not a person: a product's price dropped, or it is back in stock. A campaign that starts on one has to reach the people it concerns: the people who viewed that product recently, or the members of a segment. This component keeps an index of who is interested in each item and who is in each segment, and turns each business event into one record per person and campaign for [customer decision](customer-decision.md). [Decision 0046](../decisions/0046-cap-fan-out-at-10000-exact-items-and-thresholds-as-filters.md) settles its caps, the segment broadcast, thresholds, and item matching.

## Scope

In scope:

- The interest index: per item, the people who did an interest event on it, counted over time.
- The segment member index: per segment, the people last seen as members.
- Matching each business event to active campaigns, and emitting one record per person and campaign.
- Caps on how many people one business event reaches.

Out of scope:

- Accepting business events. The [data ingestion API](../../features/data-ingestion-api.md) does that.
- Evaluating the person's own conditions, checking segment membership again, and emitting the setup trigger. [Customer decision](customer-decision.md#business-event-matches) does that.
- Deciding segment membership. Customer decision publishes the changes this component indexes.

## Terms

| Term | Meaning |
|---|---|
| Business event | A catalog event of kind `business`, with an item key. See the [event catalog](../../features/event-catalog.md). |
| Item key | The value of the business event's item key attribute, such as the `product.id` `SKU-123`. |
| Business trigger | A setup node's trigger of kind `business_event`: the business event's name, filters on its attributes, and one audience. |
| Interest | An audience: people who did a person event on the same item at least `min_count` times in a window, matched by an attribute of that event, minus an optional exclusion. |
| Exclusion | A person event on the same item, such as `purchase`, that removes a person from an interest when it happened in the window. |
| Segment audience | An audience: the members of one segment. |
| Match | A record that one business event concerns one person for one campaign. Topic `business-event-matches`. |

## Behavior

Campaign `CAMP-0042` starts on `price_drop` with the filter `drop_percent >= 10`, and the interest "`view_product` on the same `product.id` at least 2 times in 7 days, excluding `purchase` on it".

1. Over the week, shopper A views `SKU-123` three times, shopper B views it twice and then buys it, and shopper C views it once. The interest index for `SKU-123` counts each shopper's views and records B's purchase.
2. The customer posts `price_drop` for `SKU-123` with `drop_percent` 15.
3. The fan-out finds `CAMP-0042`, whose trigger matches. A has 3 views in the window and no purchase. B bought it. C has 1 view. It emits one match, for A.
4. Customer decision evaluates the setup node's conditions for A and emits the setup trigger, with the business event's id as the entry id.

A campaign with a segment audience on `back_in_stock` instead gets one match for every person the segment member index holds for that segment. Customer decision checks each person's membership again before it emits.

## Algorithm

### Keep the interest index

For each interest that a business trigger of an active campaign uses, read every person event from `snowplow-parsed` whose name is the interest event or the exclusion event and whose `canon_id` is set. Take the value of the interest's match attribute as the item key. Skip an event without it.

Key the index by interest and item key. For each person, count interest events in buckets by the rules of [customer decision](customer-decision.md#buckets), and keep the newest exclusion event's time. Drop a person's entry once no bucket is younger than the longest window among the active campaigns that use the interest.

An item keeps at most 10,000 people per interest. When a new person would go over, drop the person whose newest interest event is the oldest, and count the drop.

### Keep the segment member index

Read the membership changes that customer decision publishes on `segment-membership-changes`. Key the index by segment and by a shard of the person's `canon_id`, so that one segment spreads over many keys. An `entered` change adds the person, and an `exited` change removes them.

### Fan out a business event

For each business event from `business-events`:

1. Drop it if its `event_id` is among the last 1,000 ids seen for its item key.
2. Find the active campaigns whose setup node has a business trigger for this event name, and whose filters the event passes.
3. For each interest campaign, select the people whose interest count in the window `(t - W, t]` is at least `min_count`, where `t` is the business event's time, and who have no exclusion event in that window. Order them by their newest interest event, newest first, and emit at most 10,000 matches. Count the rest.
4. For each segment campaign, send the business event to every shard of the segment, and emit a match for every person each shard holds.

A match carries the business event's `event_id`, name, time, item key, and attributes, the `campaign_id`, the setup `node_id`, and the person's `canon_id`.

## Functional requirements

| Id | Requirement |
|---|---|
| BEF-FR-01 | The fan-out must emit one match per person and campaign that a business event concerns, and none for any other person. |
| BEF-FR-02 | An interest must count only events whose match attribute equals the business event's item key. |
| BEF-FR-03 | A person with an exclusion event on the item within the window must not get a match from that interest. |
| BEF-FR-04 | A business event must reach only campaigns that are `active`, whose setup node's business trigger names it, and whose filters it passes. |
| BEF-FR-05 | A business event replayed or posted twice must not emit a second match for any person and campaign. |
| BEF-FR-06 | A segment audience must reach every person the segment member index holds for that segment. |
| BEF-FR-07 | When an interest selects more people than the cap, the fan-out must emit to the most recently interested first, and must count the people it leaves out. |
| BEF-FR-08 | The index must start counting an interest when an active campaign starts using it. It must not invent earlier interest. |
| BEF-FR-09 | An interest must match only the exact item key. It must not match a related item, such as one in the same category. |
| BEF-FR-10 | The fan-out must not rate-limit or delay matches. A segment audience emits every match as soon as its shard reads the business event. |
| BEF-FR-11 | A threshold, such as a minimum stock level, is a filter on the business event's attributes. The fan-out must not hold a business event to re-check it later. |

## Non-functional requirements

Numbers marked "proposed" are starting values for review, not decisions.

| Id | Requirement |
|---|---|
| BEF-NFR-01 | An item keeps at most 10,000 people per interest. |
| BEF-NFR-02 | One business event emits at most 10,000 matches per interest campaign. |
| BEF-NFR-03 | The fan-out remembers the last 1,000 business event ids per item key. |
| BEF-NFR-04 | Matches for an interest campaign reach `business-event-matches` within 10 seconds of the business event at the 99th percentile. Proposed. |
| BEF-NFR-05 | Delivery is at least once. Customer decision and journey execution make a repeated match harmless by its entry id. See [decision 0006](../decisions/0006-at-least-once-delivery-with-idempotent-writes.md). |

## Interfaces

| Direction | Interface | Contract |
|---|---|---|
| In | Kafka `business-events` | Accepted business events, key event name + U+001F + item key. Each message carries `schema_version`, `app_id`, and `event_time` in epoch milliseconds, in the format of the [data ingestion API](../../features/data-ingestion-api.md#business-events). The API writes in transactions, so the fan-out reads with `read_committed`. |
| In | Kafka `snowplow-parsed` | Person events, for the interest index. See [event ingestion](event-ingestion.md#interfaces). |
| In | Kafka `segment-membership-changes` | `canon_id`, `segment_id`, `entered` or `exited`, and the event time. Key `canon_id`. From [customer decision](customer-decision.md#interfaces). |
| In | CDC `campaigns`, `campaign_nodes` | Active campaigns and their business triggers |
| Out | Kafka `business-event-matches` | One match per person and campaign, key `canon_id` |

A match:

```json
{
	"schema_version": 1,
	"canon_id": "7e9d0c1b-0000-3000-8000-000000000000",
	"campaign_id": "CAMP-0042",
	"node_id": "setup_1",
	"business_event_id": "0f8b2c1e-5d4a-4c3b-9a21-7e6f5d4c3b2a",
	"business_event_name": "price_drop",
	"business_event_time": 1785800000000,
	"item_key": "SKU-123",
	"attributes": { "product": { "id": "SKU-123", "price": 899000 }, "drop_percent": 15 }
}
```

## Failure handling

| Case | Behavior |
|---|---|
| A person event without the interest's match attribute | Skip it for that interest. |
| A business event that no active campaign matches | Emit nothing. Count it. |
| A business event seen before | Drop it (BEF-FR-05). |
| An interest over the cap | Emit to the most recently interested first. Count the rest (BEF-FR-07). |
| A campaign paused while its matches are in flight | Customer decision drops matches for a campaign that is not `active`. |
| Restart | Restore the indexes from the checkpoint. Without one, they start empty and fill from new events. |

## Acceptance criteria

- Given the example in [Behavior](#behavior), when the `price_drop` arrives, then the fan-out emits one match, for shopper A. (BEF-FR-01, BEF-FR-02, BEF-FR-03)
- Given a `price_drop` with `drop_percent` 5, then `CAMP-0042` gets no match. (BEF-FR-04)
- Given the same `price_drop` posted twice, then the fan-out emits A's match once. (BEF-FR-05)
- Given views of `SKU-999` only, when a `price_drop` for `SKU-123` arrives, then no match is emitted for that viewer. (BEF-FR-02)
- Given a segment audience whose index holds 3 people over 2 shards, when the business event arrives, then the fan-out emits 3 matches. (BEF-FR-06)
- Given 12,000 people interested in one item, when its business event arrives, then the fan-out emits 10,000 matches, to the most recently interested, and counts 2,000. (BEF-FR-07)
- Given views of `SKU-123` that happened before any active campaign used the interest, then they do not count. (BEF-FR-08)
- Given two campaigns with the same interest, then the index counts each view once, and each campaign gets its own match. (BEF-FR-01)
- Given views of `SKU-124` in the same category as `SKU-123`, when a `price_drop` for `SKU-123` arrives, then no match is emitted for that viewer. (BEF-FR-09)
- Given a segment audience of 50,000 indexed members, when the business event arrives, then the fan-out emits 50,000 matches without holding any back. (BEF-FR-10)
- Given a business trigger with the filter `quantity >= 5`, when `back_in_stock` arrives with `quantity` 2, then the campaign gets no match, and the fan-out keeps no state to check it again. (BEF-FR-04, BEF-FR-11)

## Open questions

None. [Decision 0046](../decisions/0046-cap-fan-out-at-10000-exact-items-and-thresholds-as-filters.md) answered the caps, the segment broadcast size, restock thresholds, and interest across items on 2026-11-14.

## Related

- [Customer decision](customer-decision.md)
- [Data ingestion API](../../features/data-ingestion-api.md)
- [Event catalog](../../features/event-catalog.md)
- [Journey builder](../../features/journey-builder.md)
- [Segments](../../features/segments.md)
- [0032. Fan out business events to interested people](../decisions/0032-fan-out-business-events-to-interested-people.md)
- [0033. A journey instance is one entry](../decisions/0033-a-journey-instance-is-one-entry.md)
- [0046. Cap fan-out at 10,000 people, match exact items, and express thresholds as filters](../decisions/0046-cap-fan-out-at-10000-exact-items-and-thresholds-as-filters.md)
- [Known issues](../../known-issues/components/business-event-fan-out.md)
