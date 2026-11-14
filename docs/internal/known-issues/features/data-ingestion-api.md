---
title: Data ingestion API known issues
contract: ../../features/data-ingestion-api.md
updated: 2026-11-14
verified_at: 6c15fc1d
---

# Data ingestion API known issues

`POST /v1/events`, `POST /v1/business-events`, and source keys are built in `studio`. Paths are relative to `studio/` unless they start with `shared/` or `infra/`.

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| DIA-KI-02 | Risk | The app does not refuse plain HTTP | DIA-NFR-06 |
| DIA-KI-04 | Risk | Event writes queue behind one Kafka transaction per process | DIA-NFR-02 |
| DIA-KI-05 | Risk | An app id can hold only one key | DIA-FR-18 |
| [CAT-KI-04](event-catalog.md#cat-ki-04-catalog-rows-and-senders-use-bare-event-names-with-no-vendor-prefix) | Blocking | Senders and catalog rows use bare event names. Tracked in the event catalog's page. | DIA-FR-10 |

## DIA-KI-02. The app does not refuse plain HTTP

- **Symptom.** A request that reaches the app over HTTP is served, and its source key crosses the network in clear text.
- **Cause.** `authenticateSourceKey` in `src/features/data-ingestion/model/sourceKeyAuth.ts`, which both routes and the data import routes use, does not check the scheme. It relies on the ingress to terminate TLS and redirect HTTP.
- **Evidence.** Read from the code. Whether each deployment's ingress redirects HTTP is not checked.

## DIA-KI-04. Event writes queue behind one Kafka transaction per process

- **Symptom.** Each `studio` replica commits one request's batch at a time, so all source keys together get at most one Kafka commit round trip per request per replica. Several keys each posting at the default 100 requests per second can wait or time out before any reaches its rate limit.
- **Cause.** `publish` in `src/features/data-ingestion/model/businessEventProducer.ts` chains every request of both routes on one queue, because a transactional producer runs one transaction at a time. `POST /v1/events` shares it, so person and business events wait for each other.
- **Evidence.** Read from the code. Throughput is not measured.

## DIA-KI-05. An app id can hold only one key

- **Symptom.** Creating a second key for an app id fails while the first is not revoked, so rotating a key leaves the sender with `401` until it has the new key.
- **Cause.** The partial unique index `ingestion_source_keys_active_app_id_key` on `ingestion_source_keys (app_id) WHERE revoked_at IS NULL` in `infra/db/schema.sql`, allow one key that is not revoked. The create in `shared/lib/db.ts` turns the index's unique violation into a refusal. [Decision 0048](../../architecture/decisions/0048-ingestion-keeps-tracker-parity-a-per-replica-limit-and-two-keys-for-rotation.md) allows two.
- **Evidence.** Read from the schema and the code. The fix drops the index in a migration and counts keys in the create action.
