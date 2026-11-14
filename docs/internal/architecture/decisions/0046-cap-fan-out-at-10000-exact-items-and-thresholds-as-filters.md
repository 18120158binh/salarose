---
title: Cap fan-out at 10,000 people, match exact items, and express thresholds as filters
id: "0046"
status: accepted
date: 2026-11-14
tags: [business-events, fan-out, flink, limits]
supersedes: []
superseded_by: []
---

# 0046. Cap fan-out at 10,000 people, match exact items, and express thresholds as filters

## Context

[Decision 0032](0032-fan-out-business-events-to-interested-people.md) chose to fan business events out to interested people and segment members, and left four points pending review. The [business event fan-out contract](../components/business-event-fan-out.md) listed them as open questions:

1. Are 10,000 people per item and 10,000 matches per business event and campaign the right caps?
2. Does an uncapped segment broadcast need a rate limit, so that it does not delay interest matches?
3. Should a business trigger support a stock threshold and a re-check before sending?
4. Should an interest match a related item, such as one in the same category?

The caps set the size of the interest index state and the behavior in BEF-FR-07. The component cannot be built to an accepted contract until all four are answered.

## Decision

1. **Caps stay at 10,000.** An item keeps at most 10,000 people per interest, and one business event emits at most 10,000 matches per interest campaign. Over the cap, the fan-out keeps and sends to the most recently interested people, and counts the rest. Both numbers are part of the contract, not settings.
2. **No rate limit in the fan-out.** A segment audience emits one match per indexed member at full speed. Pacing message sends is the job of the step that sends messages, not of the fan-out.
3. **No threshold or re-check on the trigger.** A threshold is a filter on the business event's attributes, such as `quantity >= 5` or `drop_percent >= 10`, which business triggers already support. A wait and re-check before sending is the sender's job: post a business event only for a real change. A journey can still add a wait node after the trigger.
4. **Exact item only.** An interest counts only person events whose match attribute equals the business event's item key.

## Why

**Caps.** Each indexed person costs about 50 bytes of keyed state: a `canon_id`, a few count buckets, and one exclusion time. 10,000 people is about 500 KB per item and interest, which RocksDB state handles without trouble, and it bounds the fan-out burst of one business event. Customer.io caps an object-triggered campaign at 1,000 people and drops all of them when a trigger goes over. That cap is too low for a popular product's price drop, and dropping everyone loses the shoppers most likely to buy. Klaviyo and Bloomreach do not publish a cap, but they rank their audience by lookback recency in the same way. Recency-first with a count keeps the best audience and makes the loss visible. Nothing measured here argues for a different number, so the proposed value stands until a load test or a customer shows otherwise.

**Segment broadcast.** The pipeline already has a pacing point. Braze applies rate limits to message sends per Canvas, and Klaviyo applies smart sending at delivery, not at audience selection. A rate limit in the fan-out would hold matches in Flink state, where a restart replays them, and the business event would reach the last members minutes late. Matches are keyed by `canon_id`, so a broadcast spreads over every partition of `business-event-matches` and every subtask of customer decision, rather than queuing behind one key. If broadcasts later delay interest matches past BEF-NFR-04, the fix is a separate topic or priority for segment matches, which needs a measurement first.

**Thresholds.** Braze's back-in-stock and price-drop triggers and Bloomreach's catalog triggers take a threshold because those products detect changes themselves from a catalog they sync. This platform has no catalog. The customer posts the change ([decision 0032](0032-fan-out-business-events-to-interested-people.md) rejected a synced catalog), so the customer's system already knows the stock level and can post `back_in_stock` with a `quantity` attribute. A filter on that attribute gives the threshold with no new feature. A re-check needs the current stock, which only the customer's system has.

**Exact item.** Klaviyo's price drop, Braze's catalog subscriptions, and Bloomreach's catalog triggers all reach viewers of the same item. "Your item is cheaper" is the message, and a related item breaks it. Matching by category would need item-to-category data the platform does not hold, and a second index keyed by category. A marketer who wants category interest can post a business event whose item key is the category and pick an interest whose match attribute is the category field.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| A 1,000 cap that drops every person, as Customer.io does | Too low for a popular item, and it drops the people most likely to buy. |
| A cap set per deployment or campaign | Adds a setting with no evidence that any customer needs another value. The contract number can change with a new record. |
| Rate-limit segment matches in the fan-out | Holds matches in replayable state, makes the last members late, and duplicates pacing that belongs at send time. |
| A threshold and re-check on the business trigger | Needs stock data the platform does not hold. Attribute filters already give the threshold. |
| Match related items, such as the same category | Needs item-to-category data and a second index, and breaks the "this item" message. Category can be posted as its own item key. |

## Consequences

- The contract's caps lose their "proposed" mark. BEF-FR-07 stands as written.
- A broadcast to a large segment produces a burst on `business-event-matches`. Anything that paces sends sits after customer decision.
- Customers must post a business event only for a change worth sending, with the attributes a filter needs, such as `quantity`.
- A category campaign needs the customer to post a business event per category.

## Related

- [Business event fan-out](../components/business-event-fan-out.md)
- [0032. Fan out business events to interested people](0032-fan-out-business-events-to-interested-people.md)
- [0028. Store metrics as tiered time buckets](0028-store-metrics-as-tiered-time-buckets.md)
