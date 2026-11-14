---
title: The ingestion API writes plain JSON to its own topic, and leaves history to the import
id: "0049"
status: accepted
date: 2026-11-05
tags: [ingestion, api, source-keys, tenancy]
supersedes: []
superseded_by: []
---

# 0049. The ingestion API writes plain JSON to its own topic, and leaves history to the import

## Context

The [data ingestion API](../../features/data-ingestion-api.md) lets a customer post its own events over HTTPS. Its draft left five questions open: how accepted events reach event ingestion, which body formats it takes, whether it imports history, who manages source keys, and how a key names the customer when one deployment serves several.

The owner answered all five on 2026-11-05, and the contract and the code follow them. No decision record held the answers or the reasons. This record writes them down, dated the day of the owner's choice.

## Decision

1. **Path.** The API writes accepted person events to its own topic, `ingestion-api-events`, in a format with no Snowplow fields. [Event ingestion](../components/event-ingestion.md) reads it next to the collector's topic and maps each message to the parsed event a tracker hit with the same values would give. Business events go to `business-events`.
2. **Format.** The body is plain JSON only. The API does not accept the Snowplow tracker protocol. A sender that speaks the tracker protocol posts to the collector.
3. **Backfill.** The API takes no history past the allowed lateness of event-time processing. History arrives through the [data import](../../features/data-import.md), whose event datasets have their own batch path ([decision 0040](0040-import-through-a-batch-path-and-a-separate-store.md)).
4. **Keys.** An admin creates and revokes source keys in `studio`. An operator does not.
5. **Tenancy.** A deployment serves one customer. A source key names a source inside that customer, not a customer. [Decision 0027](0027-multi-tenancy.md), on serving several customers from one deployment, stays proposed.

## Why

**Own topic.** Wrapping each event as a collector payload on `snowplow-good` would need no new parser, but it would make the API build Snowplow's Thrift envelope and base64 contexts by hand, and tie the API's format to the tracker protocol. A topic of its own keeps the API's format the one in its contract, and the mapping lives in one place in event ingestion. Identity stitching and the parsed event stay the same for both paths (DIA-FR-07). [Segment's HTTP API](https://www.twilio.com/docs/segment/connections/sources/catalog/libraries/server/http-api), [RudderStack's HTTP API](https://www.rudderstack.com/docs/api/http-api/), and [mParticle's Events API](https://docs.mparticle.com/developers/apis/http/) each take their own JSON shape, and convert it into the internal event inside the platform, not at the sender.

**Plain JSON only.** The collector already speaks the tracker protocol. A second format on the API would be a second parser to keep equal to the collector's, for senders that can post to the collector today.

**History through the import.** Every job computes metrics in event time with an allowed lateness. A year-old event posted live lands outside every window, or reopens state the jobs have already closed. [Amplitude](https://amplitude.com/docs/apis/analytics/batch-event-upload) separates its live [HTTP API](https://amplitude.com/docs/apis/analytics/http-v2) from a batch upload for large and historical loads for the same reason. The import is that batch path here: it loads event datasets into a separate store and reaches conditions through profile attributes ([decision 0041](0041-imported-data-reaches-conditions-as-profile-attributes.md)), without replaying history through the stream.

**Admins manage keys.** A key is created when a customer team wires a new source, which happens without an operator. Studio already has admin roles, a server-side session check, and an audit of who created a key. Segment and RudderStack issue write keys from their apps in the same way.

**One customer per deployment.** That is how the platform runs, and decision 0027's option A. A key that named a customer would need a tenant id on every topic key, table, and state key first, which is decision 0027's whole open question.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Collector payloads on `snowplow-good` | Ties the API's format to the tracker protocol and makes the API build Snowplow envelopes. |
| Accept the tracker protocol as a second body | A second parser for senders that can already post to the collector. |
| A backfill path on the API | Live event-time processing cannot take history past its lateness. The import's batch path already loads it. |
| Operators manage keys | Puts an operator in every new source, with no audit in `studio`. |
| A key that names the customer | Needs multi-tenancy, which decision 0027 has not chosen. |

## Consequences

- Event ingestion owns the mapping from the API's format to a parsed event. A new API field changes that mapping and the contract together.
- A customer with history imports it as an event dataset. Imported history reaches conditions as profile attributes, not as live triggers.
- Serving a second paying customer from one deployment needs decision 0027 first. Until then, each customer gets a deployment.

## Related

- [Data ingestion API](../../features/data-ingestion-api.md)
- [Event ingestion](../components/event-ingestion.md)
- [Data import](../../features/data-import.md)
- [0027. Serve several customers from one deployment](0027-multi-tenancy.md)
- [0048. The ingestion API ignores catalog status, counts its rate limit per replica, and allows two keys per app id](0048-ingestion-keeps-tracker-parity-a-per-replica-limit-and-two-keys-for-rotation.md)
