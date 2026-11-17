---
title: State recovery known issues
contract: ../../architecture/components/state-recovery.md
updated: 2026-11-17
verified_at: a29730c
---

# State recovery known issues

Java paths are relative to `event-processor/src/main/java/com/cdp/platform/`. Each job's manifest is in `infra/k8s/apps/flink-*/`, and `infra/k8s/apps/flink-common/common.yaml` holds what they share.

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| REC-KI-01 | Risk | Nothing in the repo retains checkpoints when a job is cancelled | REC-FR-01 |
| REC-KI-02 | Risk | No job takes a scheduled savepoint | REC-FR-02, REC-NFR-04 |
| REC-KI-03 | Risk | Savepoints sit in an unversioned bucket | REC-FR-04, REC-FR-11 |
| REC-KI-04 | Risk | The CI restore test covers event parse only | REC-FR-06 |
| REC-KI-05 | Risk | No copy of the raw events outlives Kafka's retention | REC-FR-08, REC-FR-13, REC-FR-14, REC-FR-15, REC-NFR-03 |
| REC-KI-06 | Risk | No deploy checks the age of the last completed checkpoint before it rolls | REC-FR-12 |

## REC-KI-01. Nothing in the repo retains checkpoints when a job is cancelled

- **Symptom.** A job cancelled without a savepoint may leave no checkpoint to start from.
- **Cause.** The job manifests set `execution.checkpointing.dir` and `execution.checkpointing.savepoint-dir` per job, and `common.yaml` sets RocksDB and incremental checkpoints, but no file sets `execution.checkpointing.externalized-checkpoint-retention`. The operator's values in `infra/k8s/platform/flink-operator.yaml` set none either. The effective value is then Flink's or the operator's default.
- **Evidence.** Read from the manifests at `a29730c`. The default in force on the cluster is inferred, not checked.
- **Fix direction.** Set the retention to retain on cancellation in `common.yaml`, and check it on the cluster's job configuration.

Tracked in #106.

## REC-KI-02. No job takes a scheduled savepoint

- **Symptom.** Savepoints exist only from upgrades, which `upgradeMode: savepoint` takes on each deploy, and by hand. A job that runs for a week without a deploy has a savepoint a week old.
- **Cause.** No manifest sets the operator's periodic savepoint interval or savepoint history settings.
- **Evidence.** Read from `infra/k8s/apps/flink-*/` and `infra/k8s/platform/flink-operator.yaml` at `a29730c`.
- **Fix direction.** Set a daily periodic savepoint and a history age of 7 days per job (REC-FR-04), and alert when a job has no new scheduled savepoint for more than 26 hours (REC-NFR-04).

Tracked in #107.

## REC-KI-03. Savepoints sit in an unversioned bucket

- **Symptom.** A savepoint deleted or overwritten by mistake cannot be restored.
- **Cause.** Every job writes savepoints under `s3://<bucket>/flink/<job>/savepoints` in the deployment's one bucket. `infra/aws-free-plan/terraform/modules/drop-zone-lifecycle/main.tf` states that the bucket is unversioned, and that versioning would keep rewritten import files, which DIM-NFR-08 forbids.
- **Evidence.** Read from the job manifests and the Terraform module at `a29730c`.
- **Fix direction.** A versioned bucket, or prefix with its own lifecycle, for savepoints only, so the drop zone stays unversioned.

Tracked in #108.

## REC-KI-04. The CI restore test covers event parse only

- **Symptom.** A change that breaks the state of customer decision, the profile writer, the state machine, or the outbox passes CI and fails at the deploy's restore.
- **Cause.** The job `flink-restore` in `.github/workflows/pr-checks.yml` runs `event-processor/scripts/restore-check.sh`, whose entry class is fixed to `com.cdp.platform.jobs.eventparser.EventParseJob`.
- **Evidence.** Read from the workflow and the script at `a29730c`.
- **Fix direction.** Run the same check for every job with state, each restoring its own production savepoint.

Tracked in #109.

## REC-KI-05. No copy of the raw events outlives Kafka's retention

- **Symptom.** A job that loses every savepoint can rebuild only from what Kafka still holds, 72 hours at most, and from the Postgres projection. Journey progress older than that is lost.
- **Cause.** The lakehouse sink is not built, so nothing writes `raw_events`, `internal_events`, or `change_history`. The collector's and the API's topics keep 72 hours (`infra/k8s/data/kafka.yaml`). No rebuild run exists, so nothing records a cut, fires timers in event time, or raises a rebuild epoch.
- **Evidence.** Read from the manifests at `a29730c`.
- **Fix direction.** Build the [lakehouse sink](../../architecture/components/lakehouse.md), with its internal events and change history, then the rebuild run of [state recovery](../../architecture/components/state-recovery.md#rebuild-from-raw-events), with its cut, event-time timers, and rebuild epoch.

Tracked in #110.

## REC-KI-06. No deploy checks the age of the last completed checkpoint before it rolls

- **Symptom.** A deploy rolls a job whose checkpoints have failed for hours, and its savepoint, or the checkpoint it falls back to, can be that old.
- **Cause.** The `deploy` skill (`.agents/skills/deploy/SKILL.md`) checks after the rollout that checkpoints complete. Nothing before the rollout reads the last completed checkpoint's time. `infra/k8s/apps/monitoring/pipeline-alerts.yaml` alerts on failed checkpoints, not on their age at a deploy.
- **Evidence.** Read from the skill and the manifests at `218536f`.
- **Fix direction.** Before the rollout, read each job's latest completed checkpoint from the Flink REST API (`/jobs/<id>/checkpoints`), and stop the deploy when it is older than 1 hour.
