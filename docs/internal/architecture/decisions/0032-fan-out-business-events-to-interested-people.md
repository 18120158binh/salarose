---
title: Fan out business events to interested people
id: "0032"
status: accepted
date: 2026-10-21
tags: [business-events, ingestion, flink, journeys]
supersedes: []
superseded_by: []
---

# 0032. Fan out business events to interested people

## Context

Two use cases start from something the business does, not the shopper: a price drop on a product the shopper viewed (UC-08), and a product coming back in stock (UC-14). The builder lists `price_drop` and `back_in_stock` as triggers, but nothing produces them. Event ingestion keeps an event with no person id out of journeys, and every job keys its state by `canon_id`.

A business event is about an item, such as a product. It has no person. The journey for it runs per person. So the platform has to find the people a business event concerns.

The owner chose, on 2026-10-21, that business events arrive through the data ingestion API, that a campaign reaches either the people interested in the item or the members of a segment, and that a person can enter a business-event campaign once per business event.

## Decision

A business event is a catalog event of kind `business`, with an item key attribute such as `product.id`. Customers post business events to `POST /v1/business-events` on the [data ingestion API](../../features/data-ingestion-api.md). Accepted events go to the topic `business-events`, keyed by event name and item key.

A setup node can trigger on a business event, with filters on its attributes and one audience:

- **Interest.** People who did a person event on the same item at least N times in a window, matched by an attribute of the person event, minus an optional exclusion event on the same item in the window. "Viewed this product at least twice in the last 7 days, and did not buy it" is one interest.
- **Segment.** Every member of a saved segment.

A new component, [business event fan-out](../components/business-event-fan-out.md), turns each business event into one record per person and campaign:

- It keeps an **interest index**, keyed by item, built from `snowplow-parsed`. For each interest that an active campaign uses, it counts each person's matching events on the item in buckets, with the rules of [decision 0028](0028-store-metrics-as-tiered-time-buckets.md).
- It keeps a **segment member index**, keyed by segment and a hash shard of `canon_id`, built from the membership changes that customer decision publishes.
- For each business event and each active campaign it matches, it emits a record per qualifying person to `business-event-matches`, keyed by `canon_id`.

Customer decision reads those records. It evaluates the setup node's own conditions for the person, and for a segment audience it checks membership again at that moment. Then it emits the setup trigger with the business event id as the entry id ([decision 0033](0033-a-journey-instance-is-one-entry.md)).

The owner chose the intake, the two audiences, and one entry per business event on 2026-10-21. The interest shape, the separate component, the sharded member index, and the caps were chosen while writing this record, and are pending owner review. The owner's choices are in the decision log, `~/.claude/scripts/state/decisions.tsv`, from the design session of 2026-10-21.

## Why

Commerce messaging tools solve UC-08 and UC-14 this way:

- **Braze** catalog triggers keep a subscription: a custom event such as a product view carries the item id. When an item's inventory goes above zero, Braze finds the subscribed users and fires a per-user event that a Canvas can start on. Price drops work the same way.
- **Klaviyo**'s price drop trigger fires for people who viewed the product or started checkout with it within a lookback, 30 days by default, and leaves out people who bought it since.
- **Bloomreach** catalog triggers fire on back in stock, price reduction, and low inventory. Their audience is people who viewed the item, for example at least once in the last 30 days, and they can exclude buyers.
- **Customer.io** starts campaigns when an object such as an account changes, for the people related to it, and caps each trigger at 1,000 people.

All of them keep an index from item to interested people and fan out at trigger time. None of them queries raw history per business event. That matters here, because the platform keeps no event history outside Kafka.

The index is keyed by item, so one subtask owns each item's interest and the fan-out for that item's business events, as [decision 0002](0002-key-every-write-by-its-owner.md) requires of stateful writes. The per-person records then go back to the `canon_id` key, so the person's own conditions, metrics, and profile lookup run in the decision operator, where they already live ([decision 0030](0030-make-every-rule-decision-in-one-keyed-operator.md)).

Sharding the segment index spreads a large segment over many keys. Otherwise one key, and one subtask, would hold and emit every member.

Checking segment membership again in customer decision keeps a broadcast correct when the index is stale. The index learns of a change only at the person's events.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Send business events through the collector, with no person id | Tracker SDKs are built for people, and ingestion would need a second route for events without one. The owner chose the API. |
| A product catalog that the platform syncs, detecting changes itself, as Braze and Bloomreach do | Turnkey for marketers, but a new catalog feature with its own sync and storage. Customers can post a change as a business event today. |
| Query an event store for interested people at each business event | Needs the event history store the owner ruled out. |
| Keep interest in the decision operator, keyed by person | A business event would have to visit every person to find the interested ones. Interest has to be indexed by item. |
| Segment audience only | Cannot target "viewed this product", which UC-08 and UC-14 need. |
| Fail every record of a business event that exceeds the cap, as Customer.io does | Drops the people most likely to buy along with the rest. The fan-out sends to the most recently interested people first and counts the remainder. |

## Consequences

- Interest counts only events that arrive after an active campaign starts using that interest. The index has no history to start from.
- A popular item can have more interested people than the cap. The fan-out sends to the most recently interested first and counts the people it drops.
- A segment broadcast reaches members the index knows. A person who matched but sent no event since the segment started being tracked is not in the index.
- The interest index holds `canon_id` values. After an identity merge, records under a retired id are redirected by the decision job ([identity merges](../components/identity/identity-merges.md)), and the entry id keeps the person from entering twice for one business event.
- Messages can use the business event's attributes, which the setup trigger carries as context under `business.`.

## Related

- [Business event fan-out](../components/business-event-fan-out.md)
- [Data ingestion API](../../features/data-ingestion-api.md)
- [Event catalog](../../features/event-catalog.md)
- [Journey builder](../../features/journey-builder.md)
- [Customer decision](../components/customer-decision.md)
- [0031. Reusable segments with entry triggers](0031-reusable-segments-with-entry-triggers.md)
- [0033. A journey instance is one entry](0033-a-journey-instance-is-one-entry.md)
- Braze, [Set up back-in-stock notifications](https://www.braze.com/docs/user_guide/data/activation/catalogs/catalog_triggers/back_in_stock_notifications) and [Price drop notifications](https://www.braze.com/docs/user_guide/data/activation/catalogs/catalog_triggers/price_drop_notifications)
- Klaviyo, [How to create a price drop flow](https://help.klaviyo.com/hc/en-us/articles/4404249033755-How-to-create-a-price-drop-flow)
- Bloomreach, [Catalog trigger types](https://documentation.bloomreach.com/engagement/docs/catalog-trigger-types)
- Customer.io, [Objects and relationships in campaigns](https://docs.customer.io/journeys/object-and-relationship-campaigns/)
