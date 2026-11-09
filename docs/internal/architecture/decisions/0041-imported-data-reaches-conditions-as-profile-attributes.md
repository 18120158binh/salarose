---
title: Imported data reaches conditions as profile attributes
id: "0041"
status: accepted
date: 2026-11-08
tags: [data-import, conditions, customer-decision, segments]
supersedes: []
superseded_by: []
---

# 0041. Imported data reaches conditions as profile attributes

## Context

Marketers want conditions such as "spent over 5,000,000 in the last 90 days" and "Gold tier" from a shop's imported records ([data import](../../features/data-import.md)). Customer decision already looks up the profile fields that a candidate's conditions name, per event, from `customer_profiles`, by the person's `user_id` ([customer decision](../components/customer-decision.md#interfaces)). The shop's customer key is that same `user_id`.

Behavior conditions read event-time series in customer decision's keyed state ([decision 0028](0028-store-metrics-as-tiered-time-buckets.md)). [Decision 0040](0040-import-through-a-batch-path-and-a-separate-store.md) keeps imported records out of that path.

## Decision

A metric over imported records, computed once a night, is an attribute of the person, like `city`.

- The import metric pass writes one row per customer and source to `customer_attributes`, keyed by `customer_key`. A row holds the values of a profile record type's columns, or of an event record type's metric set.
- A `profile_property` condition names an imported value as `<source>.<name>`, such as `orders.spend_90d` or `customers.loyalty_tier`. Customer decision resolves it from `customer_attributes` through the profile lookup it already makes, matching `customer_key` to the same `user_id`.
- Metrics store dates, such as `last_order_at`, never day counts. The condition language gains two relative-date operators, `more_than_days_ago` and `within_last_days`, which compare a datetime with the check time.
- Imported metric definitions live in their own table, `import_metric_definitions`, apart from `user_metric_definitions`.
- The segment runtime's nightly pass reads the same table for customers that no tracked event reaches ([decision 0038](0038-store-segment-membership-and-evaluate-every-segment.md)).

## Why

**It reuses a lookup that exists.** Customer decision changes only in which fields and operators it accepts. No CDC source, no Kafka topic, and no keyed state are added. A value is visible to the next lookup after the pass commits it, and a rule that names an imported field needs no restart.

**Dates keep nightly writes small.** "Days since last order" changes for every customer every night, so storing it would rewrite every row. `last_order_at` changes only when an order arrives. A relative-date operator gives the same condition: `orders.last_order_at more_than_days_ago 60`. A failed night then leaves no stale count behind. The lead made this call on 2026-11-08.

**Check time is event time.** The operators compare with the evaluated event's time in customer decision, and with the pass's `as_of` in the segment runtime. Event time, not the wall clock, gives a replayed event the same answer ([decision 0006](0006-at-least-once-delivery-with-idempotent-writes.md)).

**A separate definition table keeps CDC safe.** `user_metric_definitions` rows are tied to a catalog event, carry `processing_mode`, and reach customer decision through CDC, which would try to parse an imported definition. A table of its own keeps the function names and the condition editor and changes neither.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Write imported series into `user_metrics` | Customer decision serves its cached series, and the table gets a second writer ([decision 0002](0002-key-every-write-by-its-owner.md)). |
| Imported series in customer decision's keyed state, with the window chosen per condition | Keeps per-condition windows, but needs a new keyed input, nightly full-series rewrites through Kafka, and Java-compatible sketches built by the batch job. |
| Store day counts such as `days_since_last_order` | Rewrites every customer's row every night, and a failed night leaves counts one day stale. |
| Compare relative dates with the wall clock | A replayed event can reach a different answer than the first time. |

## Consequences

- A metric's window is fixed in its definition, such as "spend in the last 90 days". A marketer who wants 30 days defines a second metric.
- Imported values reach a tracked person at their next event. Imported data starts no journey by itself.
- Customer decision reads `customer_attributes` only when a candidate names a dotted field, in the same round trip as `customer_profiles`.
- The condition editor offers a dotted field, and the relative-date operators, only once the runtime that evaluates the condition resolves them (JBD-FR-31).
- Renaming or deleting an imported column or metric is refused while a published campaign or a segment names its dotted field, as CAT-FR-11 does for catalog attributes.
- CMP-FR-17 keeps forbidding hand-made rows in `user_metric_definitions`. Imported metric definitions are hand-made by design and live apart.

## Related

- [Customer decision](../components/customer-decision.md#condition-language)
- [Import metric pass](../components/import-metric-pass.md)
- [Data import](../../features/data-import.md)
- [Journey builder](../../features/journey-builder.md#conditions)
- [Segments](../../features/segments.md)
- [0040. Import through a batch path and a separate store](0040-import-through-a-batch-path-and-a-separate-store.md)
- [0038. Store segment membership and evaluate every segment](0038-store-segment-membership-and-evaluate-every-segment.md)
- [0028. Store metrics as tiered time buckets](0028-store-metrics-as-tiered-time-buckets.md)
