---
title: Data health
slug: data-health
purpose: Show staff which events the platform expects, whether data arrives and what is dropped, and how to connect tracking, let admins change the catalog and the source keys, and show admins the input the pipeline dropped.
status: accepted
implementation: partial
area: studio
tags: [ui, studio-v2, studio-v3, events, ingestion, privacy]
created: 2026-11-07
updated: 2026-11-08
version: 2.0
known_issues: ../known-issues/features/data-health.md
---

# Data health

## Purpose

"Is data arriving, and is anything being dropped?" Today an admin answers that from the catalog page, a Grafana dashboard, and `rpk` on the dead-letter topic. The data pages of the studio put it in one place. Every staff user sees the event catalog in a searchable table with each event's schema gate, and one Data > Monitoring section for everything about arriving and dropped data. Admins also change the catalog and the source keys from these pages, and browse the records that ingestion dropped, with the reason for each, in Monitoring's Dropped data tab. A Tracking setup page walks a developer through connecting a website or a server. The owner approved this layout in the Salarose redesign on 2026-11-08.

The studio shows marketers plainer words: Strict for the schema gate, Fields for attributes, Hidden from builder for an inactive event, and Dropped data for dead letters. This contract uses the terms and names the labels where a page shows them.

## Scope

In scope:

- The event catalog view at `/data/events`, with **Add event** for admins.
- The [Monitoring](#monitoring) section at `/data/monitoring`, with three tabs: Overview, Dropped data, which is the dead-letter browser and is for admins, and Dashboards, the pipeline dashboard links.
- The [Tracking setup](#tracking-setup) guide at `/data/tracking`.
- The source keys view at `/data/sources`, for admins, with creating and revoking keys.

Each route lives under `/v2` until the prefix drops, as the [studio shell](studio-shell.md#routes) says. Editing moves into these pages. The classic pages `/admin/events` and `/admin/source-keys` keep working until cutover and then redirect. The earlier route `/data/dead-letters` redirects to `/data/monitoring?tab=dropped`, which opens Monitoring on its Dropped data tab.

Out of scope:

- The rules for changing the catalog and the source keys. The [event catalog](event-catalog.md) owns the catalog's rules, the **Add event** dialog, and the [event detail page](event-catalog.md#event-detail-page) at `/data/events/[id]`. The [data ingestion API](data-ingestion-api.md) owns the source key rules.
- Events that arrive but are not in the catalog.
- Replaying dead letters. An operator does that by hand, as [decision 0017](../architecture/decisions/0017-keep-dropped-ingestion-input-in-a-dead-letter-topic.md) says.
- The dropped-record count on the home page. The [home overview](home-overview.md#health-strip) owns it.

## Terms

| Term | Meaning |
|---|---|
| Event, kind, status, schema gate, required attribute | As the [event catalog](event-catalog.md#terms) defines them. |
| Source key | A key of the [data ingestion API](data-ingestion-api.md), a row of `ingestion_source_keys`. |
| Dead-letter topic | The topic that [event ingestion](../architecture/components/event-ingestion.md) writes dead letters to: `snowplow-parsed-dead-letters` by default, configurable by ING-NFR-03. Studio reads the topic that ingestion writes, so a deployment that renames it renames it for both. |
| Dead letter | A record of the dead-letter topic: a dropped payload or event with its drop reason. [Event ingestion](../architecture/components/event-ingestion.md#interfaces) defines its fields. It holds personal data in clear text. |
| Content | The `payload` or `event` field of a dead letter. Every other field holds no content. |
| Pipeline dashboard | A Grafana dashboard that the deployment declares, such as "Flink jobs". |
| Dropped data | The label the studio shows for dead letters. |
| Window | The time range that Monitoring shows: the last hour, the last 24 hours, or the last 7 days. One choice applies to every tab. |
| Collector address | The address of the deployment's collector, on the customer's own domain, such as `https://collect.acme.com`. Trackers send to it. |
| App id | The name a tracker gives the site or app that sent an event. One per site or app. |

## Behavior

### Event catalog view

`/data/events` lists every event in `user_events`, one row each:

| Column | Value |
|---|---|
| Event | The display name, with the system name below it, such as `com.acme/add_to_cart`. A business event carries the badge "About a product", and an inactive event the badge "Hidden from builder". |
| Checking | "Strict" when the schema gate is on, "Accepts all" when it is off |
| Fields | The number of attributes, and how many are required |
| Added | `created_at` |

A search box matches the typed text anywhere in the system name or the display name, ignoring case. Filter chips narrow by kind, status, and schema gate, and each chip shows how many events it holds. The table sorts by display name and shows 50 rows per page.

Clicking a row opens the event's [detail page](event-catalog.md#event-detail-page), `/data/events/[id]`. An admin can change the event there. An editor sees the same page read-only, since the catalog contract lets editors read the catalog. For an admin, the page header has **Add event**, which opens the event catalog's create dialog. Success opens the new event's detail page.

Above the table, a Data health strip shows the number of records dropped in the last 24 hours and links to [Monitoring](#monitoring). It also shows the number of catalog events receiving data and of quiet events, from `event_volume`, or "Coming later" until that table exists (DHL-FR-14). A side card, "How an event reaches a journey", explains the schema gate in three steps, and **How to send events** opens [Tracking setup](#tracking-setup).

When the catalog is empty, the empty state says "No events in the catalog yet." An admin also gets **Add event** there.

While the data writes area is at stage `preview` ([studio shell](studio-shell.md#staged-release)), the detail page is open only to preview viewers. For an editor without preview access, a row opens a read-only side sheet with the event's description and attribute tree, as before. Every admin is a preview viewer, so an admin always gets the detail page.

### Monitoring

`/data/monitoring` answers "Is data arriving, and is anything being dropped?" for every staff user. Its header holds the window, which applies to every tab, and names the time zone the page shows times in. It has three tabs.

**Overview.** Every staff user sees:

- The pipeline strip of the [home overview](home-overview.md#health-strip), always for the last hour. The home overview owns its numbers.
- The number of dropped records in the window, counted as the Dropped data tab counts them. It links an admin to the Dropped data tab, and tells an editor to ask an admin for details.
- Per-event rows and the Receiving and Quiet tiles, read from `event_volume`, or "Coming later" until that table exists (DHL-FR-14, DHL-FR-18).

**Dropped data.** The [dead-letter browser](#dropped-data), for admins only. An editor gets no record.

**Dashboards.** A link to each pipeline dashboard the deployment declares in the studio's configuration, by name and with a one-line description. Every staff user sees it, since Grafana lets editors view. When the deployment declares none, the tab is hidden from editors and says "No dashboards configured" to admins.

### Tracking setup

`/data/tracking` is a guide that a marketer hands to a developer. Every staff user can read every step and copy every sample. It has two tabs, Website and Server, each in numbered steps, and a side panel.

Website:

1. Choose how to send data, website or server. Mobile apps use the Snowplow mobile trackers with the same collector address.
2. Install the tracker, with the deployment's collector address and app id filled into the code sample, and the settings that the [tracking integration guide](../integration/tracking-guide.md) requires: POST, a cookie domain, and no anonymous tracking.
3. Identify the shopper after login, by the identity rules of the tracking guide.
4. Send the first events: three catalog events, each with its system name, its fields from the catalog, and a code sample. Each links to its detail page.
5. Check it arrived. The step shows, for each of the three events, whether `event_volume` has counted it and when it was last seen, or "Coming later" until that table exists, and links to Monitoring (DHL-FR-14).

Server:

1. Get a source key. An admin gets a link to **Create key** on [Sources](#source-keys-view). An editor is told to ask an admin.
2. Identify the shopper with `user_id` or `anonymous_id`, as the [data ingestion API](data-ingestion-api.md) requires.
3. Send events. This step samples a request to `POST /v1/events` at the deployment's ingestion address, with the batch rules of the data ingestion API (DHL-FR-16). Business events go to `POST /v1/business-events` with the same key.

The side panel lists the catalog as the tracking plan, with each event's system name and a link to Events, lists what gets dropped as the tracking guide says, and links to data import, Sources, and Monitoring.

### Source keys view

`/data/sources`, for admins only, lists every row of `ingestion_source_keys`: the app id, the key hint, the email of the staff user who created it, the creation time, and the status, Active or Revoked with the revocation time. Active keys come first, then by app id. The page never shows a stored key's hash, and shows a key only once, when it is created.

- **Create key** asks for the app id. The result dialog shows the new key once, with **Copy** and "You will not see this key again." Closing the dialog clears the key from the page. The [data ingestion API](data-ingestion-api.md) sets the rules, such as one key that is not revoked per app id and only the hash stored (DIA-FR-16).
- **Revoke** asks for confirmation in a dialog that names the app id and says "Requests with this key will be refused." A revoked key is refused from the next request on (DIA-FR-17).

A "How to send data" card shows a request sample with the deployment's ingestion address and the batch rules of the data ingestion API. The card samples `POST /v1/events` and says that business events go to `POST /v1/business-events` with the same key, as Tracking setup does (DHL-FR-16). A note says that the website and the app send through the tracker and need no key. Until cutover, **Manage in classic** opens `/admin/source-keys`.

### Dropped data

The Dropped data tab of `/data/monitoring`, for admins only, is the dead-letter browser. It lists the newest dead letters first. Example: a tracker release sends `com.acme/add_to_cart` with `product.price` as a string while the schema gate is on. Minh opens the tab and sees 40 rows from the last hour with the reason `schema_invalid` and the detail `product.price not number`, as ingestion logs it. He opens one row's content, sees the event, and knows which release to roll back.

```
Dropped data                       Last 24 hours ▾   Why: any ▾   Record: all ▾
Kept for 7 days by the topic. Older records are gone.

Dropped at        Reason            Record   Detail                     Payload        Size
10:41:07 today    schema_invalid    event    product.price not number   none           
10:40:55 today    no_timestamp      event    dtm                        3f9a…c1       
10:40:55 today    (grouped)         payload                             3f9a…c1        18 KB
```

Windows, ordering, and paging use each record's Kafka timestamp, as the home page's dropped-record count does. The Dropped at column shows the record's `dropped_at`. A drop replayed after a restore is written again with a later time, so it can show twice. Each row shows the drop time, the reason, the record type, the detail, the first and last characters of the payload id, and, for a payload record, its size and whether it was cut. A payload record with no reason groups the event records that point at it, and reads "(grouped)". The page lists the newest 100 records in the chosen window and offers **Load older**. The windows are the last hour, the last 24 hours, and the last 7 days, with the last 24 hours as the default. Filters narrow by reason and by record type, events or requests. The page shows each reason by a plain label with its code, and explains each one:

| Code | Label |
|---|---|
| `schema_invalid` | Didn't fit Strict rules |
| `no_timestamp` | No time on the event |
| `invalid_event_id` | Missing or broken event id |
| `event_not_decoded` | Event couldn't be read |
| `payload_not_decoded` | Request couldn't be read |

The page says that it is for admins only, that records can hold personal data, that the studio keeps no copy and logs who opens a record, and that nothing on it changes or replays data. When a record is gone before the admin opens it, the page says that the 7-day limit removed it.

Content is hidden until the admin opens it, one record at a time, with **Show content**. An event record's content shows as formatted JSON. A payload record's content shows as Base64 with its size and a **Copy** button, because decoding Thrift is a replay tool's job. Studio fetches the content of one record only when the admin opens it.

The page shows the topic's retention, read from the topic's configuration, and says that older records are gone. It does not change the retention.

### Who may see dropped data

Decision 0017 says dead letters hold personal data in clear text, and recommends that only the ingestion job and on-call operators can read the topic. Studio v2 maps "on-call operators" to the `admin` role. So:

- Only admins see the Dropped data tab, the records, and their content. The server checks the role on every request, the content request included.
- Studio commits no offsets and leaves no consumer group behind, so browsing moves nothing for any other reader. Each read, one page of the list or one record's content, uses a consumer group of its own, named under a fixed studio prefix with a part unique to that read. The read seeks to the offsets it needs, commits nothing, and deletes its group when it ends. A group that a crash leaves behind holds no offsets. Where the broker enforces authorization, studio reads the topic with a Kafka identity that may only read it. A broker without authorization, such as the AWS Free Plan cluster's, lets every client read every topic, with or without studio. The studio page does not widen that.
- Studio keeps no copy of a record. It writes none to Postgres, to a log, or to a cache, and every response that carries a record is marked not to be stored by the browser or a proxy.
- Studio logs who opened which record's content, by topic, partition, and offset, at info level, without the content.


## Functional requirements

| Id | Requirement |
|---|---|
| DHL-FR-01 | `/data/events` must list every catalog event with the columns of [Event catalog view](#event-catalog-view), with search, the three filters with their counts, and 50 rows per page, and a Data health strip with the records dropped in the last 24 hours and a link to Monitoring. |
| DHL-FR-02 | A row must open the event's detail page, `/data/events/[id]`, editable for an admin and read-only for an editor, as [CAT-FR-10](event-catalog.md#functional-requirements) says. |
| DHL-FR-03 | The Dashboards tab of `/data/monitoring` must link to each pipeline dashboard the deployment declares, for every staff user. |
| DHL-FR-04 | `/data/sources` must be admin-only and must list every source key with the fields of [Source keys view](#source-keys-view). It must let an admin create and revoke keys under [DIA-FR-16 and DIA-FR-17](data-ingestion-api.md#functional-requirements). It must show a key only once, in the result of its creation, and clear it from the page when that dialog closes, and must never show a key's hash. |
| DHL-FR-05 | The Dropped data tab of `/data/monitoring` must be admin-only, and the server must check the role on every request that returns a record or its content. The tab's URL is `/data/monitoring?tab=dropped`. A request for `/data/dead-letters` must redirect there, keeping the `/v2` prefix while it lasts: `/v2/data/dead-letters` goes to `/v2/data/monitoring?tab=dropped`. |
| DHL-FR-06 | The dead-letter browser must list the newest records first in the chosen window, 100 at a time, with the fields of [Dropped data](#dropped-data), the reason and record-type filters, and each reason's label and code. |
| DHL-FR-07 | Content must stay hidden until an admin opens it for one record, and studio must fetch it only then. |
| DHL-FR-08 | Studio must read the dead-letter topic without committing offsets, through a consumer group that serves one read and is deleted when that read ends. Where the broker enforces authorization, studio's identity for this read must be allowed to read only that topic. |
| DHL-FR-09 | Studio must not store, log, or cache a dead letter's content. Every response that carries a record must forbid storage by the browser and proxies. |
| DHL-FR-10 | Studio must log each opening of a record's content with the admin's id, the topic, the partition, and the offset, and without the content. |
| DHL-FR-11 | The dead-letter browser must show the topic's retention and must not change it. |
| DHL-FR-12 | The catalog pages must write only through the event catalog's actions, and the source keys page only through the data ingestion API's source key actions. Monitoring and Tracking setup must not write to any table or produce a record to any topic. The broker's records of DHL-FR-08's consumer groups in its internal offsets topic are not a write by studio. |
| DHL-FR-13 | `/data/monitoring` must be the one place for event monitoring, with the tabs Overview, Dropped data, and Dashboards, and one window that applies to every tab. Overview must show every staff user the home overview's pipeline strip and the number of dropped records in the window. |
| DHL-FR-14 | Until the `event_volume` table exists, every place that shows per-event volume, last-seen time, per-event drops, the Receiving and Quiet counts, or the Tracking setup live check must say "Coming later" and show no number. Once it exists, each of those places must read them from `event_volume`: `accepted` rows for volume, drop-reason rows for drops, and the latest `last_seen_at` for last seen. An event with no row shows "Not yet", never 0 as a guess. |
| DHL-FR-15 | `/data/tracking` must show every staff user the steps of [Tracking setup](#tracking-setup), with the deployment's collector address and app id in the code samples and the catalog's events as the tracking plan. Only an admin gets the link to create a source key. |
| DHL-FR-16 | Tracking setup and the source keys view must send a developer with person events from a server to `POST /v1/events`, and one with business events to `POST /v1/business-events`. |
| DHL-FR-17 | The source keys view must show a request sample with the deployment's ingestion address and the batch rules of the [data ingestion API](data-ingestion-api.md). |
| DHL-FR-18 | Overview must show one row per catalog event with whether it received data in the window, its volume over the last 7 days, when it was last seen, and its drops in the window, problems first. An event is Receiving with at least one event in the window, Quiet with none in 7 days, and "Not yet" when never seen. Drops that no event can be tied to, such as a whole payload or an event without a name, count only in the total. |

## Non-functional requirements

| Id | Requirement |
|---|---|
| DHL-NFR-01 | The event catalog view must load within 1 second at the 95th percentile for a catalog of 1,000 events. |
| DHL-NFR-02 | A page of the dead-letter browser must load within 3 seconds at the 95th percentile. Studio must read at most 10,000 records for one page, and must say so when it stopped there. |

## Interfaces

| Direction | Interface | Use |
|---|---|---|
| UI | `/data/events`, `/data/monitoring`, `/data/tracking`, `/data/sources`, under `/v2` until the prefix drops | The pages. `/data/dead-letters` redirects to `/data/monitoring?tab=dropped`. |
| Read | `user_events`, `user_event_fields` | The catalog |
| Write | `user_events`, `user_event_fields` | Only through the event catalog's actions, as the [event catalog](event-catalog.md#interfaces) says |
| Read | `ingestion_source_keys`, `system_users` | Source keys and their creators' emails |
| Write | `ingestion_source_keys` | Only through the source key actions, as the [data ingestion API](data-ingestion-api.md#interfaces) says |
| Read | Kafka dead-letter topic | Records by offset and timestamp, and the topic's `retention.ms` |
| Read | Studio's configuration | The pipeline dashboards, by name and address, and the collector address, the app ids, and the ingestion address that Tracking setup and the source keys view show |

## Failure handling

| Case | Behavior |
|---|---|
| The dead-letter topic does not exist or cannot be read | The tab shows "Dropped data could not load", the reason, such as "topic not found" or "not authorized", and **Try again**. |
| A record is not valid JSON or lacks `record` | The row shows "Unreadable record" with its partition and offset. The other rows show. |
| The window holds more than 10,000 records | The page shows the newest it read and says that it stopped. |
| The topic's retention cannot be read | The page says that the retention is unknown. |
| No dashboards are configured | The Dashboards tab follows [Monitoring](#monitoring). |
| The collector address or the app id is not configured | Tracking setup shows a placeholder in its place and says that the deployment has not set it. |

## Acceptance criteria

- Given 60 catalog events, when the viewer searches "cart", then only events whose system or display name contains "cart" show, at most 50 per page. (DHL-FR-01)
- Given `com.acme/add_to_cart` with the gate on and 2 of 3 attributes required, then its row shows Strict and "3, 2 required". (DHL-FR-01)
- Given an admin, when he opens the row of `com.acme/add_to_cart`, then `/data/events/[id]` opens for that event with its changes offered. Given an editor, the same page opens read-only. (DHL-FR-02)
- Given a deployment that declares the "Flink jobs" dashboard, then the Dashboards tab links to it for an editor and for an admin. (DHL-FR-03)
- Given an editor, when she requests `/v2/data/sources` or the Dropped data tab of `/v2/data/monitoring`, then she gets the forbidden state and no record. (DHL-FR-04, DHL-FR-05)
- Given an admin, when he requests `/v2/data/dead-letters`, then `/v2/data/monitoring` opens on Dropped data. (DHL-FR-05)
- Given an editor on Overview with 12 records dropped in the window, then she sees 12 and no link to the records. (DHL-FR-13)
- Given an admin who picks the last 7 days on Overview and switches to Dropped data, then Dropped data shows the last 7 days. (DHL-FR-13)
- Given a deployment with no `event_volume` table, then the catalog strip, Overview's per-event rows and tiles, and Tracking setup's step 5 say "Coming later" and show no per-event number. (DHL-FR-14)
- Given `event_volume` holds 3 `accepted` events of `com.acme/add_to_cart` in the last hour and no row for `com.acme/purchase`, then Overview shows `com.acme/add_to_cart` as Receiving with volume 3 and its last-seen time, and `com.acme/purchase` as "Not yet". (DHL-FR-14, DHL-FR-18)
- Given one `schema_invalid` drop of `com.acme/add_to_cart` and one undecodable payload in the window, then the event's row shows 1 drop and the drop total shows 2. (DHL-FR-14, DHL-FR-18)
- Given an editor on `/v2/data/tracking`, then the install sample holds the deployment's collector address and app id, the tracking plan lists the catalog's system names, and no step offers **Create key**. (DHL-FR-15)
- Given a deployment whose ingestion address is `https://api.acme.com`, then the source keys card samples a request to that address with the batch limits of 500 events and 1 MiB. (DHL-FR-17)
- Given the Server tab or the source keys card, then it samples `POST /v1/events` at the ingestion address and names `POST /v1/business-events` for business events. (DHL-FR-16)
- Given an editor's session, when it requests the content of a dead letter directly, then studio refuses it. (DHL-FR-05)
- Given a revoked source key, then its row shows Revoked with the time, and no row shows a key or a hash. (DHL-FR-04)
- Given an admin who creates a key for `inventory-service`, then the result dialog shows the key once with **Copy**, and after the dialog closes the page holds no copy of the key. Given the admin revokes it, then the confirmation names `inventory-service`, and the row then shows Revoked. (DHL-FR-04)
- Given 150 dead letters in the last 24 hours, then the page shows the newest 100, and **Load older** shows the other 50. (DHL-FR-06)
- Given the reason filter `schema_invalid`, then only `schema_invalid` records show. (DHL-FR-06)
- Given the page loaded, then the browser holds no record content until the admin clicks **Show content**, and then only that record's. (DHL-FR-07)
- Given an admin who loads two pages of the list and opens one record's content, then the topic has no committed offsets of studio, and after each read ends, the broker lists no consumer group under studio's prefix. (DHL-FR-08)
- Given an admin who opens a record's content, then studio's log has one line with the admin's id, the partition, and the offset. (DHL-FR-10)
- Given an admin who browses and opens content, then no log line, table row, or cache entry holds the content, and every record response carries `Cache-Control: no-store`. (DHL-FR-09)
- Given a viewer who uses every control on the dead-letter browser, then no row changes, and studio produces no record to any topic. The broker's group records for the reads may appear in its internal offsets topic. (DHL-FR-12)
- Given an admin who creates an event and a source key from the data pages, then the only rows that change are the ones the event catalog's and the source key actions write. (DHL-FR-12)
- Given a catalog of 1,000 events, then the catalog view loads within 1 second at the 95th percentile. (DHL-NFR-01)
- Given 20,000 records in the last 24 hours, then the browser reads at most 10,000, shows the newest of them, and says that it stopped. (DHL-NFR-02)
- Given a topic with 7-day retention, then the page says that records are kept for 7 days. (DHL-FR-11)

## Open questions

- Who may read dead letters. Decision 0017 recommends that only the ingestion job and on-call operators read the topic. This contract maps on-call operators to the `admin` role, as the lead's default, until the owner reviews decision 0017's access rule.
- Monitoring's windows. This contract keeps the dead-letter browser's last hour, last 24 hours, and last 7 days. The studio shell's ranges are Today, 7 days, and 30 days.
- A "Used by" column in the catalog list, with each event's number of journeys and segments. Today only the detail page lists uses.
- Per-source health on the source keys view, such as the last request and the accepted and rejected counts. No contract asks for it yet.

## Related

- [Studio shell](studio-shell.md)
- [Event catalog](event-catalog.md)
- [Data ingestion API](data-ingestion-api.md)
- [Tracking integration guide](../integration/tracking-guide.md)
- [Event ingestion](../architecture/components/event-ingestion.md)
- [0017. Keep dropped ingestion input in a dead-letter topic](../architecture/decisions/0017-keep-dropped-ingestion-input-in-a-dead-letter-topic.md)
- [Home overview](home-overview.md)
- [Known issues](../known-issues/features/data-health.md)
