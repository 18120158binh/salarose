---
title: Run the data ingestion API as its own service, outside studio
id: "0057"
status: accepted
date: 2026-11-17
tags: [ingestion, api, deployment, studio]
supersedes: []
superseded_by: []
---

# 0057. Run the data ingestion API as its own service, outside studio

## Context

The [data ingestion API](../../features/data-ingestion-api.md) accepts a customer's own events over HTTPS at `POST /v1/events` and `POST /v1/business-events`, and writes them to `ingestion-api-events` and `business-events`. The [data import](../../features/data-import.md)'s batch API takes files and record batches at `POST /v1/imports`, `POST /v1/imports/{run_id}/complete`, `POST /v1/records/{record_type}`, and `GET /v1/imports/{run_id}`, with the same source keys. Today every one of these routes is a route handler in `studio`, the admin app, so they run in `studio`'s pods (read from `studio/app/v1/` at `fe53fe6`). A `studio` deploy, restart, or outage stops ingestion, and ingestion scales with the replicas `studio` runs for its staff.

[Decision 0048](0048-ingestion-keeps-tracker-parity-a-per-replica-limit-and-two-keys-for-rotation.md) settled catalog status, the rate limit, and key rotation. It left one question to the owner, because it sets infrastructure cost: keep the API inside `studio` and record that, or move it to its own service (#12, question 4).

## Decision

The data ingestion API runs as its own service, deployed and scaled apart from `studio`. The owner decided this on 2026-11-17 (#12).

- The service serves every `/v1` route: `POST /v1/events`, `POST /v1/business-events`, and the data import's batch API. The routes, the request and response bodies, the topics, the drop zone, and the key and scope rules of the contracts do not change.
- Source keys stay managed in `studio` ([decision 0049](0049-the-ingestion-api-writes-plain-json-to-its-own-topic-and-leaves-history-to-import.md)). An admin creates and revokes them at `/data/sources`. The service reads `ingestion_source_keys` to check a key and writes no key. The owner confirmed this on 2026-11-18.
- The rate limit stays per replica ([decision 0048](0048-ingestion-keeps-tracker-parity-a-per-replica-limit-and-two-keys-for-rotation.md)). It now counts the service's replicas, not `studio`'s.
- Once the service serves the routes, `studio` stops serving them. One deployment owns each route. `studio` keeps only the UI: the source keys page, the import screens, and the rest of the admin app.

The first version of this record, in PR #173, left the import routes in `studio`. The owner moved them too on 2026-11-17, during the review of that PR.

## Why

**Ingestion is the platform's input, and staff tooling should not gate it.** Tracker hits already reach a collector that runs apart from `studio`. Events from the API are the same input for server-side senders. #12 named the cost of the current design: ingestion uptime and scaling follow `studio`. In its own service, events keep arriving while `studio` deploys, restarts, or fails.

**The two workloads scale on different signals.** `studio` serves a few staff users. The API serves the customer's servers, at the event rates of [platform capacity](../capacity.md). A separate deployment sets its own replicas, resources, and limits.

**Failure stays contained.** A bad `studio` build or an overloaded `studio` pod no longer refuses or delays events.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Keep the API inside `studio` and record the choice | Ingestion uptime and scaling stay tied to the admin app. The owner chose not to accept that. |
| Serve the API from the collector | The collector speaks the Snowplow tracker protocol and writes Snowplow topics. The API writes plain JSON to topics of its own ([decision 0049](0049-the-ingestion-api-writes-plain-json-to-its-own-topic-and-leaves-history-to-import.md)). |
| Move only the event routes, and keep the import routes in `studio` | Ingestion through the batch API would still stop with `studio`, and the source key check would live in two deployments. The owner moved every `/v1` route. |

## Consequences

- A new deployable: its image, its manifest, its CI path filter and `concurrency` group, and its share of the deployment's compute. [Keep CI cheap](../../operations/ci-cost.md) applies.
- The service needs read access to `ingestion_source_keys` and `import_source_scopes`, write access to the two topics, the import run tables, and the drop zone's presigned URLs. `studio` keeps write access to `ingestion_source_keys` and the scopes for the admin screens.
- A deployment that runs N replicas of the service sets the per-replica rate limit to its intended total divided by N (DIA-NFR-02).
- Until the service is built, the routes stay in `studio`. [DIA-KI-06](../../known-issues/features/data-ingestion-api.md#dia-ki-06-the-api-runs-inside-studio) and [DIM-KI-02](../../known-issues/features/data-import.md#dim-ki-02-the-batch-api-runs-inside-studio) record the gap.
- The [overview](../overview.md) shows the service as planned.

## Related

- [Data ingestion API](../../features/data-ingestion-api.md), DIA-FR-41
- [Data import](../../features/data-import.md), DIM-FR-30
- [0048. The ingestion API ignores catalog status, counts its rate limit per replica, and allows two keys per app id](0048-ingestion-keeps-tracker-parity-a-per-replica-limit-and-two-keys-for-rotation.md)
- [0049. The ingestion API writes plain JSON to its own topic, and leaves history to the import](0049-the-ingestion-api-writes-plain-json-to-its-own-topic-and-leaves-history-to-import.md)
- [Event ingestion](../components/event-ingestion.md)
