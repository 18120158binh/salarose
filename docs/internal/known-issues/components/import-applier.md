---
title: Import applier known issues
contract: ../../architecture/components/import-applier.md
updated: 2026-11-14
verified_at: f26a93a
---

# Import applier known issues

Java paths are relative to `event-processor/src/main/java/com/cdp/platform/`. The applier validates, applies, and re-derives (#27, #28). Deletions of a person are not built yet.

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| IAP-KI-02 | Blocking | Tombstones and the 365-day `pii_access_log` deletion are not run | IAP-FR-19, IAP-FR-22 |
| IAP-KI-04 | Risk | An error while validating retries at every start instead of failing the run | IAP-FR-02 |
| IAP-KI-05 | Minor | The applier's SQL has no test against Postgres | IAP-FR-03, IAP-FR-04, IAP-FR-23, IAP-FR-24 |

## IAP-KI-02. Tombstones and the 365-day `pii_access_log` deletion are not run

- **Symptom.** A tombstone stays at `requested`, and old `pii_access_log` rows stay. Validation already rejects a tombstoned key as `deleted_person`.
- **Cause.** `ImportApplierMain.run` skips steps 3 and 4 of Take a run, and the restore steps of Delete a person.
- **Evidence.** Read from the code.

## IAP-KI-04. An error while validating retries at every start instead of failing the run

- **Symptom.** When the drop zone or a lookup fails while a run validates, the run goes back to `queued` or `approved`, and the next start takes it again. An error that repeats, such as a version the applier cannot parse, retries every 10 minutes and never reaches `failed`.
- **Cause.** `RunProcessor` calls `RunStore.abandon` on any error while a run validates. A re-derive reads and writes while it validates, so an import store error during a re-derive takes the same path. The contract's run states have no transition from `validating` to `failed`, so the applier treats such an error like a crash. `ImportApplierMain.drain` leaves a type whose current version does not parse untaken.
- **Evidence.** Read from the code.
- **Fix direction.** The contract needs to say whether an error while validating fails the run. That is an open question for the owner.

## IAP-KI-05. The applier's SQL has no test against Postgres

- **Symptom.** The conditional updates, recovery, expiry, the last-snapshot query, and the applier lock in `jobs/importapplier/PostgresRunStore.java`, `PostgresLookups.java`, and `LockGuard.java`, and the upserts, removals, snapshot keep table, and commit marker in `PostgresImportStore.java`, run only against a real database. The Maven tests cover the queue order, validation, the decision, the report, and the apply rules, recovery, and re-derive over in-memory stores (`ApplyTest`), not these statements.
- **Cause.** The `event-processor` CI job has no Postgres.
- **Evidence.** Read from the tests.
