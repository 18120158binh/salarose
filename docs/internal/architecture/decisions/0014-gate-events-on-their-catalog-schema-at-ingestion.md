---
title: Gate events on their catalog schema at ingestion
id: "0014"
status: proposed
date: 2026-10-18
tags: [flink, cdc, ingestion, catalog, data-quality]
supersedes: []
superseded_by: []
---

# 0014. Gate events on their catalog schema at ingestion

## Context

Tracked event payloads drift from the event catalog. A tracker renames `product.price`, or sends it as a string. Metrics and journey conditions then read a missing or mistyped attribute and count or match the wrong customers, and nothing says why. Before this decision, ingestion accepted any event, and the catalog only fed the builder's pickers.

The owner decided on 2026-10-18 that each catalog event gets an optional schema gate. While it is on, every event of that name that reaches metrics and journeys must match its catalog schema. While it is off, nothing changes.

## Decision

The catalog stores the gate as `user_events.enforce_schema` and a per-attribute `user_event_fields.required`, both off by default. Each attribute's existing `data_type` is its type rule.

The event parse job checks each parsed event before identity stitching. It reads both catalog tables through Postgres CDC into broadcast state, the way customer decision and the state machine read their rules ([decision 0003](0003-load-rules-through-cdc-and-broadcast-state.md)). An event whose gate is on and that misses a required attribute, or has a value of the wrong type, is dropped and counted under the drop reason `schema_invalid`. The log line names the attribute path and its catalog type, never a value. Attributes the catalog does not list, and event names it does not list, pass.

## Why

Every product we looked at validates against a per-event schema at ingestion, and drops or diverts what fails:

- Segment Protocols compares each Track event with the tracking plan's JSON Schema. Its schema controls can block events with violations, such as a missing required property or a wrong type, or omit only the bad property. Blocked events are discarded unless forwarded to another source. ([Segment schema configuration](https://www.twilio.com/docs/segment/protocols/enforce/schema-configuration))
- RudderStack tracking plans define required properties and types per event. Violations such as Required-Missing and Datatype-Mismatch are either forwarded with the errors in the event's context, or dropped. Unplanned properties and unplanned events have their own settings. ([RudderStack violation management](https://www.rudderstack.com/docs/data-governance/tracking-plans/violation-management/))
- mParticle data plans validate incoming data and can block unplanned events and attributes before they reach downstream tools. Blocked data can be quarantined and replayed. ([mParticle Block Data](https://support.mparticle.com/hc/en-us/articles/14389664957581-Data-Planning-Block-Data))
- Snowplow validates every self-describing event against its Iglu schema during enrichment. An event that fails becomes a failed event with a schema violation, kept out of the events table and recoverable later. ([Snowplow failed events](https://docs.snowplow.io/docs/fundamentals/failed-events/))

The common shape is a per-event schema of property types and required flags, opt-in enforcement, and a drop with a count and a reason. We took that shape. The details follow JSON Schema, which Segment, RudderStack, and Snowplow all use: `datetime` is the RFC 3339 `date-time` format, a required property applies only inside a present parent object, and properties the schema does not list are allowed. We treat a null as no value, so a tracker that sends `null` for an optional attribute is not dropped.

Checking at ingestion, not in customer decision, means one check per event for every consumer of `snowplow-parsed`, and keeps failed events out of identity stitching too. CDC with broadcast state gives every subtask the same catalog version, keeps it in checkpoints, and needs no poller, for the reasons in decision 0003.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Check in customer decision, per metric and rule | Each consumer would repeat the check, and failed events would still reach identity stitching and `snowplow-parsed`. |
| Load the catalog in the parser's table function, with a periodic reload | Decision 0003 rejected polling for rules: subtasks disagree on the version, all of them query Postgres at start, and the reload thread is not managed by Flink. |
| Omit only the bad attribute, as Segment's Omit option does | A metric on that attribute would then count an occurrence with no value, which is the drift the owner wants out. Dropping is the simpler guarantee. |
| Quarantine failed events on a dead-letter topic | Wanted, but it needed a decision on retention and access for personal data, so it came later. [Decision 0017](0017-keep-dropped-ingestion-input-in-a-dead-letter-topic.md) adds the topic, and it carries `schema_invalid` events too. |
| Also block unplanned attributes or unplanned event names | Not asked for. A gate on one event must not drop other events, and new optional attributes should not need a catalog change first. Both can be later switches. |

## Consequences

- The event parse job now needs the Postgres CDC settings and a replication slot for each catalog table. [The data model](../data-model.md#publications-for-cdc) lists them.
- The job graph gained two CDC sources and the gate operator. The planner-built Kafka sink of `snowplow-parsed` has no uid, so its operator ids changed, and an upgrade restores with `allowNonRestoredState`. The Kafka source carries its old id.
- Events dropped by the gate are lost, like every other drop, until the dead-letter topic exists.
- On a start without saved state, events read before the catalog snapshot arrives pass unchecked. A restore keeps the catalog in its checkpoint, so the gate holds across restarts.
- A `data_type` that is not one of the five catalog types gives no type rule. Studio's editor offers only the five.

## Related

- [Event catalog](../../features/event-catalog.md)
- [Event ingestion](../components/event-ingestion.md)
- [Decision 0003](0003-load-rules-through-cdc-and-broadcast-state.md)
