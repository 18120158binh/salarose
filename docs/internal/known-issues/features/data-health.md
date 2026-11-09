---
title: Data health known issues
contract: ../../features/data-health.md
updated: 2026-11-08
verified_at: none, the pages are not built
---

# Data health known issues

The pages are not built yet. Studio v2 phase 1 builds them. The dead-letter reader that the browser and the home count use is built, in `src/features/data-health/model/`. Paths are relative to `studio/`. Add an issue here when the code departs from the contract.

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| DHL-KI-01 | Risk | Each dead-letter read waits about 3 seconds for its consumer group to form | DHL-NFR-02 |
| DHL-KI-02 | Departure | An editor with preview access gets the side sheet, not the event detail page | DHL-FR-02 |
| DHL-KI-03 | Gap | The studio does not show per-event counts | DHL-FR-14, DHL-FR-18 |

## DHL-KI-01. Each dead-letter read waits about 3 seconds for its consumer group to form

- **Symptom.** A page of the dead-letter browser, and opening one record's content, each take at least about 3 seconds, so a page cannot load within DHL-NFR-02's 3 seconds.
- **Cause.** `createDeadLetterReader` in `src/features/data-health/model/deadLetterReader.ts` gives each read a new consumer group, as DHL-FR-08 asks, because kafkajs cannot assign partitions by hand. The broker holds the first join of a new group for `group.initial.rebalance.delay.ms`, 3000 ms by default. The AWS Free Plan cluster's `Kafka` resource in `infra/k8s/data/kafka.yaml` does not set it.
- **Evidence.** Inferred from the broker default and the manifest. Not measured on the cluster.
- **Fix.** Set `group.initial.rebalance.delay.ms: 0` in the `Kafka` resource's `config`. The reader's groups each have one member, so the delay buys nothing. The change rolls the single broker, so it waits for the owner's go-ahead.

## DHL-KI-02. An editor with preview access gets the side sheet, not the event detail page

- **Symptom.** On `/v2/data/events`, an admin's row opens `/v2/data/events/[id]`. Every editor's row opens the read-only side sheet, including an editor whose preview flag is true, who should get the detail page.
- **Cause.** `app/v2/data/events/page.tsx` passes `openDetail={admin}` to `EventCatalog`, because studio has no preview check yet. Every admin is a preview viewer, so admins are right.
- **Evidence.** The code. The preview check arrives with #340.
- **Fix.** After #340 merges, pass `openDetail` from `isPreviewViewer` in `src/shared/auth/preview.ts`.

## DHL-KI-03. The studio does not show per-event counts

- **Symptom.** Monitoring, the catalog strip, and Tracking setup's live check show no per-event volume, last-seen time, or drops.
- **Cause.** No studio page reads `event_volume` yet. Until PR #383 lands, nothing writes it either: no job counts events per name, and a dead letter carries no event name.
- **Evidence.** PR #383 adds `event_volume`, the per-name counts in the event parse job, and `event_name` on dead letters (ING-FR-20, ING-FR-21). The Monitoring and catalog pages are not built.
- **Fix.** Land PR #383, then build the Overview rows, the catalog strip, and the live check on `event_volume` in the v3 Data lane. Delete this entry with that change.
