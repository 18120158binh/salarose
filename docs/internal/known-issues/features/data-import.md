---
title: Data import known issues
contract: ../../features/data-import.md
updated: 2026-11-17
verified_at: 7e88968c
---

# Data import known issues

The batch API routes exist. Studio screens and the import applier are built by the other data-import issues, which cite the contract's requirement ids.

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| DIM-KI-01 | Risk | A dataset switched to snapshot can keep two writers | DIM-FR-09 |
| DIM-KI-02 | Risk | The batch API runs inside studio | DIM-FR-30 |

## DIM-KI-01. A dataset switched to snapshot can keep two writers

- **Symptom.** An incremental dataset that two source keys write can get a new version with delivery mode `snapshot`. Both keys keep their scope, so the dataset has two writers. `POST /v1/imports` then refuses both keys with `403` until an admin removes one scope.
- **Cause.** `saveDatasetVersionAction` in `src/features/data-import/model/datasetsActions.ts` does not count the dataset's writers before it saves a snapshot version. `grantImportScopeAction` in `src/features/data-import/model/scopesActions.ts` checks the rule only when a scope is granted.
- **Evidence.** Read from the code. No delivery is lost: the route refuses before it creates a run.

## DIM-KI-02. The batch API runs inside studio

- **Symptom.** A `studio` deploy, restart, or outage refuses `POST /v1/imports`, `complete`, `POST /v1/records`, and `GET /v1/imports/{run_id}`.
- **Cause.** The routes are Next route handlers in `app/v1/imports/route.ts`, `app/v1/imports/[run_id]/route.ts`, `app/v1/imports/[run_id]/complete/route.ts`, and `app/v1/records/[record_type]/route.ts`, built into the `studio` image.
- **Evidence.** Read from the code at `fe53fe6`.
- **Fix direction.** Move the routes into the service of [decision 0057](../../architecture/decisions/0057-run-the-data-ingestion-api-as-its-own-service.md) with the event routes (DIA-KI-06), then remove them from `studio`.
