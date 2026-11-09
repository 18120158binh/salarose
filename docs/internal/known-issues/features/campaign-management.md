---
title: Campaign management known issues
contract: ../../features/campaign-management.md
updated: 2026-11-08
verified_at: 566b719e
---

# Campaign management known issues

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| CMP-KI-01 | Blocking | A metric definition has no archived state, and studio has no `/data/metrics` page | CMP-FR-03, CMP-FR-21, CMP-FR-22, CMP-FR-23 |
| CMP-KI-02 | Blocking | A metric definition stores no originating journey, so the metrics page cannot say which journey made it | CMP-FR-22 |
| CMP-KI-03 | Wrong result | Deleting a catalog event deletes its metric definitions and their stored values | CMP-FR-21 |

## CMP-KI-01. A metric definition has no archived state

- **Symptom.** Staff cannot archive or unarchive a metric, and no page lists the derived metrics.
- **Cause.** `user_metric_definitions` in `infra/db/schema.sql` has `processing_mode` and no column that marks a definition archived. The journey builder's and the segment editor's pickers have nothing to filter on. Studio has no route under `/data/metrics`.
- **Evidence.** Read from the schema and `studio/src/widgets/v2-shell/model/routes.ts`.
- **Fix direction.** A migration adds an archived marker, such as `archived_at`, to `user_metric_definitions`. Archive and unarchive check the uses in the same transaction as the publish lock that CMP-FR-03 uses. The pickers and the publish step read the marker.

## CMP-KI-02. A metric definition stores no originating journey

- **Symptom.** The metrics page cannot show "Made by Studio when journey X was published".
- **Cause.** `user_metric_definitions` gains `created_by` in PR #383, which names the user, but it has no column for the campaign whose publish created the definition, and publish in `shared/lib/db.ts` writes none.
- **Evidence.** Read from the schema.
- **Fix direction.** Add a nullable `created_by_campaign_id`, written once by the publish or segment save that creates the definition. Definitions created before it show "Unknown".

## CMP-KI-03. Deleting a catalog event deletes its metric definitions

- **Symptom.** Deleting an event from the catalog removes every metric definition on it and their `user_metrics` rows.
- **Cause.** `user_metric_definitions.user_event_id` references `user_events(id)` with `ON DELETE CASCADE` in `infra/db/schema.sql`, and `deleteUserEvent` in `shared/lib/db.ts` relies on it.
- **Evidence.** Read from the schema and the code.
- **Fix direction.** Refuse an event delete while the event has metric definitions, as the event catalog's delete rule says, and drop the cascade in a migration.
- **Related.** The same defect breaks CAT-FR-08. See [CAT-KI-01](event-catalog.md#cat-ki-01-deleting-an-event-deletes-its-metric-definitions). Fixing one fixes both.
