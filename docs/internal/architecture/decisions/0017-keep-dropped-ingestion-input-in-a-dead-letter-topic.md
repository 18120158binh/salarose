---
title: Keep dropped ingestion input in a dead-letter topic
id: "0017"
status: proposed
date: 2026-10-18
tags: [flink, kafka, ingestion, data-quality, privacy]
supersedes: []
superseded_by: []
---

# 0017. Keep dropped ingestion input in a dead-letter topic

## Context

Event ingestion drops a collector payload that does not decode, and an event without a UUID `eid`, without a usable timestamp, or that fails its catalog schema gate. Before this decision it counted each drop by reason and logged it without content, and the content was lost. An operator could see how many events a broken tracker release lost, but could not see which events, or replay them once the tracker or the catalog was fixed.

The owner decided on 2026-10-17 to add counters and logs first, and a dead-letter topic later. The counters and logs shipped first. This record covers the topic.

## Decision

The event parse job writes every payload and event it drops to one Kafka topic, `snowplow-parsed-dead-letters` by default. Each record is a JSON object with the drop reason, a detail that holds no content, the time of the drop, and the content: the collector payload's bytes or the event. A payload is written once, and its dropped events refer to it. The counters and the content-free logs stay as they were.

The owner decided on 2026-10-17 to add a dead-letter topic. The scope, which is every drop reason including `schema_invalid`, was chosen during the fix. So were the record shape, the topic name, and the rules below. They are pending owner review:

- A collector payload goes in one `payload` record: its Thrift bytes in standard Base64, its SHA-256 as `payload_id`, and its size. A payload dropped whole carries the drop reason. A payload with dropped events is written with the first of them, and each dropped event is an `event` record with the tracker event as a JSON object and the payload's `payload_id`. So a payload with many bad events is written once, and an event can be read without decoding Thrift. A `schema_invalid` drop is an `event` record with the parsed event, in the format of `snowplow-parsed`, and no payload, because the gate runs after parsing.
- A payload keeps at most 512 KiB, which is configurable. A longer one is cut, with `payload_truncated` set and its original size. In Base64, 512 KiB is about 683 KiB, below the Kafka producer's default `max.request.size` of 1 MiB. Without the cut, a payload near the broker's 1 MiB limit grew by a third in Base64, the producer rejected the record, the at-least-once sink failed, and the job restarted on the same offset forever. A cut payload cannot be replayed. An `event` record is not cut. It is smaller than the payload it came from, which fit in the source topic.
- The time is when the job dropped the record, in epoch milliseconds. After a restore, a replayed drop is written again with a later time.
- Records have no key. Delivery is at least once, like `snowplow-parsed`.
- The topic is always on. The job fails if it cannot write to it, so the topic must exist before the job starts.
- Retention and access are set on the topic, not in the job. The upgrade note recommends 7 days and access for the job and on-call operators only.
- The job does not replay. An operator replays by hand: a payload goes back to the collector's topic, and a `schema_invalid` event can be checked against the fixed catalog first. A replayed payload republishes its other events too, which consumers already deduplicate on `event_id`.

## Why

A drop is a data-quality signal and, once the cause is fixed, data to recover. A log line cannot hold the content, because logs are kept long, read widely, and must not hold personal data (ING-FR-11). A topic holds the content apart from the logs, with its own retention and access.

The three products we looked at keep bad events apart from good ones, and keep the content so it can be fixed:

- Snowplow writes events that fail validation or enrichment to failed-event storage, not to the good stream. It saves "the raw event payload along with details about the failure", partitioned by failure type, so that a recovery job can fix and reprocess them ([Snowplow: failed events](https://docs.snowplow.io/docs/understanding-your-pipeline/failed-events), [access raw failed events](https://docs.snowplow.io/docs/monitoring/exploring-failed-events/file-storage/), [event recovery](https://index-dev.scala-lang.org/snowplow-incubator/snowplow-event-recovery)).
- Segment Protocols can block events that break a tracking plan. "Any blocked events that are not forwarded to a separate Source are permanently discarded and cannot be recovered." Segment recommends forwarding blocked events and violations to a separate source ([Segment: schema configuration](https://www.twilio.com/docs/segment/protocols/enforce/schema-configuration), [forward violations](https://www.twilio.com/docs/segment/protocols/validate/forward-violations)).
- RudderStack shows failed events per destination with a sample payload, and viewing the payload needs PII permissions. In a warehouse, a value of the wrong type goes to a separate `rudder_discards` table instead of the main table ([RudderStack: health dashboard](https://www.rudderstack.com/docs/monitor/health-dashboard/), [warehouse discards](https://www.rudderstack.com/docs/releases/warehouse-discards/index.md)).

All three treat the failed content as personal data that needs its own access rule. That is why access and retention are part of the upgrade note.

We already run Kafka between every job, so a topic is the cheapest separate store. Any consumer can read it, and `rpk` can copy a payload back to the collector's topic.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Log the content at DEBUG | Logs are kept long and read widely. ING-FR-11 keeps content out of them. |
| One topic per drop reason | More topics to create, secure, and watch. The reason is a field, and a consumer can filter on it. |
| Write drops to a Postgres table | Adds write load and a schema change to the hot path, and Postgres is the store we keep small. A topic can be loaded into a table later. |
| Send dropped events on with a flag on `snowplow-parsed` | Every consumer would have to filter them, and a consumer that forgot would act on bad data. |

## Consequences

- An operator can inspect and replay dropped input for as long as the topic keeps it.
- The topic holds personal data in clear text. Its retention and access must be set when it is created, and reviewed with the rest of the data inventory.
- The event parse job has a new sink, and fails while the topic is missing or not writable.
- The payload limit must stay below three quarters of the producer's `max.request.size`, or a large payload can stop the job again.
- A broken tracker release that drops most events writes about as much to the topic as it would have to `snowplow-parsed`. Size the topic's partitions and retention for that.

## Related

- [Event ingestion](../components/event-ingestion.md)
- [Event catalog](../../features/event-catalog.md)
- [0006. At-least-once delivery with idempotent writes](0006-at-least-once-delivery-with-idempotent-writes.md)
- [0014. Gate events on their catalog schema at ingestion](0014-gate-events-on-their-catalog-schema-at-ingestion.md)
