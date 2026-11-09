---
title: Import through a batch path and a separate store
id: "0040"
status: accepted
date: 2026-11-08
tags: [data-import, postgres, wal, cdc, batch]
supersedes: []
superseded_by: []
---

# 0040. Import through a batch path and a separate store

## Context

A shop wants to bring its own orders, refunds, and customer records into the platform once a day, so that marketers can target on them ([data import](../../features/data-import.md)). A first delivery is often a backfill of years of history: millions of rows in one file.

The platform has one way in today. Events reach `snowplow-parsed`, customer decision folds them into per-person series, and the profile writer upserts each changed series into `user_metrics`. All of it runs against the main Postgres, `cdp-pg`, which has seven CDC replication slots. A slot keeps every WAL segment the whole cluster writes until its job confirms it, whatever its publication covers.

In #320 the live pipeline wrote about 6 MB of WAL a second at 3,000 events a second, about 2 KB per event (measured). Retained WAL passed the 3 GB slot cap and every CDC slot was invalidated. The owner chose a hybrid on 2026-11-08. Part 1 shortens the CDC commit delay from 120 to 10 checkpoints, about 5 minutes, and raises `max_slot_wal_keep_size` from 3 GB to 8 GB. Part 2 later moves the busy tables to a second Postgres cluster.

The main Postgres runs on `data-1`, whose root disk is 30 GB and is shared with Kafka. Both use `local-path` volume claims, which keep each claim in a directory on the node's root filesystem and do not hold it to its size (SIM-KI-10). So the claims say little, and the root filesystem is the real limit.

## Decision

Imported records take a batch path that never enters the Flink jobs.

- Files land in an S3 drop zone. Two batch jobs read them: the **import applier**, which validates each run and upserts its records, and the **import metric pass**, which computes imported metrics once a night.
- Accepted records live in a second Postgres cluster, the **import store**, which has no replication slot. It runs on a compute node, never on `data-1`, with a 10 GiB `local-path` volume.
- Its tables come from their own DDL file. This amends [decision 0019](0019-keep-schema-sql-the-only-ddl-source.md) from one DDL file to one DDL file per Postgres cluster. Each file is still the only place that creates its cluster's tables, and no application creates tables.
- The main Postgres gets only run metadata and one table of per-customer results, `customer_attributes`, which the metric pass writes under a WAL governor.
- The applier and the metric pass do not run against a production main Postgres until #320 part 1 is merged and live (CDC window shortened, cap 8 GB). The governor's slot check needs that cap, and the pass treats an unset cap as a missing reading and pauses.

[The import applier](../components/import-applier.md) and [the import metric pass](../components/import-metric-pass.md) are the contracts.

