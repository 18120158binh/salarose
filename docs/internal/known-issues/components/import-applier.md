---
title: Import applier known issues
contract: ../../architecture/components/import-applier.md
updated: 2026-11-14
verified_at: 43060d0
---

# Import applier known issues

Java paths are relative to `event-processor/src/main/java/com/cdp/platform/`. The applier is built up to validation and its report (#27). Apply, deletions, and re-derive come with #28.

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| IAP-KI-01 | Blocking | A run that would apply goes back to the queue instead | IAP-FR-11, IAP-FR-12 to 16, IAP-FR-25 |
| IAP-KI-02 | Blocking | Tombstones and the 365-day `pii_access_log` deletion are not run | IAP-FR-19, IAP-FR-22 |
| IAP-KI-03 | Blocking | A re-derive run is never taken, and holds its type | IAP-FR-20 |
| IAP-KI-04 | Risk | An error while validating retries at every start instead of failing the run | IAP-FR-02 |
| IAP-KI-05 | Minor | The applier's SQL has no test against Postgres | IAP-FR-03, IAP-FR-04, IAP-FR-23, IAP-FR-24 |

## IAP-KI-01. A run that would apply goes back to the queue instead

- **Symptom.** A run that passes the checks of Decide whether to apply, or an approved run, returns to `queued` or `approved` with its report and counts. No record reaches the import store, and the applier validates the run again at every start. Its type's later runs wait behind it.
- **Cause.** `RunProcessor.process` in `jobs/importapplier/RunProcessor.java` calls `RunStore.returnToQueue` where apply belongs.
- **Evidence.** Read from the code.
- **Fix direction.** #28 adds apply, the commit marker, and the `applied` and `failed` transitions.

## IAP-KI-02. Tombstones and the 365-day `pii_access_log` deletion are not run

- **Symptom.** A tombstone stays at `requested`, and old `pii_access_log` rows stay. Validation already rejects a tombstoned key as `deleted_person`.
- **Cause.** `ImportApplierMain.run` skips steps 3 and 4 of Take a run, and the restore steps of Delete a person.
- **Evidence.** Read from the code.

## IAP-KI-03. A re-derive run is never taken, and holds its type

- **Symptom.** A `rederive` run stays at `queued`. Later runs of its type wait behind it at each start.
- **Cause.** `ImportApplierMain.drain` skips a run whose `source` is `rederive`.
- **Evidence.** Read from the code.

## IAP-KI-04. An error while validating retries at every start instead of failing the run

- **Symptom.** When the drop zone or a lookup fails while a run validates, the run goes back to `queued` or `approved`, and the next start takes it again. An error that repeats, such as a version the applier cannot parse, retries every 10 minutes and never reaches `failed`.
- **Cause.** `RunProcessor.process` calls `RunStore.abandon` on any error. The contract's run states have no transition from `validating` to `failed`, so the applier treats such an error like a crash. `ImportApplierMain.drain` leaves a type whose current version does not parse untaken.
- **Evidence.** Read from the code.
- **Fix direction.** The contract needs to say whether an error while validating fails the run. That is an open question for the owner.

## IAP-KI-05. The applier's SQL has no test against Postgres

- **Symptom.** The conditional updates, recovery, expiry, the last-snapshot query, and the applier lock in `jobs/importapplier/RunStore.java`, `PostgresLookups.java`, and `LockGuard.java` run only against a real database. The Maven tests cover the queue order, validation, the decision, and the report, not these statements.
- **Cause.** The `event-processor` CI job has no Postgres.
- **Evidence.** Read from the tests.
