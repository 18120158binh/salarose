---
title: Event ingestion known issues
contract: ../../architecture/components/event-ingestion.md
updated: 2026-11-08
verified_at: f971ed5a
---

# Event ingestion known issues

Java paths are relative to `event-processor/src/main/java/com/cdp/platform/`.

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| ING-KI-12 | Risk | Anyone can send events, with any user id | |
| ING-KI-13 | Risk | `event_volume` rows are never deleted | |

## ING-KI-12. Anyone can send events, with any user id

- **Symptom.** Anyone who knows the collector URL can post hits. A forged hit that carries another person's `uid` and a `duid` joins the sender's device to that person in identity stitching. The sender's later events then count toward that person's metrics, and can move that person through journeys and send them notifications. A forged hit with a `uid` and no `duid` takes that person's `canon_id` straight from `identity_graph`.
- **Cause.** `infra/local/collector.config` sets no authentication, origin check, or rate limit. It listens on `0.0.0.0` port 8080 (lines 4 and 5), and `infra/local/docker-compose.yml` publishes that port (line 46). The [runtime checklist](../../../../.agents/skills/deploy/references/runtime-checklist.md) deploys every target with the same file. `ParseSnowplowEvent.processEvent` in `jobs/eventparser/transforms/ParseSnowplowEvent.java` trusts `uid` as sent, after placeholder normalization (line 208). [Onboarding a customer](../../operations/onboard-a-customer.md) says the collector has no authentication, but no contract records what that means for identity.
- **Evidence.** Read from the config and the code at `f971ed5a`. That the OpenSnowcat collector has no authentication setting is inferred from upstream Snowplow collectors, which accept hits from browsers that cannot keep a secret. The onboarding guide cites the OpenSnowcat 1.2.1 source for its CORS behavior: it echoes any `Origin` with credentials allowed. The effect on stitching and journeys is inferred from the code and [decision 0012](../../architecture/decisions/0012-resolve-events-without-a-device-from-the-durable-copy.md). Not reproduced.
- **Fix direction.** Put a rate limit and an origin allow list in front of the collector. Decide in the [identity stitching contract](../../architecture/components/identity/identity-stitching.md) which sources may set `uid`, for example only server-side trackers or a signed login token.

## ING-KI-13. `event_volume` rows are never deleted

- **Symptom.** `event_volume` grows by one row per event name, hour, and outcome, and nothing removes old rows. Studio reads only the last 8 days, plus the latest `last_seen_at` of each event at any age.
- **Cause.** No job or schedule deletes rows. `EventVolumeTable` in `shared/db/repositories/EventVolumeTable.java` only upserts.
- **Evidence.** Estimated, not measured: 100 event names with two outcomes each write about 1.75 million rows a year, around 200 MB with the primary key and the `bucket_start` index. The table is in no publication, but its WAL counts toward every slot's 8 GB cap (decision 0039). At 10 seconds per batch, one active row writes at most 8,640 upserts a day.
- **Fix.** Delete rows older than a retention period, such as 90 days, in batches by `bucket_start`, while keeping each event's latest `accepted` row so "last seen" survives. The retention period is the owner's call.
