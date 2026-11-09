---
title: Store segment membership and evaluate every segment
id: "0038"
status: accepted
date: 2026-11-08
tags: [segments, rules, customer-decision, profile-writer, data-import]
supersedes: ["0031"]
superseded_by: []
---

# 0038. Store segment membership and evaluate every segment

## Context

[Decision 0031](0031-reusable-segments-with-entry-triggers.md) specified segments as conditions and as entry triggers. The decision job was to keep a membership flag per person only for segments that an entry trigger or a business-event audience uses, and studio was to show no segment size. None of it is built. Customer decision reads no segments ([DEC-KI-41](../../known-issues/components/customer-decision.md)), so a journey that names a segment reaches nobody.

On 2026-11-08 the owner decided that studio v3 builds the segment runtime, so that segments target people, and that segment size, approved earlier for phase 2, shows. The same day the owner approved data import, which brings customers who exist only as imported rows in `customer_attributes`, with no tracked person and no events. The decision job never evaluates such a customer, because it evaluates people at their events.

## Decision

**Every segment is evaluated at each of a person's events.** The decision job reads `segments` through its CDC publication, `segments_pub`, and keeps a membership flag per person and segment for every segment, not only those a trigger uses. Entry triggers still fire only for segments a campaign starts on, with the re-entry setting of decision 0031. `segment_membership` conditions still evaluate the definition at that moment and never read a flag.

**At events, a journey starts only on an entry the job sees.** A segment-entry trigger fires when a person's flag goes from out to in while the campaign is active. A person who is already a member when the campaign is published, or whom the job evaluates against the segment for the first time, does not enter at their next event. A first evaluation only records the flag. This changes what decision 0031 promised. The owner decided it on 2026-11-08.

**Current members enter only when the marketer asks.** A segment-entry journey has a publish option, **Also include current members**, off by default and chosen per journey. When it is on, the publish records a request. The segment membership pass reads the segment's tracked members at publish time from `segment_members` and sends each one, once, on the topic `current-member-entries`, at most 1,000 a second and under the WAL governor. Customer decision turns each message into a setup trigger with one entry id per publish, so the re-entry setting and every other entry rule apply. When the option is off, only people who enter after the publish start the journey. Imported-only members are not included, because they have no tracked identity to message. The owner decided the option and its default on 2026-11-08.

**Flags last as long as their segment.** Flags do not expire with metric state. A person with no flag, after a start without flags, gets one at their next event, and the job publishes their current membership, `entered` or `exited`, without starting a journey. When a segment is deleted, the job clears its flags and publishes `exited` for every member, so the profile writer deletes the segment's rows. Both rules are the lead's defaults, pending owner review.

**A segment's metrics stay `LIVE` while the segment exists.** Decision 0031 kept them `LIVE` only while an active campaign used the segment. A paused metric is not counted, so an unused segment's behavior conditions would run on empty series. Its size would be wrong, and the flags it fed would be wrong when its first campaign went live. Keeping them `LIVE` costs the state of a few more series per person. This is the lead's default, pending owner review. The other option, showing size only for segments that an active campaign uses, leaves the flags wrong.

**Membership changes are published and stored.** When a flag changes, the job emits a message on the topic `segment-membership-changes`, keyed by `canon_id`, with `canon_id`, `segment_id`, `entered` or `exited`, the `event_id` that caused it, and the time. The profile writer sinks that topic into `segment_members` (`segment_id`, `canon_id`, `since`), keyed by `canon_id`. It upserts on `entered` and deletes on `exited`, so a replay converges.

**A nightly pass covers imported-only customers.** Once a night, after the data-import metric pass has published, a batch job evaluates every segment for each customer key in `customer_attributes` that `identity_graph` does not hold as a tracked `user_id`. It writes only changed rows to `segment_import_members` (`segment_id`, `customer_key`, `since`), and deletes a key's rows once the key maps to a tracked person. It runs the same condition evaluator as the decision job. Behavior conditions see no events, and date attributes compare against the pass's start time. It emits no trigger and starts no journey. It pauses when free WAL or disk space runs low, under the same governor as the data-import jobs.

**Size is a count of stored rows.** A segment's size is its rows in `segment_members` plus its rows in `segment_import_members`. Studio states the basis: tracked people as of their last activity, imported customers as of the last nightly pass. Size never answers a condition.

**Each table has one writer, and neither joins a CDC publication.** The profile writer writes `segment_members`, and the nightly pass writes `segment_import_members`.

**Features come online in order.** Each step runs on the cluster before studio offers its control: live `segment_membership` conditions and `LIVE` segment metrics first, then the membership sink, then flags, entry triggers, and the membership topic, then size, then the nightly pass. The sink runs before flags publish, so it reads the whole rollout.

The owner decided to build the runtime and the nightly pass on 2026-11-08. Tracking every segment, the evaluator shared with the nightly pass, and the two-table layout are the design writer's calls, and the owner approved the design on 2026-11-08. The owner decided the same day that the nightly pass never starts journeys for imported-only customers, which was the design's default.

