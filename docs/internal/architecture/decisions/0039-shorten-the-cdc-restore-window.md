---
title: Shorten the CDC restore window to keep slots under the WAL cap
id: "0039"
status: accepted
date: 2026-11-08
tags: [flink, cdc, postgres, operations]
supersedes: []
superseded_by: []
---

# 0039. Shorten the CDC restore window to keep slots under the WAL cap

## Context

Each CDC source confirms to its replication slot the log position of a checkpoint some number of completed checkpoints back, not the latest one. The slot keeps every change after the oldest of those checkpoints, so a job restored from any of them, such as a rollback to the savepoint taken before a deploy, reads every change it missed. This is the CDC restore window, JEX-NFR-10. The count was 120: about one hour at the 30 second checkpoint interval, and about two hours for the outbox job at 60 seconds.

A slot holds the WAL that the whole database writes, not only the WAL of its own tables. The Postgres cluster also capped the WAL a slot may hold, with `max_slot_wal_keep_size` at 3 GB, so that the slot of a stopped job cannot fill the disk.

The two settings contradicted each other. In a load run on 2026-11-07, 3,000 events per second wrote about 6 MB/s of WAL (`pg_current_wal_lsn` moved about 430 MB in 72 seconds), mostly to `identity_graph`, `user_metrics`, and `user_campaign_state_transitions`. At 18:49 UTC every slot held 2.0 to 2.3 GB of WAL. By 18:55 every slot had passed 3 GB, and Postgres invalidated all seven. The jobs kept running, but no CDC change reached them until the slots were dropped and created again (#320).

## Decision

Confirm the position of the checkpoint 10 completed checkpoints back, and make the count a setting with that default. The restore window becomes about 5 minutes, and about 10 for the outbox job. Raise `max_slot_wal_keep_size` to 8 GB.

This is the first step of two. The second moves the busy tables to a second Postgres cluster, shared with the data import design. The slots of the configuration tables then hold only the WAL of configuration changes, which is small, and a long restore window becomes cheap again. That change gets its own record.

## Why

A running slot holds the WAL of its last 10 checkpoints and of the one in progress. At the measured 6 MB/s peak:

| Job | Hold | At 6 MB/s |
|---|---|---|
| 30 second interval | 11 × 30 s = 330 s | about 2 GB |
| Outbox, 60 second interval | 11 × 60 s = 660 s | about 4 GB |
| Any job, 120 checkpoints, before this change | 121 × 30 s = 3,630 s | about 22 GB, 43 GB for the outbox |

The cap of 8 GB is twice the largest hold. All slots share one WAL stream, so together they keep at most 8 GB of WAL that Postgres would otherwise remove.

Postgres's volume uses the `local-path` storage class, a directory on `data-1`'s 30 GB root disk, which Kafka shares. The class does not hold a claim to its size, so the disk is the real limit. After the load run that disk had 15 GB used, with Kafka at 6.5 GB and Postgres at 2.8 GB. Another 8 GB of held WAL makes 23 GB, about 77%, and leaves about 7 GB free. That figure holds for one load run's worth of Kafka data only. Kafka keeps 72 hours with no byte limit, so a second load run within 72 hours adds about another 6.5 GB, and with a full slot cap leaves about 0.5 GB free. That is an estimate from the measured numbers, not run. The owner chose 8 GB with this known, because a full cap needs a stopped or failing job at peak load. A byte limit on Kafka's retention is the follow-up.

A stopped job confirms nothing, so its slot grows with every write. At peak it passes 8 GB in about 22 minutes, up from about 8 minutes at 3 GB. At the idle write rate it takes far longer.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Keep 120 checkpoints and raise the cap above the hold | The outbox slot would need about 43 GB at peak, more than `data-1`'s whole disk. |
| Keep 120 checkpoints and remove the cap | A stopped job's slot, or one hour of peak writes, fills the disk Kafka shares, and Postgres stops. |
| Move the busy tables to a second cluster now | The right end state, but a larger change. The import pipeline waits on a working CDC path, so it comes second. |
| Confirm every checkpoint, with no delay | Any rollback to a savepoint taken before a deploy would skip the changes in between. 10 checkpoints still covers a rollback right after a failed deploy. |

## Consequences

- A rollback to the savepoint taken before a deploy reads every CDC change only within about 5 minutes of the new version's run. Past that, freeze campaign edits during a risky deploy, or apply them again after the rollback, as the deployment guide's section on rolling back to an older savepoint describes.
- A change to the count or to the checkpoint interval must keep the product of the count, the interval, and the peak WAL rate well under `max_slot_wal_keep_size`. Size both from the peak write rate, and write the arithmetic next to the setting.
- Postgres invalidates a slot silently from the job's view. Alert on `pg_replication_slots.wal_status` and on the age of the CDC heartbeat rows.
- The hold of 11 intervals assumes checkpoints complete on schedule. The source counts only completed checkpoints and keeps the count in memory, so a restart starts again at 0, and a failed or expired checkpoint does not count. A job that restarts or fails checkpoints more often than every 10 checkpoints holds WAL like a stopped job and passes the cap in about 22 minutes at peak. This is inferred from the connector's bytecode and the recovery of PLT-KI-15, not run. Treat a crash-looping or checkpoint-failing job as stopped, and alert on job restarts and failed checkpoints as well as on `wal_status`.
- Load runs on the AWS Free Plan cluster need 72 hours between them, or the previous run's topics deleted, until Kafka's retention has a byte limit.
- A rollback to a version from before this change brings back the 120 count, and at peak load its slots pass the cap in about 22 minutes.

## Related

- [Journey execution](../components/journey-execution.md#non-functional-requirements), JEX-NFR-10
- [Data model](../data-model.md)
- [Deployment: rolling back to an older savepoint](../../operations/deployment.md#rolling-back-to-an-older-savepoint)
- [0003. Load rules through CDC and broadcast state](0003-load-rules-through-cdc-and-broadcast-state.md)
- [0006. At-least-once delivery with idempotent writes](0006-at-least-once-delivery-with-idempotent-writes.md)
