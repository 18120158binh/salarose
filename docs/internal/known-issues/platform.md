---
title: Platform known issues
contract: ../architecture/capacity.md
updated: 2026-11-09
verified_at: b52e8830
---

# Platform known issues

This page holds the gaps against [platform capacity](../architecture/capacity.md), and the build, tooling, and shared-code issues that no other contract owns. Those cite [the architecture overview](../architecture/overview.md). Java paths are relative to `event-processor/src/main/java/com/cdp/platform/`. TypeScript paths are relative to the repository root.

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| PLT-KI-16 | Risk | The event-path tables share the database whose WAL every CDC slot holds | CAP-NFR-02, CAP-NFR-03 |
| PLT-KI-17 | Risk | Kafka's retention has no byte limit, and Kafka shares a disk with Postgres | CAP-FR-06, CAP-NFR-08 |
| PLT-KI-18 | Risk | `user_metrics` has full replica identity, but no publication covers it | CAP-FR-14 |
| PLT-KI-19 | Risk | The simulator's load mode does not stop when a slot becomes `unreserved` or `lost` | CAP-FR-16 |
| PLT-KI-20 | Risk | The 6 GiB Kafka volume cannot hold 72 hours of `snowplow-good` at the target load | CAP-NFR-10 |

## PLT-KI-16. The event-path tables share the database whose WAL every CDC slot holds

- **Symptom.** A burst on `identity_graph`, `user_metrics`, or `user_campaign_state_transitions` makes every replication slot hold its WAL, including the slots of the configuration tables, which change a few times a day. On 2026-11-07 one load run took all seven slots past the cap together (#320).
- **Cause.** Every table lives in the one database `auroracy`, and a slot keeps all the WAL the database writes after its confirmed position, not only the WAL of its publication's tables. The publications in `infra/db/schema.sql` (`CREATE publication ... FOR TABLE`) are per table, but that does not split the WAL. Part 1 of the fix (#337, [decision 0039](../architecture/decisions/0039-shorten-the-cdc-restore-window.md)) shortened the confirm window and raised `max_slot_wal_keep_size` to 8 GB. Part 2, moving the busy tables out, is open.
- **Evidence.** The incident and Part 2's status are in [rollout known issues](../operations/rollout-known-issues.md#cdc-slots-were-invalidated-by-a-write-burst). That the shared WAL still applies is read from `schema.sql` and `infra/k8s/data/postgres.yaml`. No load test at the target load of CAP-NFR-01 has run, so whether the slots now pass CAP-NFR-02 and CAP-NFR-03 at the target is not known.
- **Fix direction.** Move the busy tables to a second Postgres cluster, as decision 0039 plans, in its own decision record.

## PLT-KI-17. Kafka's retention has no byte limit, and Kafka shares a disk with Postgres

- **Symptom.** Kafka keeps 72 hours of every topic but the dead-letter topic, which keeps 24 hours, whatever the volume. Its volume claims 6 GiB but sits on the same 30 GB root disk of `data-1` that holds Postgres and its slot WAL. Decision 0039 estimates that a second load run within 72 hours, with a full slot cap, leaves about 0.5 GB free. That is an estimate, not run.
- **Cause.** `infra/k8s/data/kafka.yaml` sets `log.retention.hours: 72`, a `size: 6Gi` claim, and no `log.retention.bytes`. `infra/k8s/data/topics.yaml` sets `retention.ms` only on `snowplow-parsed-dead-letters`. Kafka and Postgres both use the `local-path` storage class, which does not enforce a claim's size (`infra/k8s/data/postgres.yaml`).
- **Evidence.** Read from the manifests. The disk figures are in [decision 0039](../architecture/decisions/0039-shorten-the-cdc-restore-window.md#why), which names the byte limit as the follow-up.
- **Fix direction.** Size each topic's byte limit per partition from the sizing sheet (CAP-FR-06), keeping 72 hours of `snowplow-good` at the target load (CAP-NFR-10, PLT-KI-20), and check the disk against CAP-NFR-08.

## PLT-KI-18. `user_metrics` has full replica identity, but no publication covers it

- **Symptom.** Every update of a `user_metrics` row, the profile writer's upsert, writes the whole old row to WAL as well as the new one. No CDC reader uses the old row, so those bytes only fill the WAL the slots hold.
- **Cause.** `infra/db/schema.sql` and `infra/db/migrations/V0001__baseline.sql` run `ALTER TABLE user_metrics replica identity full`, and no publication lists `user_metrics` ([data model](../architecture/data-model.md#publications-for-cdc)).
- **Evidence.** Read from the schema. With `wal_level=logical`, Postgres logs the old row for a table with full replica identity whether or not a publication covers it. [Decision 0040](../architecture/decisions/0040-import-through-a-batch-path-and-a-separate-store.md#why) names this upsert as the write pattern of #320. How much WAL it adds per event is not measured.
- **Fix direction.** A migration that sets `user_metrics` back to the default replica identity, with the WAL per event measured before and after (CAP-FR-10). CAP-FR-14 is the lead's default, pending owner review.

## PLT-KI-19. The simulator's load mode does not stop when a slot becomes `unreserved` or `lost`

- **Symptom.** A load run at the target load keeps sending while a replication slot is `unreserved`, and after Postgres invalidates it. The run stops only when a volume passes 70% full, too many events reach the dead-letter topic, or a gauge cannot be read.
- **Cause.** `StopGuard.check` in `simulator/cdp_sim/load.py` checks only the Kafka and Postgres volumes and the dead-letter share (SIM-FR-12). It reads no slot. Bench mode has the check: `simulator/cdp_sim/cluster.py` lists the slots whose `wal_status` is not `reserved` or `extended`, and `simulator/cdp_sim/bench.py` stops on them, so `extended` already does not stop a bench run.
- **Evidence.** Read from the code. Not run.
- **Fix direction.** Read the same slot list on each load reading and stop on any slot that is `unreserved` or `lost`, as bench mode does. Add the check to the traffic simulator contract's load stop conditions in the same change.

## PLT-KI-20. The 6 GiB Kafka volume cannot hold 72 hours of `snowplow-good` at the target load

- **Symptom.** At 500 events per second, 72 hours of `snowplow-good` is about 130 million messages. Above about 50 bytes per message that is more than the whole 6 GiB claim, before any other topic. At 500 bytes per message it is about 65 GB, more than `data-1`'s 30 GB root disk that Kafka shares with Postgres.
- **Cause.** `infra/k8s/data/kafka.yaml` claims `size: 6Gi` on the `local-path` storage class, on `data-1`'s root disk. Nothing sized it from the target load.
- **Evidence.** The volume and disk sizes are read from the manifests and [decision 0039](../architecture/decisions/0039-shorten-the-cdc-restore-window.md#why). The message counts are arithmetic from CAP-NFR-10. Bytes per message are not measured.
- **Fix direction.** Measure the bytes per message of `snowplow-good`, size Kafka's volume and the disk under it by CAP-FR-06, and move Kafka off the disk Postgres uses if both do not fit with CAP-NFR-08's free space.
