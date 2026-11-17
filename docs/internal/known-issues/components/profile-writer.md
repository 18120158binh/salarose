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

## PRW-KI-09. `user_metrics` stores occurrence arrays, not buckets

- **Same defect as DEC-KI-42.** See [DEC-KI-42](customer-decision.md#dec-ki-42-metrics-are-stored-as-capped-raw-occurrences-not-buckets). The writer stores what the mutation carries, so it changes with the job. Fix and track it there.

## PRW-KI-11. `user_metrics` is written once per mutation, not once per coalescing window

- **Symptom.** A person whose events change a series 20 times in 30 seconds gets 20 upserts of the whole series, each with its WAL, and with the old row logged too while PLT-KI-18 stands.
- **Cause.** `UserMetricRepository.attach` in `shared/db/repositories/` keys the decoded metrics by `canon_id` and sinks them straight into `BatchingJdbcSink` with `JdbcSinkOptions.batches()`: up to 100 rows per batch, written at least every 500 ms. No operator holds a row for a window, and a batch holds every mutation it received, not the newest per row.
- **Evidence.** Read from the code at `a29730c`. The WAL this costs per event is not measured ([CAP-FR-17](../../architecture/capacity.md#functional-requirements)).
- **Fix direction.** Hold the newest series per (`canon_id`, `metric_id`) in keyed state and flush on the coalescing window, once the owner sets it. Measure `D(r, T)` and the WAL per event before and after.
