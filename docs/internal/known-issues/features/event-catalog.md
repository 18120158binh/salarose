---
title: Event catalog known issues
contract: ../../features/event-catalog.md
updated: 2026-11-08
verified_at: 566b719e
---

# Event catalog known issues

Paths are relative to `studio/` unless they start with `infra/`.

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| CAT-KI-01 | Blocking | Deleting an event deletes its metric definitions | CAT-FR-08 |
| CAT-KI-02 | Departure | Field changes are not classified, and only a rename or a delete checks uses | CAT-FR-11, CAT-FR-14, CAT-FR-19 |
| CAT-KI-04 | Blocking | Catalog rows and senders use bare event names with no vendor prefix | CAT-FR-02, CAT-FR-21, DIA-FR-10 |

## CAT-KI-01. Deleting an event deletes its metric definitions

- **Symptom.** An admin who deletes an event loses every metric definition of it, and their `user_metrics` rows. The owner decided on 2026-11-08 that metric definitions are never deleted, so the delete must be refused.
- **Cause.** `user_metric_definitions.user_event_id` references `user_events(id)` with `ON DELETE CASCADE` in `infra/db/schema.sql`. `deleteEventAction` in `src/features/event-management/model/actions.ts` deletes the event with no check of uses.
- **Evidence.** Read from the code and the schema at `566b719e`.
- **Fix.** Refuse the delete in one transaction while a metric definition or a published campaign uses the event, and change the reference to `ON DELETE RESTRICT` through a migration.
- **Related.** The same defect breaks CMP-FR-21. See [CMP-KI-03](campaign-management.md#cmp-ki-03-deleting-a-catalog-event-deletes-its-metric-definitions). Fixing one fixes both.

## CAT-KI-02. Field changes are not classified, and only a rename or a delete checks uses

- **Symptom.** The edit form shows no Safe, Asks first, or Breaking kind. A type change, or adding a field inside a field that is not a group, saves at once even while the field is in use. Making a field required applies at once with no confirmation.
- **Cause.** `updateAttributeAction` in `src/features/event-management/model/actions.ts` checks uses only when the path changes. `setAttributeRequiredAction` writes the flag directly.
- **Evidence.** Read from the code at `566b719e`.
- **Fix.** Classify each change on the server by [decision 0044](../../architecture/decisions/0044-classify-event-field-changes-as-safe-asks-first-or-breaking.md), and run the use check for every Breaking change.

## CAT-KI-04. Catalog rows and senders use bare event names with no vendor prefix

- **Symptom.** The admin types the whole system name, and existing events are named `purchase`, `add_to_cart`, and `price_drop`, not `com.acme/purchase`. A tracker's self-describing event arrives as `com.acme/add_to_cart` and matches no bare catalog row, so journeys built on bare names see only senders that also send bare names.
- **Cause.** `CreateEventDialog` in `src/features/event-management/ui/CreateEventDialog.tsx` takes the full name with the placeholder `add_to_cart`, and `normalizeEventSystemName` adds no prefix. `infra/db/schema.sql` stores `user_events.event_name` as free text. The simulator (`simulator/cdp_sim/model.py`) creates and sends `sim_add_to_cart` and `sim_purchase`. Studio fixtures and tests (`src/entities/journey/model/__fixtures__/`, `validateJourney.test.ts`) and the kind hint in `EventKindFields.tsx` use `purchase`, `add_to_cart`, and `price_drop`. Senders to `POST /v1/business-events` send the bare name as stored.
- **Evidence.** Read from the code at `1d221fc5`. Not checked against the deployed catalog's rows.
- **Fix.** Add the workspace prefix to **Add event**, rename existing catalog rows and the journeys, metric definitions, and segments that name them in one migration, and move the simulator and the API senders to the prefixed names in the same release.
