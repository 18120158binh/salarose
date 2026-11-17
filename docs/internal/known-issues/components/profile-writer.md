---
title: Profile writer known issues
contract: ../../architecture/components/profile-writer.md
updated: 2026-11-17
verified_at: 0db371f8
---

# Profile writer known issues

Java paths are relative to `event-processor/src/main/java/com/cdp/platform/`.

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| PRW-KI-09 | Minor | `user_metrics` stores occurrence arrays, not buckets | PRW-FR-04 |
| PRW-KI-11 | Risk | `user_metrics` is written once per mutation, not once per coalescing window | PRW-FR-13, PRW-FR-15, PRW-NFR-02 |
| PRW-KI-12 | Risk | The row version has no rebuild epoch | PRW-FR-03, PRW-FR-16 |

## PRW-KI-09. `user_metrics` stores occurrence arrays, not buckets

- **Same defect as DEC-KI-42.** See [DEC-KI-42](customer-decision.md#dec-ki-42-metrics-are-stored-as-capped-raw-occurrences-not-buckets). The writer stores what the mutation carries, so it changes with the job. Fix and track it there.

## PRW-KI-11. `user_metrics` is written once per mutation, not once per coalescing window

- **Symptom.** A person whose events change a series 20 times in 30 seconds gets 20 upserts of the whole series, each with its WAL, and with the old row logged too while PLT-KI-18 stands.
- **Cause.** `UserMetricRepository.attach` in `shared/db/repositories/` keys the decoded metrics by `canon_id` and sinks them straight into `BatchingJdbcSink` with `JdbcSinkOptions.batches()`: up to 100 rows per batch, written at least every 500 ms. No operator holds a row for a window, and a batch holds every mutation it received, not the newest per row.
- **Evidence.** Read from the code at `a29730c`. The WAL this costs per event is not measured ([CAP-FR-17](../../architecture/capacity.md#functional-requirements)).
- **Fix direction.** Hold the newest series per (`canon_id`, `metric_id`) in keyed state and flush once per checkpoint, 30 seconds by default (PRW-NFR-07). Measure `D(r, T)` and the WAL per event before and after.

Tracked in #100.

## PRW-KI-12. The row version has no rebuild epoch

- **Symptom.** After a rebuild from raw events, a series whose rebuilt behavior version is lower than the stored one never replaces the stored row, and a person keeps a stale row.
- **Cause.** `user_metrics` has no `last_rebuild_epoch` column in `infra/db/schema.sql`, and `UserMetricRepository` in `shared/db/repositories/` guards the upsert on `last_behavior_version` alone. Mutations carry no epoch (DEC-KI-45).
- **Evidence.** Read from the schema and the code at `fe53fe6`. No rebuild exists yet, so the symptom cannot occur today.
- **Fix direction.** Add `last_rebuild_epoch` in a migration, store it from each mutation, and compare (epoch, version) in the guard. Land it with DEC-KI-45, before the first rebuild. Follows the `db-migration` skill.
