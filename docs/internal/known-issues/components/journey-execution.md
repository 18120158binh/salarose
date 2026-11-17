---
title: Journey execution known issues
contract: ../../architecture/components/journey-execution.md
updated: 2026-11-18
verified_at: 0db371f8
---

# Journey execution known issues

Java paths are relative to `event-processor/src/main/java/com/cdp/platform/`.

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| JEX-KI-37 | Minor | A setup trigger opens an entry for every new entry id, with no re-entry check and no refusal count | JEX-FR-18 |
| JEX-KI-38 | Risk | `user_campaign_state_transitions` is one unpartitioned table that keeps every row | JEX-FR-20, JEX-FR-21, JEX-FR-22, JEX-FR-23, JEX-FR-25, JEX-NFR-12, JEX-NFR-14 |
| JEX-KI-39 | Risk | Journey state TTL resets on every read and write, not from the entry's start | JEX-NFR-03 |

## JEX-KI-37. A setup trigger opens an entry for every new entry id, with no re-entry check and no refusal count

- **Symptom.** A setup trigger with an entry id the journey key does not hold always opens a new entry. The job does not read the campaign's entry trigger kind or its re-entry setting (`never`, `always`, `after`), so it refuses no setup trigger and counts no refusal. A person-event campaign still gets one entry, because its setup triggers carry no entry id and share the entry `first`.
- **Cause.** `JourneyStateMachineFunction.targets` in `jobs/statemachine/transforms/` maps a setup trigger to the entry it names, or to `VersionedTrigger.FIRST_ENTRY`, and `TransitionEngine.evaluate` in `jobs/statemachine/engine/` completes the setup node in any entry where it has not completed. No segment entry trigger exists yet to carry a re-entry setting.
- **Evidence.** Read from the code.
- **Fix direction.** Read the entry trigger kind and re-entry setting from the campaign graph when segment entry triggers land, refuse a setup trigger that [Open an entry](../../architecture/components/journey-execution.md#open-an-entry) does not allow, and count it.

Tracked in #223 and #220.

## JEX-KI-38. `user_campaign_state_transitions` is one unpartitioned table that keeps every row

- **Symptom.** The table grows with every completed node and never shrinks. No transition reaches the lakehouse. A transition carries no entry start, so the table has no column to partition by.
- **Cause.** `infra/db/schema.sql` creates the table with `CREATE TABLE IF NOT EXISTS user_campaign_state_transitions (...)`, no `PARTITION BY`, and no `entry_started_at` column, and creates `outbox_transitions_pub` without `publish_via_partition_root`. No lakehouse sink exists.
- **Evidence.** Read from `infra/db/schema.sql` at `a29730c`.
- **Fix direction.** The engine carries each entry's start on every transition. A migration partitions the table by `entry_started_at`, adds it to the primary key, and sets `publish_via_partition_root` on `outbox_transitions_pub` (OUT-FR-09). Then the lakehouse sink's move at 90 days, and the write of late transitions straight to `transition_history`. The analytics indexes stay (JEX-NFR-13). The move writes each partition's count per node to `campaign_node_moved_counts`, and `campaign_node_stats` becomes a materialized view over the hot partitions and those counts, refreshed every 5 seconds (JEX-FR-25, JEX-NFR-14). Move no partition while a reader still needs the hot table: HOM-KI-01, JBD-KI-37, and CUS-KI-11 fixed first, and the other readers JEX-FR-24 names. Follows the `db-migration` skill.

Tracked in #101.

## JEX-KI-39. Journey state TTL resets on every read and write, not from the entry's start

- **Symptom.** A journey key that keeps receiving triggers keeps its state past 90 days from its entries' starts, so an entry can outlive its partition's move and its later nodes become late transitions.
- **Cause.** `JourneyStateMachineFunction` in `jobs/statemachine/transforms/` builds its `StateTtlConfig` with `UpdateType.OnReadAndWrite`, one TTL for the whole journey key's state, read from `STATE_MACHINE_JOURNEY_STATE_TTL_MS` in `StateMachineJob`.
- **Evidence.** Read from the code at `218536f`.
- **Fix direction.** Expire each entry 90 days after its start: keep the entry start with the entry and drop entries past it on access and on a timer, and stop refreshing the TTL on read and write.
