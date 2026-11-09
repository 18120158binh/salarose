---
title: Data ingestion API known issues
contract: ../../features/data-ingestion-api.md
updated: 2026-11-08
verified_at: 6c15fc1d
---

# Data ingestion API known issues

`POST /v1/events`, `POST /v1/business-events`, and source keys are built in `studio`. Paths are relative to `studio/`.

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| DIA-KI-02 | Risk | The app does not refuse plain HTTP | DIA-NFR-06 |
| DIA-KI-03 | Risk | The rate limit is counted per app process | DIA-NFR-02 |
| DIA-KI-04 | Risk | Event writes queue behind one Kafka transaction per process | DIA-NFR-02 |
| [CAT-KI-04](event-catalog.md#cat-ki-04-catalog-rows-and-senders-use-bare-event-names-with-no-vendor-prefix) | Blocking | Senders and catalog rows use bare event names. Tracked in the event catalog's page. | DIA-FR-10 |

## DIA-KI-02. The app does not refuse plain HTTP

- **Symptom.** A request that reaches the app over HTTP is served, and its source key crosses the network in clear text.
- **Cause.** `handleBatch` in `src/features/data-ingestion/model/batchRoute.ts`, which both routes use, does not check the scheme. It relies on the ingress to terminate TLS and redirect HTTP.
- **Evidence.** Read from the code. Whether each deployment's ingress redirects HTTP is not checked.

## DIA-KI-03. The rate limit is counted per app process

- **Symptom.** With N `studio` replicas, a source key can send up to N times its limit per second.
- **Cause.** `createKeyRateLimiter` in `src/features/data-ingestion/model/rateLimit.ts` keeps its counts in process memory, as AI journey generation does.
- **Evidence.** Read from the code.

## DIA-KI-04. Event writes queue behind one Kafka transaction per process

- **Symptom.** Each `studio` replica commits one request's batch at a time, so all source keys together get at most one Kafka commit round trip per request per replica. Several keys each posting at the default 100 requests per second can wait or time out before any reaches its rate limit.
- **Cause.** `publish` in `src/features/data-ingestion/model/businessEventProducer.ts` chains every request of both routes on one queue, because a transactional producer runs one transaction at a time. `POST /v1/events` shares it, so person and business events wait for each other.
- **Evidence.** Read from the code. Throughput is not measured.
