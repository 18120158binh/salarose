---
title: Customer lookup
slug: customer-lookup
purpose: Let a marketer find one customer by an id, an email, a phone, or a name, and see their identities, activity, messages, segments, journeys with the step each one is at, and metric values.
status: accepted
implementation: partial
area: studio
tags: [ui, studio-v2, identity, journeys, metrics]
created: 2026-11-07
updated: 2026-11-08
version: 0.4
known_issues: ../known-issues/features/customer-lookup.md
---

# Customer lookup

## Purpose

When a customer complains that they got a message twice, or never got one, a marketer needs to see what the platform did for that person. Today nobody can, short of querying Postgres by hand. Customer lookup finds a person by what the marketer has: a user id, a device id, an email, a phone, or a name. It shows one page per person: the devices and accounts stitched to them, an activity timeline, the messages journeys sent them, the segments they are in, every journey entry with the step it is at, the person's metric values, and their imported attributes. Email, phone, and name come only from imported attributes, masked as [data import](data-import.md#privacy) says. The owner moved the timeline, messages, segment membership, and contact search from phase 2 to now on 2026-11-08.

## Scope

In scope:

- Search from one box, "Search by id, email, phone or name", at `/v2/customers`, and from **Find another customer** on every profile. Ids, emails, and phones match exactly. A name matches any part of it.
- The profile at `/v2/customers/[canonId]`: identities, activity timeline, messages received, segment membership, journey entries, metric values, and imported attributes.

Out of scope:

- Changing a person's data, merging people, or removing a person from a journey. v2 does not write in phase 1.
- How identities are stitched. [Identity stitching](../architecture/components/identity/identity-stitching.md) owns that.

## Terms

