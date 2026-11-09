---
title: Platform known issues
contract: ../architecture/overview.md
updated: 2026-11-09
verified_at: b52e8830
---

# Platform known issues

This page holds the build, tooling, and shared-code issues that no single feature owns, and the gaps against [platform capacity](../architecture/capacity.md). Java paths are relative to `event-processor/src/main/java/com/cdp/platform/`. TypeScript paths are relative to the repository root.

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| PLT-KI-16 | Risk | The event-path tables share the database whose WAL every CDC slot holds | CAP-NFR-02, CAP-NFR-03 |
| PLT-KI-17 | Risk | Kafka's retention has no byte limit, and Kafka shares a disk with Postgres | CAP-NFR-08, CAP-NFR-09 |
| PLT-KI-18 | Risk | `user_metrics` has full replica identity, but no publication covers it | CAP-FR-14 |

## PLT-KI-16. The event-path tables share the database whose WAL every CDC slot holds

- **Symptom.** A burst on `identity_graph`, `user_metrics`, or `user_campaign_state_transitions` makes every replication slot hold its WAL, including the slots of the configuration tables, which change a few times a day. On 2026-11-07 one load run took all seven slots past the cap together (#320).
- **Cause.** Every table lives in the one database `auroracy`, and a slot keeps all the WAL the database writes after its confirmed position, not only the WAL of its publication's tables. The publications in `infra/db/schema.sql` (`CREATE publication ... FOR TABLE`) are per table, but that does not split the WAL. Part 1 of the fix (#337, [decision 0039](../architecture/decisions/0039-shorten-the-cdc-restore-window.md)) shortened the confirm window and raised `max_slot_wal_keep_size` to 8 GB. Part 2, moving the busy tables out, is open.
- **Evidence.** The incident and Part 2's status are in [rollout known issues](../operations/rollout-known-issues.md#cdc-slots-were-invalidated-by-a-write-burst). That the shared WAL still applies is read from `schema.sql` and `infra/k8s/data/postgres.yaml`. No load test at the target load of CAP-NFR-01 has run, so whether the slots now pass CAP-NFR-02 and CAP-NFR-03 at the target is not known.
- **Fix direction.** Move the busy tables to a second Postgres cluster, as decision 0039 plans, in its own decision record.

## PLT-KI-17. Kafka's retention has no byte limit, and Kafka shares a disk with Postgres

- **Symptom.** Kafka keeps 72 hours of every topic whatever the volume, on the same 30 GB root disk of `data-1` that holds Postgres and its slot WAL. Decision 0039 estimates that a second load run within 72 hours, with a full slot cap, leaves about 0.5 GB free. That is an estimate, not run.
- **Cause.** `infra/k8s/data/kafka.yaml` sets `log.retention.hours: 72` and no `log.retention.bytes`. Kafka and Postgres both use the `local-path` storage class, which does not enforce a claim's size (`infra/k8s/data/postgres.yaml`).
- **Evidence.** Read from the manifests. The disk figures are in [decision 0039](../architecture/decisions/0039-shorten-the-cdc-restore-window.md#why), which names the byte limit as the follow-up.
- **Fix direction.** Size a byte limit per topic from the sizing sheet (CAP-FR-06), large enough to keep `snowplow-good` for 72 hours at the sustained load (CAP-NFR-09).

## PLT-KI-18. `user_metrics` has full replica identity, but no publication covers it

- **Symptom.** Every update of a `user_metrics` row, the profile writer's upsert, writes the whole old row to WAL as well as the new one. No CDC reader uses the old row, so those bytes only fill the WAL the slots hold.
- **Cause.** `infra/db/schema.sql` and `infra/db/migrations/V0001__baseline.sql` run `ALTER TABLE user_metrics replica identity full`, and no publication lists `user_metrics` ([data model](../architecture/data-model.md#publications-for-cdc)).
- **Evidence.** Read from the schema. With `wal_level=logical`, Postgres logs the old row for a table with full replica identity whether or not a publication covers it. [Decision 0040](../architecture/decisions/0040-import-through-a-batch-path-and-a-separate-store.md#why) names this upsert as the write pattern of #320. How much WAL it adds per event is not measured.
- **Fix direction.** A migration that sets `user_metrics` back to the default replica identity, with the WAL per event measured before and after (CAP-FR-10).
