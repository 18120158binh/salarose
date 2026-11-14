---
title: Import metric pass known issues
contract: ../../architecture/components/import-metric-pass.md
updated: 2026-11-14
verified_at: 8e9b5a0
---

# Import metric pass known issues

The pass is built: the CronJob `import-metric-pass` in `infra/k8s/apps/import-metric-pass/` runs `ImportMetricPassMain` from `event-processor/src/main/java/com/cdp/platform/jobs/importmetricpass/` on the batch jobs image. It shares `WalGovernor`, `PostgresReadings`, `LockGuard`, and `Tombstones` in `shared/batch/` with the import applier and the segment membership pass. No overlay lists it yet.

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| IMP-KI-01 | Risk | The metric SQL and the pass's speed have never run against a Postgres | IMP-FR-05, IMP-FR-06, IMP-NFR-01, IMP-NFR-02 |
| IMP-KI-02 | Risk | No database role keeps other writers out of `customer_attributes` | IMP-FR-15 |
| IMP-KI-03 | Risk | A backfill holds every changed row in memory | IMP-NFR-01 |
| IMP-KI-04 | Minor | `wal_bytes` leaves out the foreign-key trigger's and the commit's WAL | IMP-FR-14, IMP-NFR-02 |
| IMP-KI-05 | Minor | Pauses reach the pass's row only when the pass ends | IMP-FR-14 |

## IMP-KI-01. The metric SQL and the pass's speed have never run against a Postgres

- **Symptom.** None seen yet. A statement that Postgres refuses would fail every night's pass with the error's class as its reason.
- **Cause.** `EventMetricQuery` builds one grouped query per event dataset, and `PostgresImportSnapshot` and `PostgresPassLedger` run it and the writes. The unit tests check the SQL text, the parameter order, and the pass's logic over in-memory stores. No test starts a Postgres, and the CI job `test-migrations.sh` checks only the schema.
- **Evidence.** Read from the code and the tests at `8e9b5a0`. Not run: the PR's host had no container runtime.
- **Fix direction.** Run the pass once on a staging copy, which also gives the measured `wal_bytes` and duration that IMP-NFR-01 and IMP-NFR-02 ask for, and add a Postgres-backed test of the metric SQL to the CI job that already starts one.

## IMP-KI-02. No database role keeps other writers out of `customer_attributes`

- **Symptom.** A bug in another job could write `customer_attributes`, and nothing would refuse it.
- **Cause.** The pass and the import applier connect to the main Postgres as the same user, `cdp`, so a grant cannot single out the pass.
- **Evidence.** Read from `infra/k8s/apps/import-metric-pass/import-metric-pass.yaml` and `infra/k8s/apps/import-applier/import-applier.yaml` at `8e9b5a0`: both set `DB_USER` to `cdp`.
- **Fix direction.** Give the pass its own role, the only one with `INSERT`, `UPDATE`, and `DELETE` on `customer_attributes`.

## IMP-KI-03. A backfill holds every changed row in memory

- **Symptom.** Inferred, not seen: a first pass over a large shop could run out of the 2 GiB the CronJob grants.
- **Cause.** `MetricPass.compute` stages each changed row's canonical JSON and hash in a list until it publishes. A night with few changes stages few rows, but a first pass changes every row.
- **Evidence.** Read from the code at `8e9b5a0`. A guess at size: 1 million rows of about 300 bytes is about 600 MB of Java strings, under the 1.5 GiB heap.
- **Fix direction.** Spill the staged rows to a file under `/tmp` past a threshold, as the contract allows.

## IMP-KI-04. `wal_bytes` leaves out the foreign-key trigger's and the commit's WAL

- **Symptom.** `wal_bytes` reads a little lower than the WAL the pass caused.
- **Cause.** `PostgresPassLedger` takes `WAL Bytes` of the top plan node from `EXPLAIN (ANALYZE, WAL)`. The check of the foreign key on `pass_id` runs as a trigger after the plan, and the commit record follows the statement, so neither is counted.
- **Evidence.** Read from the code at `8e9b5a0`. The size of the gap is a guess, a few hundred bytes per batch, until IMP-KI-01's staging run measures it.

## IMP-KI-05. Pauses reach the pass's row only when the pass ends

- **Symptom.** While a pass is paused, `/data/imports` shows no pause, and a crash loses the pauses of that attempt.
- **Cause.** `MetricPass` passes the governor's pauses to `PassLedger.finish` or `fail` and writes them nowhere else.
- **Evidence.** Read from the code at `8e9b5a0`.
- **Fix direction.** Write `pauses` on the pass's row when each pause ends.