| Term | Meaning |
|---|---|
| Person | One `canon_id`, the stitched id of one customer across devices and logins. |
| Person id | The `canon_id`. Shown as secondary text, never as a page title. |
| Device id | A `domain_userid`, a first-party cookie or app device id. |
| User id | A `user_id`: the customer's account id on the tracked site. |
| Identity | One `identity_graph` row of the person: a device id, and the user id seen with it if any. |
| Entry | One person's pass through one campaign, keyed by (`canon_id`, `campaign_id`, `entry_id`). |
| Waiting step | A node where an entry is now, as the [journey builder](journey-builder.md#node-analytics) defines it. |
| Contact search | A search by email, phone, or name. It matches imported attributes, not ids. |
| Activity | One tracked event of the person, as ingestion accepted it. |
| Message | One engagement transition of the person: a notification request that a journey handed to the sender. |
| Metric value | The value of one metric over the person's whole stored series, as of the series clock. |

## Behavior

A customer writes to support that they got two "Still thinking about it?" pushes. Support passes on their account id, `usr_1001`. Lan types `usr_1001` in the search box on `/v2/customers`, or in the command palette, and lands on the person's profile.

```
usr_1001                                          Person id 7d2c…e9 · 3 devices
First seen 2026-10-02 · Last seen 12 min ago

Identities
Device id                               User id    First seen     Last seen
a1b2c3d4-…                              usr_1001   2026-10-02     12 min ago
9f8e7d6c-…                              usr_1001   2026-10-20     3 days ago
0a1b2c3d-…                              (none)     2026-10-01     2026-10-02

Journeys
Journey             Entered            Last step                       Now
Cart abandonment    Today 08:02        Push "Still thinking about it?"  Finished
Cart abandonment    Yesterday 19:40    Watch com.acme/add_to_cart, 1 day         Waiting until today 19:40
Welcome series      2026-10-02         End                             Finished

Metrics
Metric                                   Value          As of
Added to cart                            7              12 min ago
  number of times, last 30 days
  com.acme/add_to_cart · COUNT
Order completed                          2,580,000 ₫    2 h ago
  total of order.total, last 30 days
  com.acme/order_completed · SUM
```

The two entries of Cart abandonment explain the two pushes. Clicking a journey opens its analytics.

### Search

1. Trim the typed text. Empty text searches nothing.
2. Find every `canon_id` where one of these holds:
   - an `identity_graph` row has `domain_userid` equal to the text;
   - an `identity_graph` row has `user_id` equal to the text or to one of its contact forms, defined below;
   - `canon_id` equals the text, in `identity_graph`, `user_campaign_state_transitions`, or `user_metrics`.
3. Drop the empty `canon_id`.
4. With no match, show "No customer matches this search." With one, open its profile straight away. With several, list them, newest activity first, by last seen. The list has these columns:

| Column | Value |
|---|---|
| Customer | The person's imported name when they have one, and their newest user id below it. "Anonymous visitor" without a user id. |
| Email | The person's imported email, masked as [data import](data-import.md#privacy) says, or empty. Empty for everyone until customer lists are imported. |
| Phone | The person's imported phone, masked the same way, or empty. Empty for everyone until customer lists are imported. |
| Devices | The number of the person's identities |
| Last seen | The latest `updated_at` of the person's identities |
| Open | A link to the profile |

**Contact search.** The same box also matches imported attributes. Step 2 adds every person whose imported attributes hold the text as an email or a phone, exactly, and every person whose imported name contains the text, so `Lan` finds Nguyễn Thị Lan. Steps 3 and 4 then apply. Email and phone show masked, as [data import](data-import.md#privacy) says, for every viewer (CUS-FR-11). The profile's **Find another customer** box runs the same search on `/v2/customers?q=`.

A customer key that `customer_attributes` holds and `identity_graph` does not hold as a `user_id` is an imported-only customer. A search equal to such a key opens its imported profile (CUS-FR-41).

Ids, emails, and phones match exactly and case-sensitively, because ids are. A search for `usr_100` does not find `usr_1001`. A name matches any part of it, so a short text can match many people.

**Contact forms.** A deployment may fill `user_id` with an email or a phone, so the user id match also tries the text's contact forms. The lead decided this normalization on 2026-11-08:

- A text with an `@` is an email. It also matches its lower-case form.
- A text of only digits, spaces, dots, dashes, and parentheses, with an optional leading `+`, and 9 to 12 digits, is a phone. Without a `+`, it matches its `+84` form and its leading-0 form: `0912 345 678` matches `+84912345678` and `0912345678`. A text that starts with `+84` also matches its leading-0 form. Any other `+` number matches its digits after the `+` only.
- Device ids and person ids match the trimmed text only.

Names match without case or diacritics. Contact search against imported attributes and name search start once `customer_attributes` exists. Until then the hint under the search box says that name search starts once customer lists are imported.

### Profile

The page title is the person's newest user id, by `updated_at` among their identities with a user id. The person's name from their imported attributes shows beside it, when they have one. The owner decided this on 2026-11-08. A person with no user id is titled "Anonymous visitor". The header shows the person id, the number of devices, first seen as the earliest `created_at` of their identities, and last seen as the latest `updated_at`.

**Identities.** Every `identity_graph` row of the person, newest `updated_at` first, with the device id, the user id or "(none)", first seen, and last seen. The table shows 50 rows and says how many more exist.

**Activity timeline.** The person's tracked events and journey entries, newest first, grouped by day in the studio's time zone. An event row shows the event's display name, the device it came from, its system name, such as `com.acme/add_to_cart`, and its time. A journey entry row reads "Entered journey" and the journey's name, at the event time of the entry's setup transition. Filter chips above the timeline narrow it: **All**, the default; **Events**, tracked events other than orders; **Orders**, events of the order event; and **Journeys**, journey entries. Which catalog event counts as an order is an open question. The timeline shows 50 rows and offers **Load earlier activity** for the next 50 (CUS-FR-12). Until the store of a person's events is decided, the timeline region reads "Not available" with the reason, and shows no chips and no rows.

**Messages received.** One row per engagement transition of the person in `user_campaign_state_transitions`, newest first by `event_timestamp`, up to 50 with the count of the rest. Each row shows the channel from the transition's `action_json` `type`, with its `title`, else its `subject`, else the first 60 characters of its `body`, in quotes; the journey's name, or "Deleted journey" when no `campaigns` row exists; the status; and the event time. The status reads "Sent" as an icon and a word, meaning the journey handed the request to the sender. Once the sender reports, it reads "Delivered" or "Failed". With no row, the region reads "No message sent to this shopper yet." (CUS-FR-13)

**Segments.** Every segment the person is in now, by stored membership in `segment_members` and `segment_import_members`, as [segments](segments.md) defines it, each linking to its segment page (CUS-FR-14). Until stored membership exists, the region reads "Not available" with the reason.

**Journeys.** One row per entry of the person in `user_campaign_state_transitions`, newest first by the time it entered. The table shows 50 rows and says how many more exist.

| Column | Value |
|---|---|
| Journey | The campaign's name from `campaigns`, linking to `/v2/journeys/[id]`. "Deleted journey" with the campaign id when no row exists. |
| Entered | The event time of the entry's setup transition. Without one, the earliest event time of the entry. |
| Last step | The label of the entry's transition with the latest event time. A tie goes to the latest write time, then to the node deepest in the tree, then to the greatest `node_id`. A parent and its automatic children share an event time and are often written in one transaction, so the depth rule picks the child. The [journey builder](journey-builder.md#node-labels) defines node labels. |
| Now | "Waiting at" and the label of each waiting step of the entry, by the rule in [node analytics](journey-builder.md#node-analytics). For a waiting watch, "until" its deadline: the event time of its parent's transition plus the watch's `limit_millis` from that transition's `children`. "Finished" when the entry has no waiting step. "Journey deleted" when the campaign has no `campaign_nodes` rows. |

A waiting step is computed against the campaign's current nodes. A step removed since the entry reached it no longer counts as waiting.

**Metrics.** One row per `user_metrics` row of the person, with its definition from `user_metric_definitions`. The label has three lines: the event's display name from `user_events.display_name`, or its system name without one, such as "Added to cart"; a function line naming the function, the attribute when there is one, and the retention, such as "number of times, last 30 days" or "total of order.total, last 30 days"; and the system name with the function, such as "`com.acme/add_to_cart` · COUNT". The value is the definition's function over every bucket of the series, by the [metric functions](../architecture/components/customer-decision.md#metric-functions) with no window, taken at the series clock. "As of" is the series clock. The retention in the label counts back from the series clock, not from now, so a series last updated 10 days ago shows its 30 days up to that clock. A function that has no value, such as `AVG` over buckets that hold no numeric value, reads "No value". For `MEDIAN` and `DISTINCT_COUNT`, which need the series' summaries decoded, the value reads "Not shown yet" with the occurrence count. That is the lead's default for phase 1. A metric whose definition is `PAUSED` shows its stored value, marked "Not updating".

**Imported attributes.** One section per source in `customer_attributes` for the person's newest user id, titled with the source's display name, with each attribute's display name and value, and "As of" the nightly pass that wrote the row. PII values are masked on the server for every viewer, admins included. Admins get **Reveal**, a separate logged request that returns one value, by the rules of [data import](data-import.md#privacy). A person with no row shows no section. Until data import stores `customer_attributes`, no profile shows this section. An imported-only customer's profile is titled with the customer key and shows only this section, under the note "This customer is known only from your customer list. Journeys, numbers and devices appear once they use the site or app while signed in." (CUS-FR-41)

**Empty states.** A region with no rows says so (CUS-FR-15):

| Region | Text |
|---|---|
| Devices and accounts | "No device or account is joined to this shopper." |
| Journeys | "This person has not entered a journey." |
| Metrics | "No metric counts this person's behavior yet." |

### Who may look

Every staff user may search and open any profile. The design made this call for both roles, as every product in the market research does, because the page held ids and metric values and no contact details. Imported contact details reach an editor only masked, so the call still holds. A user id that a deployment fills with an email address shows as it is.

## Functional requirements

| Id | Requirement |
|---|---|
| CUS-FR-01 | `/v2/customers` must find people by exact device id, user id, or person id, by the rules of [Search](#search), from one box, "Search by id, email, phone or name". Every profile must offer **Find another customer**, which runs the same search. |
| CUS-FR-02 | One match must open the profile straight away. Several must be listed newest activity first, with the columns Customer (name and newest user id), Email and Phone masked, Devices, Last seen, and Open. None must show "No customer matches this search." |
| CUS-FR-03 | `/v2/customers?q=` with a text must run the search on load, so that the command palette and links can start one. |
| CUS-FR-04 | The profile must show the title with the person's name beside it when imported attributes hold one, the person id, the number of devices, first seen, and last seen, as [Profile](#profile) defines them. |
| CUS-FR-05 | The profile must list the person's identities, newest first, up to 50, with the count of the rest. |
| CUS-FR-06 | The profile must list the person's entries with journey, entered, last step, and now, as [Profile](#profile) defines them, up to 50, newest first, with the count of the rest. |
| CUS-FR-07 | A waiting watch must show its deadline, computed from its parent's transition. |
| CUS-FR-08 | The profile must list the person's metric values, computed with no window at the series clock, by the [metric functions](../architecture/components/customer-decision.md#metric-functions). Each label must show the event's display name, the function line, and the system name with the function, as [Profile](#profile) says. |
| CUS-FR-09 | Every staff user must be able to search and open any profile. |
| CUS-FR-10 | The page must not show an email, phone, or name from any source other than the person's ids and their imported attributes. Imported PII must follow CUS-FR-40. |
| CUS-FR-11 | The search box must also find people by exact email or phone, and by any part of the name, in their imported attributes, as [Search](#search) says, and must show every email and phone masked. |
| CUS-FR-12 | The profile must show the person's tracked events and journey entries, newest first, grouped by day, 50 at a time, with **Load earlier activity**, and filter chips **All**, **Events**, **Orders**, and **Journeys**. |
| CUS-FR-13 | The profile must list the messages journeys sent the person, one per engagement transition, newest first, with channel, content, journey, time, and status. |
| CUS-FR-14 | The profile must list the segments the person is in now, from stored membership. |
| CUS-FR-15 | Devices and accounts, Journeys, and Metrics must each show the empty-state text in [Profile](#profile) when they have no rows. |
| CUS-FR-40 | The profile must show the person's imported attributes by source, as [Profile](#profile) says, with every PII value masked on the server for every viewer, and **Reveal** for admins as a separate logged request that returns one value. |
| CUS-FR-41 | A search equal to the customer key of an imported-only customer must open a profile titled with that key that shows only its imported attributes, under the imported-only note in [Profile](#profile). |

## Non-functional requirements

| Id | Requirement |
|---|---|
| CUS-NFR-01 | A search must answer within 1 second at the 95th percentile. It must use an index for each match: device id, user id, person id, email, phone, and the part-of-name match. |
| CUS-NFR-02 | The profile's regions must each load within 2 seconds at the 95th percentile for a person with 1,000 transitions. |
| CUS-NFR-03 | Studio must not log a search text or a person's ids at a level above debug. |

## Interfaces

| Direction | Interface | Use |
|---|---|---|
| UI | `/v2/customers`, `/v2/customers?q=` | Search |
| UI | `/v2/customers/[canonId]` | Profile |
| Read | `identity_graph` | `domain_userid`, `user_id`, `canon_id`, `created_at`, `updated_at` |
| Read | `user_campaign_state_transitions` | The person's entries and messages: `campaign_id`, `entry_id`, `node_id`, `node_type`, `branch`, `event_timestamp`, `transitioned_at`, `children`, `action_json` |
| Read | `campaigns`, `campaign_nodes` | Journey names, current nodes, and labels |
| Read | `user_metrics`, `user_metric_definitions`, `user_events` | Series, their definitions, and the event's display name |
| Read | `segment_members`, `segment_import_members`, `segments` | The person's segments |
| Read | Open: the store of the person's tracked events | Activity timeline. See [Open questions](#open-questions). |
| Read | `customer_attributes`, `import_record_types`, `import_record_type_versions`, `import_metric_definitions`, `import_metric_passes` | Imported attributes, their display names and PII flags, and their pass |
| Write | `pii_access_log` | One `reveal` row per reveal |

`identity_graph` has no index on `canon_id` for rows without a user id. Phase 1 adds one in `schema.sql`, as [decision 0035](../architecture/decisions/0035-compute-journey-analytics-from-transitions-on-read.md) lists.

## Failure handling

| Case | Behavior |
|---|---|
| A person id with no identity row but with transitions or metrics | The profile opens with an empty identities table and the title "Anonymous visitor". |
| A person id with nothing anywhere | The profile shows "No customer has this id." |
| A metric's buckets do not parse | That row reads "Not available". The other rows show. |
| A message's `action_json` does not parse | The row shows the channel name "Engagement" with no title. |
| The journeys region fails | The Journey entries and Waiting now numbers in the summary read "Not available". |
| A transition's `children` do not parse | The watch shows as waiting without a deadline. |
| One region's query fails | That region shows its error state. The others load. |

## Acceptance criteria

- Given `identity_graph` rows (`a1`, `usr_1001`, `P1`) and (`b2`, null, `P1`), when the viewer searches `usr_1001`, `a1`, `b2`, or `P1`, then the profile of `P1` opens. (CUS-FR-01, CUS-FR-02)
- Given the search `usr_100` and no user id equal to it, then "No customer matches this search." shows. (CUS-FR-01, CUS-FR-02)
- Given an open profile, when the viewer types `usr_7` in **Find another customer**, then `/v2/customers?q=usr_7` opens and runs the search. (CUS-FR-01)
- Given two people with imported names "Nguyễn Thị Lan" and "Trần Lan Anh", when the viewer searches `Lan`, then both are listed with their masked email and phone, devices, and last seen, the one seen last on top. Given the search `nguyen@gmail` and an imported email `nguyen@gmail.com`, then no one matches. (CUS-FR-02, CUS-FR-11)
- Given a `customers` row with email `nguyen@gmail.com` for customer key `usr_1001`, when an editor searches `nguyen@gmail.com`, then the profile of the person with user id `usr_1001` opens, and no response holds the clear email. (CUS-FR-11)
- Given a person with 60 tracked events, then the timeline shows the 50 newest grouped by day, and **Load earlier activity** shows the other 10. (CUS-FR-12)
- Given a person with a `com.acme/product_viewed` event, a `com.acme/order_completed` event, and one entry of Cart abandonment, and `com.acme/order_completed` as the order event, then **All** shows three rows, **Events** shows the view, **Orders** shows the order, and **Journeys** shows "Entered journey Cart abandonment". (CUS-FR-12)
- Given a person with no identity row, no entry, and no `user_metrics` row, then the profile shows the three empty-state texts in [Profile](#profile). (CUS-FR-15)
- Given a person with an SMS engagement transition in Welcome series at 2026-10-02 09:15 local, then Messages received lists SMS, the message, "Welcome series", that time, and "Sent". (CUS-FR-13)
- Given a person in `segment_members` for segment "Hà Nội shoppers" and in no other segment, then Segments lists only "Hà Nội shoppers". (CUS-FR-14)
- Given `usr_7` seen with two devices that have different person ids, then the search lists both people. (CUS-FR-02)
- Given an identity with user id `+84912345678`, when the viewer searches `0912 345 678`, then that person's profile opens. Given an identity with user id `lan@example.com`, when the viewer searches `Lan@Example.com`, then that person's profile opens. (CUS-FR-01, CUS-FR-11)
- Given the command palette entry **Look up customer "usr_1001"**, then `/v2/customers?q=usr_1001` opens and runs the search. (CUS-FR-03)
- Given a person whose identities carry user ids `usr_1` updated yesterday and `usr_2` updated today, then the title is `usr_2`. Given that person's imported name "Nguyễn Thu Hà", then it shows beside `usr_2`. Given a person with no user id, the title is "Anonymous visitor". (CUS-FR-04)
- Given a person with two entries of Cart abandonment, then the journeys table has two rows. (CUS-FR-06)
- Given a check and its engagement child with the same event time and write time, then Last step is the engagement. (CUS-FR-06)
- Given a person with 60 identities, then the table shows the 50 newest and says "10 more". (CUS-FR-05)
- Given a search for `usr_1001`, then studio's log at info level and above holds no line with `usr_1001` or the person id. (CUS-NFR-03)
- Given a person with 1,000 transitions on the deployed database, then each profile region loads within 2 seconds at the 95th percentile, and the search plan uses an index for each match. (CUS-NFR-01, CUS-NFR-02)
- Given an entry whose last transition is a check on `yes` with a watch child on `yes` limited to 1 day, and the check's event time 2026-11-09T19:40 local, then Now reads "Waiting at" the watch's label "until" 2026-11-10T19:40 local. (CUS-FR-06, CUS-FR-07)
- Given an entry whose last transition is an End node, then Now reads "Finished". (CUS-FR-06)
- Given a series of `com.acme/add_to_cart` `COUNT` with 30 days' retention and buckets of counts 2, 3, and 2, then the value is 7, as of the series clock, and the label reads "Added to cart", "number of times, last 30 days", and "`com.acme/add_to_cart` · COUNT". (CUS-FR-08)
- Given an editor, when she opens a profile of a person in another user's journey, then it loads. (CUS-FR-09)
- Given any profile, then no email, phone, or name appears except as a user id or an imported attribute. (CUS-FR-10)
- Given a person with user id `0912345678` and a `customers` row with `loyalty_tier` `Gold` and `emails` `["nguyen@gmail.com"]`, when an editor opens the profile, then the Customers section shows `Gold` and `n***@gmail.com`, and the response holds no clear email. When an admin opens it, then the response is masked the same way. When the admin reveals the email, then one request returns only it, and `pii_access_log` gains a `reveal` row. (CUS-FR-40)
- Given a customer key `c-77` with an `orders` row and no `identity_graph` row, when the viewer searches `c-77`, then a profile titled `c-77` opens with only its imported attributes and the imported-only note. (CUS-FR-41)

## Open questions

One choice the design left open is the lead's default: hiding `MEDIAN` and `DISTINCT_COUNT` values in phase 1. Pending owner review:

- Which imported attribute is a person's name? Datasets flag email and phone columns, but no column is marked as the name.
- Which catalog event counts as an order for the timeline's **Orders** chip?
- Where does the timeline read a person's events? No table holds tracked events per person today.
- Where is the sender's delivery report stored, so that a message can read "Delivered" or "Failed"?

## Related

- [Studio shell](studio-shell.md)
- [Journey builder: node analytics](journey-builder.md#node-analytics)
- [Identity stitching](../architecture/components/identity/identity-stitching.md)
- [Customer decision: metric functions](../architecture/components/customer-decision.md#metric-functions)
- [Data model](../architecture/data-model.md)
- [Known issues](../known-issues/features/customer-lookup.md)
