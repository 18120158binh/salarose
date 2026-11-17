---
title: Home overview known issues
contract: ../../features/home-overview.md
updated: 2026-11-17
verified_at: feat/v2-home, before deploy
---

# Home overview known issues

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| HOM-KI-01 | Risk | The KPI row and the journeys table read only the hot transitions table, not the lakehouse | HOM-NFR-04 |
| HOM-KI-02 | Risk | The KPIs and the journeys table count `sim_` campaigns | HOM-FR-12 |

## HOM-NFR-01 is not measured yet

Breaks HOM-NFR-01. Each region's reads run in one read-only transaction with a 5-second statement timeout, and every statement reads one node type so that the indexes of decision 0035 apply. Nobody has timed Last 30 days on the deployed database yet. Phase 1 verification (V2-19) measures it, and records the result of decision 0035's check if a region misses 2 seconds. The reads live in `studio/src/features/home-overview/model/queries.ts`.

## The health strip says "Last transition"

Breaks HOM-FR-08. The contract renamed the health strip's third item to "Last journey step" on 2026-11-08. `studio/src/features/home-overview/ui/HealthStrip.tsx` still renders "Last transition" (line 66). Change the label and its test.

## HOM-KI-01. The KPI row and the journeys table read only the hot transitions table, not the lakehouse

- **Symptom.** Every load of `/v2` counts transitions in `user_campaign_state_transitions` only. Once partitions move, older transitions and late transitions drop out of the counts.
- **Cause.** The KPI and journeys queries in `studio/src/features/home-overview/model/queries.ts` join `user_campaign_state_transitions` (line 26). No transition history exists in a lakehouse to read instead.
- **Evidence.** Read from the code at `a29730c`.
- **Fix direction.** Once the lakehouse sink lands, read `transition_history` through Athena below the move boundary and combine it with the hot read, by [Read across both stores](../../architecture/components/lakehouse.md#read-across-both-stores). The health strip keeps reading the hot table.

Tracked in #104.

## HOM-KI-02. The KPIs and the journeys table count `sim_` campaigns

- **Symptom.** While a simulator run's campaigns and transitions exist, the KPI row counts their entries and messages, and the journeys table can list them.
- **Cause.** The queries in `studio/src/features/home-overview/model/queries.ts` filter by node type, range, and campaign status, and never by campaign id.
- **Evidence.** Read from the code at `fe53fe6`. Today clean-up deletes a run's rows from the hot table, so the counts recover after clean-up. Once partitions move, they would not.
- **Fix direction.** Leave out `campaign_id LIKE 'sim\_%'` in both reads, the hot one and the lakehouse one.
