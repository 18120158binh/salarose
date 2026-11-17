---
title: Journey execution known issues
contract: ../../architecture/components/journey-execution.md
updated: 2026-11-17
verified_at: 0db371f8
---

# Journey execution known issues

Java paths are relative to `event-processor/src/main/java/com/cdp/platform/`.

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| JEX-KI-37 | Minor | A setup trigger opens an entry for every new entry id, with no re-entry check and no refusal count | JEX-FR-18 |
| JEX-KI-38 | Risk | `user_campaign_state_transitions` is one unpartitioned table that keeps every row, with the analytics indexes | JEX-FR-20, JEX-FR-21, JEX-FR-23, JEX-NFR-12, JEX-NFR-13 |

## JEX-KI-37. A setup trigger opens an entry for every new entry id, with no re-entry check and no refusal count

- **Symptom.** A setup trigger with an entry id the journey key does not hold always opens a new entry. The job does not read the campaign's entry trigger kind or its re-entry setting (`never`, `always`, `after`), so it refuses no setup trigger and counts no refusal. A person-event campaign still gets one entry, because its setup triggers carry no entry id and share the entry `first`.
- **Cause.** `JourneyStateMachineFunction.targets` in `jobs/statemachine/transforms/` maps a setup trigger to the entry it names, or to `VersionedTrigger.FIRST_ENTRY`, and `TransitionEngine.evaluate` in `jobs/statemachine/engine/` completes the setup node in any entry where it has not completed. No segment entry trigger exists yet to carry a re-entry setting.
- **Evidence.** Read from the code.
- **Fix direction.** Read the entry trigger kind and re-entry setting from the campaign graph when segment entry triggers land, refuse a setup trigger that [Open an entry](../../architecture/components/journey-execution.md#open-an-entry) does not allow, and count it.

Tracked in #223 and #220.

## JEX-KI-38. `user_campaign_state_transitions` is one unpartitioned table that keeps every row, with the analytics indexes

- **Symptom.** The table grows with every completed node and never shrinks. Each insert maintains the three analytics indexes of decision 0035 as well as the primary key and the `campaign_node_stats` index. No transition reaches the lakehouse.
- **Cause.** `infra/db/schema.sql` creates the table with `CREATE TABLE IF NOT EXISTS user_campaign_state_transitions (...)` and no `PARTITION BY`, and creates `idx_ucst_node_reach`, `idx_ucst_type_event_time`, and `idx_ucst_type_written` on it. No lakehouse sink exists.
- **Evidence.** Read from `infra/db/schema.sql` at `a29730c`.
- **Fix direction.** A migration to a table partitioned by `event_timestamp`, with `event_timestamp` in the primary key and `publish_via_partition_root` on `outbox_transitions_pub`, then the lakehouse sink's move. Drop the analytics indexes only after HOM-KI-01 and JBD-KI-37 are fixed. Follows the `db-migration` skill.