Several rules this decision relies on are the lead's defaults of 2026-11-08, not the owner's decisions, and the owner may reverse them. [Data import](../../features/data-import.md#the-leads-defaults) lists each one with its requirement ids.

## Why

**The Flink path drops history.** [Decision 0028](0028-store-metrics-as-tiered-time-buckets.md) drops occurrences older than a definition's retention, 30 days by default. A two-year order history fed through `snowplow-parsed` would vanish on arrival.

**The Flink path repeats #320.** Every series update becomes a `customer-profile-mutations` message and a `user_metrics` upsert with `replica identity full`. That is the write pattern that filled the slots. A backfill of 5 million records would add that load in one burst.

**A second database in `cdp-pg` is not enough.** A Postgres cluster has one WAL stream. Every slot holds all of it, whatever its publication covers, so a backfill into a second database would still sit behind the seven CDC slots. A separate cluster has its own WAL, bounded by `max_wal_size` (1 GB), because no slot holds it.

**Most nights change few rows.** The metric pass hashes each customer's attribute object and writes only rows whose hash changed. At 500,000 customers with 2 to 5% changed, a night writes 10,000 to 25,000 rows. At 1 to 4 KB of WAL per changed row, that is 10 to 100 MB a night (estimate). The upper end counts full-page images. Scattered updates touch many heap and primary-key pages, the first change of each page after a checkpoint logs the whole 8 KB page, and `wal_compression` is off. The first pass after a backfill writes a row per customer and source, 1,000,000 rows, or 1 to 4 GB at the same rate per row (estimate). At the pass's own cap of 0.25 MB/s that takes 67 to 270 minutes. Each pass records its own WAL, so the estimates get corrected from measurement.

**The governor bounds what reaches the slots.** The main Postgres's WAL position is cluster-wide, so a difference of positions counts the live pipeline too. The governor therefore uses two readings. The cluster rate, from the WAL position, must stay under 2 MB/s, or the pass pauses. The pass's own rate, from the WAL usage Postgres reports for each of its statements, must stay under 0.25 MB/s. It also pauses on low slot headroom, and on low free disk.

**The arithmetic after #320 part 1.** Each slot holds about 10 checkpoints of WAL, about 5 minutes, and about 10 minutes for the outbox job. At the governor's 2 MB/s ceiling, 10 minutes is 1.2 GB, well under the 8 GB cap. The pass's own share is at most 0.25 MB/s, or 150 MB in that window. Under today's settings, a 60-minute window and a 3 GB cap, the design's figure was about 1.3 GB: 0.25 MB/s from the pass plus 0.1 MB/s from a small shop's 50 events a second. The gate removes that case. A stalled CDC job holds WAL past its window, and the slot check pauses the pass when headroom falls under half the cap.

**The disk on `data-1` is the tighter limit.** The root disk is 30 GB, and Kafka and the main Postgres share it. After the #320 load run it had 15 GB used, with Kafka at 6.5 GB and Postgres at 2.8 GB (measured, in the CDC window decision record of #337). That leaves about 5.7 GB for the operating system, k3s, and container images. After part 1, a stopped job's slot may hold the full 8 GB cap, which leaves about 7 GB free. The import adds `customer_attributes`, about 0.6 GB for 1,000,000 rows with its index (estimate), and at most 150 MB of retained WAL.

The governor reads the worse of two free shares, the node's root filesystem and the database's bytes against its 8 GiB claim. It pauses under 20% free on either and resumes above 25%. The measured figures mean two things:

- With a slot at its cap, the filesystem has about 23% free. That is above the pause line and under the resume line, so after any dip under 20% the pass stays paused until the slot drains. If the slot does not drain by the pass's deadline, the pass fails with `timed_out:disk`, and `/data/imports` shows it. The platform reports the stall instead of hanging.
- Postgres at 2.8 GB uses about 33% of its 8 GiB claim, or about 41% with `customer_attributes`. The database share pauses the pass only once the database passes about 6.4 GiB, so it does not pause at today's size.

The pass adds no WAL to the disk while it pauses, but the live pipeline and Kafka still do. Fixing the disk belongs to #320. The import adds as little to it as it can.

**The import store's own disk.** The applier writes the import store without a governor, so it must not share a disk with the main Postgres or Kafka. It runs on a compute node, whose root disk is also 30 GB. Its 10 GiB volume holds, at the record cap of 5 million records:

| Part | Size (estimate) |
|---|---|
| `import_records` heap, about 350 bytes a row with `jsonb` | 1.8 GB |
| Primary key (`record_type_id`, `record_id`) | 0.3 GB |
| Index (`record_type_id`, `customer_key`, `event_time`) | 0.35 GB |
| Profiles and identifiers for 500,000 customers | 0.4 GB |
| WAL, bounded by `max_wal_size` because no slot holds it | 1 GB |
| Total | About 3.9 GB of the 10 GiB volume |

The headroom covers a full rewrite of `import_records`, about 2.5 GB more, by a re-derive or a `VACUUM FULL`.

**Batch fits the need.** The owner settled on 2026-11-08 that yesterday's data is good enough. A nightly job needs no keyed state, no checkpoint, and no restart of the Flink jobs when it ships.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Feed imported records into `snowplow-parsed` | Retention drops the history, and the mutation and upsert load is the pattern of #320. |
| Write imported series into `user_metrics` | Customer decision keeps serving its cached series ([decision 0005](0005-keep-live-state-in-flink.md)), and the table gets a second writer, which breaks [decision 0002](0002-key-every-write-by-its-owner.md). |
| Route imported series through customer decision's keyed state | Keeps one writer, but costs a new keyed input, a nightly burst of full-series rewrites through Kafka, and sketch binaries built outside Java. |
| Store imported records in a second database of `cdp-pg` | One WAL stream per cluster, so the backfill's WAL still sits behind every CDC slot. |
| One table per record type in the import store | Needs DDL at run time, which [decision 0019](0019-keep-schema-sql-the-only-ddl-source.md) forbids. Fixed tables with the shop's columns in `jsonb` need none. |
| Pull connectors that read the shop's database | The owner ruled them out on 2026-11-08. |

## Consequences

- The import never stalls a Flink job, and a release of the batch jobs restarts none, because they ship in their own image with per-image tags.
- Freshness is one day. Shops that need minutes use the [data ingestion API](../../features/data-ingestion-api.md).
- The platform runs a second Postgres cluster, `cdp-import-pg`, on a compute node with its own volume. No backup runs for either cluster today, and [decision 0042](0042-keep-imported-contact-details-plain-behind-masking-and-tombstones.md) bounds any backup added later.
- #320 part 2 moves the busy tables to another cluster. Those tables need CDC slots, so they cannot share the import store without giving it slots. Merging the two clusters would need a new decision.
- The main Postgres's 8 GiB claim cannot hold its data plus an 8 GB slot cap. The claim is not enforced, so nothing breaks, but the database share of the disk reading compares the database's bytes only, not its WAL.
- `customer_attributes` stays at the default replica identity and joins no publication. With `wal_level=logical`, `replica identity full` would log the old row on every update.
- The metric pass is the only writer of `customer_attributes`, and the applier is the only writer of the import store. No two jobs contend for a row.
- Every step converges when it runs twice. Records upsert on natural keys, and the metric pass is a pure function of the stored records, the definitions, and its `as_of`.
- The governor's thresholds are configuration, so they follow #320 part 2 when it lands.

## Related

- [Data import](../../features/data-import.md)
- [Import applier](../components/import-applier.md)
- [Import metric pass](../components/import-metric-pass.md)
- [0041. Imported data reaches conditions as profile attributes](0041-imported-data-reaches-conditions-as-profile-attributes.md)
- [0042. Keep imported contact details in plain form behind masking and tombstones](0042-keep-imported-contact-details-plain-behind-masking-and-tombstones.md)
- [0002. Key every stateful write by its owner](0002-key-every-write-by-its-owner.md)
- [0019. Keep `schema.sql` the only DDL source](0019-keep-schema-sql-the-only-ddl-source.md)
- [0028. Store metrics as tiered time buckets](0028-store-metrics-as-tiered-time-buckets.md)
