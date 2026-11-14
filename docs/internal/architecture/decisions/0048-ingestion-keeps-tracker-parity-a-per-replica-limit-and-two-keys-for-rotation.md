---
title: The ingestion API ignores catalog status, counts its rate limit per replica, and allows two keys per app id
id: "0048"
status: accepted
date: 2026-11-14
tags: [ingestion, api, source-keys, rate-limit]
supersedes: []
superseded_by: []
---

# 0048. The ingestion API ignores catalog status, counts its rate limit per replica, and allows two keys per app id

## Context

Building `POST /v1/business-events` left three choices that the [data ingestion API contract](../../features/data-ingestion-api.md) did not settle. The code took the first option of each:

1. The API checks a business event's kind and item key, not whether its catalog entry is `active`.
2. The rate limit of a source key is counted in each `studio` process's memory ([DIA-KI-03](../../known-issues/features/data-ingestion-api.md#dia-ki-03-the-rate-limit-is-counted-per-app-process)). With N replicas, a key gets N times its limit.
3. An app id holds at most one key that is not revoked. A unique index on `ingestion_source_keys` enforces it. Rotating means revoke, then create, and the sender fails with `401` until it has the new key.

A fourth choice, whether the API stays inside `studio` or moves to its own service, sets infrastructure cost, so it is the owner's and stays open.

## Decision

1. **Catalog status is not an ingestion gate.** The API accepts an event whose catalog entry is `inactive`, on both routes. Status hides an event from the journey builder. It does not change what the platform accepts.
2. **The rate limit is counted per replica.** Each `studio` replica enforces a source key's limit on its own. The contract states this, and a deployment that runs N replicas sets the per-replica limit to its intended total divided by N. No shared counter is built.
3. **An app id may hold two keys that are not revoked.** Rotating is create, switch the sender, then revoke the old key, with no gap. A third create for the app id is refused until one of the two is revoked.

## Why

**Status.** The [event catalog](../../features/event-catalog.md) defines `inactive` as "hidden from the builder", the way an admin retires an event. A campaign that already uses the event keeps running, and tracker hits of it are still accepted, because [decision 0014](0014-gate-events-on-their-catalog-schema-at-ingestion.md) gates on the event's schema, not its status. Refusing it on the API alone would break DIA-FR-07, which promises that API events are treated exactly like tracker hits, and would stop live campaigns the moment an admin tidies the builder. [Segment Protocols](https://www.twilio.com/docs/segment/protocols/enforce/schema-configuration) separates the same two things: blocking unplanned events is a per-source setting, not a side effect of how an event is shown.

**Rate limit.** `studio` runs one replica ([its manifest](../../../../infra/k8s/apps/web/studio/studio.yaml) sets `replicas: 1`), so the per-process count is the shared count today. A shared counter needs a store every request reads and writes. The stack has no Redis, and a Postgres counter puts a write on the hot path of every request. The limit guards the pipeline against a runaway sender, not a billing quota, so an exact count adds cost without changing the outcome. Mature APIs publish limits as approximate: [Segment's HTTP API](https://www.twilio.com/docs/segment/connections/sources/catalog/libraries/server/http-api#rate-limits) states a per-workspace rate it may enforce loosely, and [Braze](https://www.braze.com/docs/api/api_limits/) documents limits per endpoint. If the owner moves the API to its own service, the count moves with it, and this choice is revisited then.

**Two keys.** A sender is another team's system. Swapping its key takes a deploy, which can take hours, and the old rule makes every one of those minutes a `401` outage that drops events. [AWS IAM](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html#rotating_access_keys_console) allows two access keys per user for exactly this rotation, and [Stripe](https://docs.stripe.com/keys#rolling-keys) keeps an old key valid for a chosen period after a roll. Two is the smallest number that removes the gap. More would let forgotten keys pile up.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Refuse events whose catalog entry is inactive | Breaks parity with tracker hits and stops live campaigns when an admin hides an event. |
| A shared rate counter in Redis or Postgres | A new store or a write per request, for a guard that need not be exact, on a deployment that runs one replica. |
| Keep one key per app id and accept the gap | Every rotation drops events for as long as the sender takes to deploy. |
| Unlimited keys per app id | Old keys accumulate and stay valid. |
| A grace period on the revoked key, as Stripe does | Needs an expiry time on each key and a job or check to end it. Two keys give the same overlap, with the admin choosing when to revoke. |

## Consequences

- DIA-KI-03 is no longer a defect: the contract now says the limit is per replica.
- The unique index on `ingestion_source_keys` and the create action in `studio` still allow one key. Changing them needs a migration, recorded as [DIA-KI-05](../../known-issues/features/data-ingestion-api.md#dia-ki-05-an-app-id-can-hold-only-one-key).
- Scaling `studio` past one replica means lowering the per-replica limit, or revisiting this record.
- Where the API runs stays an open question for the owner.

## Related

- [Data ingestion API](../../features/data-ingestion-api.md)
- [Event catalog](../../features/event-catalog.md)
- [0014. Gate events on their catalog schema at ingestion](0014-gate-events-on-their-catalog-schema-at-ingestion.md)
- [0027. Multi-tenancy](0027-multi-tenancy.md)
