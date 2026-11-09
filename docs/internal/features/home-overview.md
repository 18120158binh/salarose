---
title: Home overview
slug: home-overview
purpose: Show a marketer, on one page, how their journeys did over a time range and whether anything in the pipeline is wrong.
status: accepted
implementation: partial
area: studio
tags: [ui, studio-v2, analytics, journeys]
created: 2026-11-07
updated: 2026-11-08
version: 0.2
known_issues: ../known-issues/features/home-overview.md
---

# Home overview

## Purpose

A marketer who opens studio in the morning wants to know how the journeys did, and whether anything is broken. Today studio opens on the campaign list, which holds no numbers. The home overview at `/v2` answers both from data the platform already writes. Entries, messages requested, and watch outcomes come from the journey transitions. Lag and dropped input come from the pipeline. Every number on the page has one definition, given below, so that two people who read it get the same answer.

## Scope

In scope:

- The KPI row: entries, messages requested, watch outcomes, and engine lag, each against the previous period.
- The journeys table: active journeys with their numbers and a 7-day trend.
- Continue where you left off: the viewer's most recently changed journeys and drafts.
- The health strip: engine lag and dropped records in the last hour.

Out of scope:

- Delivery, opens, clicks, conversions, and revenue. Nothing reports them back to the platform yet. They arrive in phase 2, and until then the page does not show them.
- Per-step numbers of one journey. [Journey analytics](journey-builder.md#node-analytics) owns them.
- The shell, time ranges, and page states. The [studio shell](studio-shell.md) owns them.
- The banner that moves browser drafts to the server. The [journey builder](journey-builder.md#moving-browser-drafts-to-the-server) owns it, and this page only shows it.

## Terms

| Term | Meaning |
|---|---|
| Transition | A row of `user_campaign_state_transitions`. It records one node that one entry completed, on one branch. |
| Entry | One person's pass through one campaign, keyed by (`canon_id`, `campaign_id`, `entry_id`). See the [glossary](../product/glossary.md). |
| Event time | A transition's `event_timestamp`, in epoch milliseconds: when the event that completed the node happened. |
| Write time | A transition's `transitioned_at`: when the engine wrote the row. |
| Engine lag | For one transition with `node_type` `setup` or `check`, or with `node_type` `watch` and `branch` `success`, write time minus event time, or 0 when the difference is negative. Only these transitions complete at the time of their own trigger event. A condition split, and every automatic child, takes its parent's completion time as event time. A watch's `timeout` and a delay's `next` take the watch deadline as event time, and the deadline counts from the parent's completion time, so after a parent that completed late the deadline is already past. In each of these cases the difference would hold the time the person waited, not the engine's delay. |
| Dead-letter topic | The topic that [event ingestion](../architecture/components/event-ingestion.md) writes dead letters to: `snowplow-parsed-dead-letters` by default, configurable by ING-NFR-03. Studio reads the topic that ingestion writes, so a deployment that renames it renames it for both. |
| Message requested | A transition of an engagement node. The engine asked the external sender to send the message. Whether it was delivered is not known. |
| Watch outcome | A transition of a watch node on `success` or `timeout`. A `DelayPath` watch completes on `next` and has no outcome. |
| Active journey | A row of `campaigns` with `status` `active`. |
| Time range, previous period | As the [studio shell](studio-shell.md#time-ranges) defines them. |

## Behavior

Lan opens `/v2` with Last 7 days selected, on 2026-11-10 at 09:30 in Ho Chi Minh City.

```
Home                                                  [Today] [Last 7 days] [Last 30 days]
                                                      Times in Asia/Ho_Chi_Minh
┌ Entries ─────────┐ ┌ Messages requested ┐ ┌ Watch success ───┐ ┌ Engine lag (p95) ┐
│ 12,480    +18%   │ │ 9,312      +9%     │ │ 41%    -3 pts    │ │ 2.1 s     -12%   │
│ ▁▂▃▅▆▇█          │ │ ▁▂▂▄▅▆▇            │ │ 3,100 of 7,560   │ │ ▃▃▂▂▂▂▁          │
└──────────────────┘ └────────────────────┘ └──────────────────┘ └──────────────────┘
Pipeline: lag 1.8 s in the last hour · 0 dropped records in the last hour · last journey step 4 s ago

Active journeys                                                            View all
Name                 Owner            Entries   Messages   Last 7 days   Change
Cart abandonment     lan@example.com    6,021      5,880   ▁▃▄▅▆▇█        +1,204
Browse abandonment   minh@example.com   3,410      2,002   █▇▆▅▄▃▂          -890
...

Continue where you left off
Tet win-back · Draft · changed 20 min ago
Cart abandonment · Active · changed 2 h ago
Welcome series · Paused · changed yesterday
```

Clicking a journey in either list opens `/v2/journeys/[id]`, which shows a published journey's analytics and opens a draft in the builder. The health strip links to the data pages. **Create journey** opens `/v2/journeys/new`.

Every link on the page opens a v2 page once that page has shipped to every staff user. Until then, a link opens the classic page that does the same job, and disappears when the viewer has none. **View all** opens `/campaign`. A journey opens `/campaign/[id]` for its owner or an admin. For anyone else, the journey shows without a link, because the classic builder refuses them. The health strip links an admin to `/admin/events`, and shows an editor the count without a link. The change that ships a v2 area moves its links to v2, and after cutover no link on the page opens a classic page. Paths in this contract carry the `/v2` prefix until it drops, as the [studio shell](studio-shell.md) says.

When the browser holds classic drafts for the viewer, the page shows the journey builder's banner that offers to move them to the server ([JBD-FR-28](journey-builder.md#moving-browser-drafts-to-the-server)). The banner is not one of the page's data regions.

### KPI row

Each card shows its value for the time range, the change against the previous period, and a daily series over the range as a sparkline. Today has no sparkline. Every KPI counts the transitions of every campaign, whether it is active, paused, or deleted, because the work happened. The KPIs therefore need not equal the sum of the journeys table, which lists only active journeys.

| KPI | Value | Up is |
|---|---|---|
| Entries | The number of transitions with `node_type` `setup` and event time in the range. A setup node completes once per entry, so this counts entries. A person with two entries counts twice. The design said "people who entered". Counting entries is the lead's default, because the journeys table and node analytics count entries too. | Good |
| Messages requested | The number of transitions with `node_type` `engagement` and event time in the range | Good |
| Watch success | Over the transitions with `node_type` `watch`, `branch` `success` or `timeout`, and event time in the range, the `success` count divided by the sum of both counts, as a whole percent. Its change is in percentage points. The card also shows both counts. With no such transition, the value is "No watches finished" and has no change. | Good |
| Engine lag (p95) | The 95th percentile of engine lag over the `setup` and `check` transitions and the `watch` transitions on `success`, with write time in the range. With none, the value is "No activity" and has no change. | Bad |

Entries, messages, and watch outcomes count by event time, so a range holds what happened in it. A transition that arrives late joins the range it belongs to, so a past range can still change. Most late rows arrive within the engine's 10-minute late window. Two kinds can come later. A watch timeout carries its deadline as event time even when the timer flow was down for hours, and a condition split completes at its parent's completion time whenever its conditions come to hold. Messages requested counts by event time too, so that a backlog or a replay does not move a day's messages into the day the engine caught up. The cost is that a message sent after a wait at a condition split counts on the day its parent step completed, not on the day the engine asked for it. Engine lag counts by write time, because it measures how far behind the engine was while it worked in the range.

### Journeys table

The table lists active journeys. For each, it shows:

- the name and the owner's email, or "No owner";
- entries in the range, counted as the Entries KPI is, for that `campaign_id`;
- messages requested in the range, counted as the KPI is, for that `campaign_id`;
- a sparkline of daily entries over the last 7 calendar days, today included, whatever the range;
- the change in entries against the previous period, as a signed count.

The table sorts by the absolute value of the signed change, largest first, and then by name. It shows at most 10 rows and a **View all** link to `/v2/journeys`. Every staff user sees every active journey here, not only their own. When no journey is active, the table's empty state says "No journey is running" and offers **Create journey**, which opens `/v2/journeys/new`.

### Continue where you left off

The list holds up to 5 of the viewer's journeys, newest `updated_at` first. It draws from the rows of `campaigns` whose `created_user` is the viewer, of any status, and from the rows of `journey_drafts` whose owner is the viewer, shown as Draft. Each shows the name, the status, and the time of the last change. A draft that lives only in the browser is not listed, because the server cannot see it. When the viewer owns no journey and no draft, the empty state offers **Create journey**, as above.

### Health strip

| Item | Value | States |
|---|---|---|
| Lag | The 95th percentile of engine lag over the `setup` and `check` transitions and the `watch` transitions on `success` written in the last 60 minutes | Good up to 60 seconds, warning up to 5 minutes, bad above |
| Dropped records | The number of records in the dead-letter topic whose Kafka timestamp falls in the last 60 minutes, counted from each partition's offsets | Good at 0, warning above 0 |
| Last journey step | The newest write time of a `setup`, `check`, or `watch` transition, on any branch. These are the node types Lag reads, so one index serves both. A condition split is written on its own when its conditions come to hold, with its automatic children. So while only condition splits complete, this time can be older than the engine's last write. | Shown as a relative time |

With no such transition in the last 60 minutes, Lag reads "No journey activity in the last hour" and is neither good nor bad. The dropped-record count includes the `payload` record that groups dropped events, so it can exceed the number of dropped events. It never shows the records' content, so editors see it too. For an admin, the item links to the [dead-letter browser](data-health.md#dropped-data). For an editor, it links to the [event catalog view](data-health.md#event-catalog-view). When studio cannot read the topic, the item reads "Not available" with the reason. The thresholds are the lead's default.

## Algorithm

For a time range `[start, end)` in epoch milliseconds and its previous period `[pstart, pend)`:

1. Entries: count transitions where `node_type = 'setup'` and `start <= event_timestamp < end`.
2. Messages requested: count transitions where `node_type = 'engagement'` and `start <= event_timestamp < end`.
3. Watch success: `s` = count where `node_type = 'watch'`, `branch = 'success'`, and the event time is in the range. `o` = the same with `branch = 'timeout'`. The value is `round(100 * s / (s + o))` when `s + o > 0`.
4. Engine lag: for each transition with `node_type` in (`setup`, `check`), or with `node_type = 'watch'` and `branch = 'success'`, and with `start <= transitioned_at < end`, take `max(0, transitioned_at - event_timestamp)`. The value is the 95th percentile of those lags, by the continuous percentile rule.
5. Repeat steps 1 to 4 for `[pstart, pend)`. Compute the change by the shell's rule.
6. Daily series: split the range into calendar days in the viewer's time zone and apply the step to each day.

Worked example. Transitions with event times on 2026-11-09 local: 3 setup rows, 2 engagement rows, watch rows on `success`, `success`, `timeout`, and one watch row on `next` from a delay. Entries is 3, messages requested is 2, and watch success is 67%, from 2 of 3. The delay row counts in no KPI.

## Functional requirements

| Id | Requirement |
|---|---|
| HOM-FR-01 | `/v2` must show the KPI row, the health strip, the journeys table, and Continue where you left off, each as its own data region. |
| HOM-FR-02 | Entries, messages requested, and watch success must be computed as [Algorithm](#algorithm) says, by event time, over the transitions of every campaign. |
| HOM-FR-03 | Engine lag must be the 95th percentile of `max(0, transitioned_at - event_timestamp)` over the transitions with `node_type` `setup` or `check`, or with `node_type` `watch` and `branch` `success`, and write time in the range. |
| HOM-FR-04 | Each KPI must show its change against the previous period by the [studio shell](studio-shell.md#change-against-the-previous-period) rule, and, for Last 7 days and Last 30 days, a daily sparkline. |
| HOM-FR-05 | The journeys table must list only active journeys, with the columns of [Journeys table](#journeys-table), sorted by the absolute value of the change in entries, then by name, at most 10 rows, with a link to `/v2/journeys`. |
| HOM-FR-06 | The journeys table and the KPIs must show every journey's numbers to every staff user. |
| HOM-FR-07 | Continue where you left off must list up to 5 of the viewer's own journeys and server drafts by `updated_at`, newest first. |
| HOM-FR-08 | The health strip must show lag, dropped records, and the last journey step, with the states of [Health strip](#health-strip), and must link to the data page that the viewer's role may open. |
| HOM-FR-09 | The page must not show delivery, open, click, conversion, or revenue numbers. |
| HOM-FR-10 | Clicking a journey on the page must open `/v2/journeys/[id]`. |
| HOM-FR-11 | **Create journey** must open `/v2/journeys/new`. Each other link must open its v2 page once that page has shipped to every staff user. Until then, it must open the classic page that does the same job for the viewer, or be absent when the viewer has none. After cutover, no link may open a classic page. No link may open a v2 route that does not exist. |

## Non-functional requirements

| Id | Requirement |
|---|---|
| HOM-NFR-01 | Each data region must load within 2 seconds at the 95th percentile for Last 30 days, measured on the deployed database. [Decision 0035](../architecture/decisions/0035-compute-journey-analytics-from-transitions-on-read.md) says what happens when it does not. |
| HOM-NFR-02 | The page must not change any row or produce a record to any topic, except through the browser-draft move of [JBD-FR-28](journey-builder.md#functional-requirements) when the viewer chooses it. It reads `user_campaign_state_transitions`, `campaigns`, `journey_drafts`, and `system_users`, and the offsets of the dead-letter topic without a consumer group, so the broker records no group for it either. |
| HOM-NFR-03 | Studio must read the dead-letter topic's offsets at most once every 15 seconds, however many viewers open the page. |

## Interfaces

| Direction | Interface | Use |
|---|---|---|
| UI | `/v2?range=today`, `7d`, or `30d` | The page |
| Read | `user_campaign_state_transitions` | `node_type`, `branch`, `campaign_id`, `event_timestamp`, `transitioned_at` |
| Read | `campaigns` | `id`, `name`, `status`, `created_user`, `updated_at` |
| Read | `journey_drafts` | The viewer's drafts: `id`, `name`, `owner_id`, `updated_at` |
| Read | `system_users` | The owner's email |
| Read | Browser storage | Whether the browser holds classic drafts for the viewer, for the move banner |
| Read | Kafka dead-letter topic | Partition offsets at the start of the last 60 minutes and at the end. Never the records. |

[Decision 0035](../architecture/decisions/0035-compute-journey-analytics-from-transitions-on-read.md) lists the indexes these reads need. They go in `schema.sql`, the only DDL source.

## Failure handling

| Case | Behavior |
|---|---|
| A KPI query fails or times out | That card shows its error state. The other regions load. |
| The dead-letter topic cannot be read | Dropped records reads "Not available" with the reason. The other items show. |
| A journey in the table has no transitions in the range | It shows 0 entries, 0 messages, and a flat sparkline. |
| The viewer's owner row was deleted | Continue where you left off is empty. |
| A campaign was deleted | Its transitions still count in the KPIs. It is not in either list. |

## Acceptance criteria

- Given the transitions of the [worked example](#algorithm) and the range Today on 2026-11-09, then Entries is 3, Messages requested is 2, and Watch success is 67% with "2 of 3". (HOM-FR-02)
- Given a setup transition with event time 2026-11-09T23:59:59 local and write time 2026-11-10T00:00:05 local, then Entries counts it on 2026-11-09, and engine lag counts it on 2026-11-10. (HOM-FR-02, HOM-FR-03)
- Given three setup transitions written in the range with lags of 1 s, 2 s, and 30 s, one check transition with a write time before its event time, and a condition split transition written 2 days after its event time, then engine lag is the 95th percentile of 0 s, 1 s, 2 s, and 30 s, and the condition split is left out. (HOM-FR-03)
- Given a person who waits 2 days at a condition split and then qualifies, and no other transition in the last hour, then the health strip's Lag reads "No journey activity in the last hour", not 2 days. (HOM-FR-03, HOM-FR-08)
- Given a person who waits 2 days at a condition split, qualifies, and reaches a `Wait 1 hour` delay under it, then the delay's deadline is already past, and its `next` transition is written at once with an event time about 2 days old. Engine lag and the health strip's Lag leave it out, and with no other transition in the last hour, Lag reads "No journey activity in the last hour". The same holds for a watch under the split that times out. (HOM-FR-03, HOM-FR-08)
- Given 120 entries in Last 7 days and 100 in the 7 days before, then Entries shows "+20%" and a sparkline of 7 daily points. Given Today, no sparkline shows. (HOM-FR-04)
- Given a paused campaign with entries in the range, then the KPIs count them and the journeys table does not list it. (HOM-FR-02, HOM-FR-05)
- Given 12 active journeys, then the table shows 10, sorted by the absolute value of the change in entries, so +1,204 comes before -890, and **View all** opens `/v2/journeys`. (HOM-FR-05)
- Given an editor and an active journey another user owns, then the table shows its numbers. (HOM-FR-06)
- Given a viewer who owns 7 campaigns, then Continue where you left off lists the 5 with the newest `updated_at`. (HOM-FR-07)
- Given a viewer with a server draft changed 20 minutes ago and 5 campaigns changed earlier, then Continue where you left off lists the draft first, as Draft, and 4 campaigns. Clicking the draft opens it in the builder. Another user's draft is never listed. (HOM-FR-07, HOM-FR-10)
- Given a viewer with classic drafts in this browser, then Home shows the banner that offers to move them. Given a viewer who does not choose **Move drafts**, then no row changes. (HOM-NFR-02)
- Given 4 dead-letter records written in the last hour, then the health strip shows 4 dropped records in the warning state. An admin's link opens `/v2/data/dead-letters`, and an editor's opens `/v2/data/events`. (HOM-FR-08)
- Given no transition written in the last 60 minutes, then Lag reads "No journey activity in the last hour". (HOM-FR-08)
- Given the page, then it shows no delivery, open, click, conversion, or revenue number. (HOM-FR-09)
- Given `/v2` with the KPI query failing, then the other three regions still load, the journeys table included. (HOM-FR-01)
- Given a click on a journey in the table or in Continue where you left off, then `/v2/journeys/[id]` opens. (HOM-FR-10)
- Given `/v2/journeys` not shipped yet, then **View all** opens `/campaign`. A journey opens `/campaign/[id]` for its owner or an admin, and has no link for an editor who does not own it. (HOM-FR-11)
- Given the data pages not shipped yet and 4 dropped records, then an admin's link opens `/admin/events`, and an editor sees the count with no link. (HOM-FR-11)
- Given any stage, then **Create journey**, in the journeys table's empty state and in Continue where you left off, opens `/v2/journeys/new`. (HOM-FR-11)
- Given cutover has happened, then no link on the page opens `/campaign`, `/segments`, `/admin`, or `/platform`. (HOM-FR-11)
- Given a viewer who uses every control on the page, then no row of any table changes. (HOM-NFR-02)
- Given 20 viewers who load `/v2` within 15 seconds, then studio reads the dead-letter topic's offsets once. (HOM-NFR-03)
- Given a deployed database with 30 days of transitions, when Last 30 days loads, then each region answers within 2 seconds at the 95th percentile, or the result of decision 0035's check is recorded. (HOM-NFR-01)

## Open questions

None. Two choices the design left open are the lead's defaults, marked where they apply: counting entries rather than people, and the health strip thresholds.

## Related

- [Studio shell](studio-shell.md)
- [Journey builder: node analytics](journey-builder.md#node-analytics)
- [Data health](data-health.md)
- [Journey execution](../architecture/components/journey-execution.md): how nodes complete and which transitions it writes
- [0035. Compute journey analytics from the transitions on read](../architecture/decisions/0035-compute-journey-analytics-from-transitions-on-read.md)
- [Known issues](../known-issues/features/home-overview.md)