## Why

**Size needs a count for every segment.** A flag kept only for trigger segments cannot count a segment that only a condition uses, and the segment list shows every segment. The cost of tracking all of them is one evaluation per segment per event, plus a cached profile lookup when a segment has a profile condition. That is small at today's handful of segments. Per-event latency is measured on the cluster when flags ship, and the job can go back to tracking a subset if it grows.

**One evaluator, not two.** Computing size in SQL from `user_metrics` would put a second implementation of the condition language next to the Java one, and the two would drift. The nightly pass runs the same evaluator from the shared Java code, so a segment means the same thing to a tracked person and to an imported-only customer.

**Two tables keep writers apart.** A Flink sink and a nightly batch job writing one table would contend for rows whenever a customer key becomes a tracked person. [Decision 0002](0002-key-every-write-by-its-owner.md) records the deadlock that kind of sharing caused. With one table per writer, and each keyed by its owner, no two writers touch a row.

**Outside CDC, writing only changes.** Neither table has a consumer that needs a stream, so neither adds decoded WAL. Both write a row only when membership changes. A night with no import and stable dates writes close to nothing, which matters while replication slots are a known risk (#320).

**The WAL fits the #320 cap.** The fix for #320, in pull request #337, keeps 10 checkpoints of CDC window and caps a slot's WAL at 8 GB. Its largest hold is the outbox job's, 11 checkpoints of 60 seconds, about 11 minutes, so the figures below size that hold. On this branch, JEX-NFR-10 still states the older 120-checkpoint window. Whichever of the two pull requests merges second reconciles it. The tables of this decision join no publication, but every slot still holds the WAL they write.

The estimates use 290 events a second on average and 3,000 at peak ([SIM-NFR-04](../../features/traffic-simulator.md#non-functional-requirements) and the #320 measurement), 500,000 people, and 20 segments, which is more than today's handful. A change costs one message of about 250 bytes and one `segment_members` upsert or delete of about 1 KB of WAL, the per-row figure that the data-import design uses. An `exited` for a row that does not exist deletes nothing and writes no WAL. An `entered` for a row that already holds its `since` writes nothing either ([PRW-FR-12](../components/profile-writer.md#functional-requirements)).

| Case | Changes | WAL | In the 11-minute hold |
|---|---|---|---|
| Steady state, average | 290 events/s x 20 segments x 0.5% that change = 29 a second | 29 KB/s | 19 MB |
| Steady state, peak | 3,000 x 20 x 0.5% = 300 a second | 300 KB/s, 5% of the 6 MB/s in #320 | 200 MB |
| First rollout of flags | Every person gets a flag per segment at their next event, so 500,000 x 20 = 10 million messages, about 2.5 GB on the topic | Only the 10% assumed to be members write a row, so 1 million upserts, about 1 GB in all, at most 1 MB/s under the sink's cap | 660 MB, beside the pipeline's 4.0 GB at 6 MB/s, so 4.6 GB of the 8 GB cap |
| Repeated changes every 30 days | 500,000 x 20 / 30 days, about 4 a second | None for an unchanged row | None |
| Current members at publish | 1,000 members a second at most | About 2 KB per member, the #320 per-event figure (estimate), so 2 MB/s | 1.3 GB. With the rollout and the pipeline at once, 9 MB/s, or 5.9 GB of the 8 GB cap |

The change rate of 0.5% per evaluation and the 10% member share are guesses. The rollout of flags measures both on the cluster, with the topic's bytes a second. The sink writes at most 1,000 rows a second, about 1 MB/s of WAL, which is the lead's default ([PRW-NFR-06](../components/profile-writer.md#non-functional-requirements)). The first rollout then takes about 17 minutes of sink time. The pass that enters current members pauses under the same governor as the nightly pass when slot headroom or free disk runs low, so a large segment cannot burst past the cap. A segment of 1,000,000 members takes about 17 minutes and writes about 2 GB in all. The topic is keyed by `canon_id`, not `segment_id`, so a large segment's changes, such as the `exited` burst when it is deleted, spread over every partition.

**The sink runs before the flags, and size corrects itself.** The profile writer's membership sink runs on the cluster before customer decision starts to publish changes ([PRW-FR-12](../components/profile-writer.md#functional-requirements)). Otherwise the sink could start after the topic's retention dropped the rollout's `entered` changes, and nothing would publish them again. Size would then undercount until each member left and came back. The order closes the gap that a rollout opens. For any later loss, such as a sink down longer than a day, the job publishes each flag's value again at the person's first event 30 days or more after it last published that flag ([DEC-FR-37](../components/customer-decision.md#functional-requirements)). An unchanged row costs no WAL, so the repeat costs only topic bytes. A member who has no event after the loss stays miscounted until they do, which the size's basis, "as of their last activity", already says. The 30-day repeat is the lead's default.

**The topics fit the shared disk.** Kafka and Postgres share the 30 GB root disk of `data-1`. Per #337's record, about 7 GB stays free once 8 GB of WAL is held. `segment-membership-changes` and `current-member-entries` keep 24 hours ([DEC-NFR-15](../components/customer-decision.md#non-functional-requirements)). Steady state puts about 630 MB a day on the membership topic, at 29 changes a second of 250 bytes, and the 30-day repeat adds about 85 MB. On the day of the rollout, up to 2.5 GB more arrives. A publish that includes 1,000,000 current members adds about 300 MB. The worst day is about 3.5 GB of the 7 GB free (estimate). The rollout of flags measures the topic's bytes on the disk before the sink step closes.

The flags cost state as well. A flag, with the times it last changed and was last published, is about 70 bytes in RocksDB (estimate). Flags never expire, so state grows with every person ever seen. 500,000 people ever seen and 20 segments hold about 700 MB. The rollout of flags measures it, with per-event latency.

**The nightly pass does not trigger.** Data import's non-goal holds, so imported data does not start a journey by itself. Messaging a customer with no tracked person needs contact details and identity work that later data-import phases bring. An imported-only customer counts in size. The design promised that such a customer enters a segment-entry journey at their first tracked event. That promise is withdrawn, because the job records a first evaluation without starting a journey. Once tracked, they enter a segment-entry journey in one of two ways. One is a publish with **Also include current members** while they are a member. The other is a later change from out of the segment to in. The same holds for a new visitor whose first event already makes them a member, such as of a segment with only profile conditions.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Track only segments that a trigger or audience uses, as decision 0031 said | Cannot show size for a segment that only a condition uses |
| Compute size in SQL from `user_metrics` and `customer_attributes` | A second implementation of the condition language that drifts from the job's |
| Answer `segment_membership` conditions from the stored flag | Stale when a window passes without an event. Decision 0031's reason stands. |
| One membership table written by both the sink and the nightly pass | Two writers per row whenever a customer key becomes a tracked person |
| Enter current members at their next event, as decision 0031 said | Starts every current member within a day, unpaced, and the marketer cannot turn it off |
| Have customer decision enter every flagged member when it reads the publish | One unpaced burst inside the job, and no profile lookup is possible while it walks its state |
| Let the nightly pass emit entry triggers | Imported-only customers have no tracked identity to message, and data import promises that imported data does not trigger |
| Put the membership tables in a CDC publication | No consumer needs the stream, and it adds WAL the slots retain |

## Consequences

- [Customer decision](../components/customer-decision.md) reads `segments_pub`, keeps a flag per person and segment, and emits `segment-membership-changes`. Its state is additive. A restore from a savepoint without flags gives each person a flag at their next event and starts no journey.
- A campaign published on a segment that already has members reaches only people who enter after the publish. Decision 0031 had current members enter at their next event. With a flag for every segment, that would start the journey for every current member within a day of the publish. Starting only on a seen entry also matches what marketers know from other tools, where "added to segment" means a new member.
- [Campaign management](../../features/campaign-management.md) sets a metric `LIVE` while any segment names it (CMP-FR-03), and a segment save or delete sets the mode as publish does. When the rule ships, a one-time update sets every existing segment's metrics `LIVE`, before flags ship. Decision 0031's last consequence, that a segment's metric is `LIVE` only while an active campaign uses the segment, no longer holds.
- The [profile writer](../components/profile-writer.md) gains one sink, keyed by `canon_id`.
- The [segment membership pass](../components/segment-membership-pass.md#current-members-at-publish) gains a duty that runs every minute, as its own schedule beside the nightly pass and under the same governor. One run sends at a time, under a lease on its row, so the cap of 1,000 a second holds for the whole duty. It sends a segment's current members on `current-member-entries` after a publish that asks for it, and [customer decision](../components/customer-decision.md#current-members-at-publish) enters them. Studio inserts the request in `current_member_entries` in the publish transaction.
- A batch job, the [segment membership pass](../components/segment-membership-pass.md), runs once a night from the `event-processor` image, after the data-import metric pass.
- [Segments](../../features/segments.md) shows size with its basis and its two stated limits. A tracked member whose behavior window passes with no new event stays counted until their next event. A customer key that becomes a tracked person can count twice until the next nightly pass.
- Exit triggers and time-based re-evaluation stay out of scope. Leaving a segment starts nothing.
- [DEC-KI-41](../../known-issues/components/customer-decision.md) narrows to business-event matches once flags and entry triggers ship.

## Related

- [0031. Reusable segments with entry triggers](0031-reusable-segments-with-entry-triggers.md)
- [0002. Key every write by its owner](0002-key-every-write-by-its-owner.md)
- [0030. Make every rule decision in one keyed operator](0030-make-every-rule-decision-in-one-keyed-operator.md)
- [Customer decision](../components/customer-decision.md)
- [Profile writer](../components/profile-writer.md)
- [Segment membership pass](../components/segment-membership-pass.md)
- [Segments](../../features/segments.md)
- [Journey builder](../../features/journey-builder.md)
