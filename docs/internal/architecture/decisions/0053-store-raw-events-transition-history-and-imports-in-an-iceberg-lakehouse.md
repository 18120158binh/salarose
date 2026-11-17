---
title: Store raw events, transition history, and imports in an Iceberg lakehouse
id: "0053"
status: accepted
date: 2026-11-17
tags: [storage, lakehouse, iceberg, s3, data-import, analytics]
supersedes: ["0040"]
superseded_by: []
---

# 0053. Store raw events, transition history, and imports in an Iceberg lakehouse

> Amended on 2026-11-17. The owner answered the questions this record left open. [Amendments](#amendments) lists the answers. The text above them is unchanged.

## Context

Three kinds of data grow without a bound and are read in bulk, not per event:

- **Raw events.** The collector's and the ingestion API's topics keep 72 hours ([CAP-NFR-10](../capacity.md#non-functional-requirements)). After that, nothing holds the events the pipeline consumed. A job that loses its state cannot rebuild it from the events.
- **Transition history.** `user_campaign_state_transitions` keeps every completed node forever. Journey analytics and the home KPIs read it on every page view ([decision 0035](0035-compute-journey-analytics-from-transitions-on-read.md)). On 2026-11-08 the node analytics query for one journey of 847,118 transitions took 6.6 seconds on a cold cache, over the 2-second bound of JBD-NFR-03 (#66, measured with `EXPLAIN (ANALYZE, BUFFERS)` on the deployed database). The query scans every transition of the campaign, so its cost grows with the journey, not with the range.
- **Imported records.** [Decision 0040](0040-import-through-a-batch-path-and-a-separate-store.md) put accepted import records in a second Postgres cluster, the import store, `cdp-import-pg`, so that a backfill writes no WAL the CDC slots hold.

At 500 million events a month, raw events alone are about 50 GB a month for every 100 bytes per event (arithmetic, bytes per event not measured). That does not belong on the disk Postgres and Kafka share.

## Decision

Raw events, transition history, and imported records live in a lakehouse, which is files on S3 read and written as Apache Iceberg tables.

1. **Raw events.** A sink writes every record of the ingestion topics to an Iceberg table, unchanged. It is the source for a rebuild of Flink state ([decision 0054](0054-recover-flink-state-in-four-layers.md), layer 4).
2. **Transition history.** Every transition reaches an Iceberg table. Postgres keeps only the recent time partitions of `user_campaign_state_transitions` ([decision 0052](0052-keep-hot-state-in-flink-and-a-redesigned-projection-in-postgres.md)). A partition leaves Postgres only after the lakehouse holds every row of it.
3. **Analytics off the hot table.** Journey analytics and the home KPIs read transition history from the lakehouse, not from the table the state machine writes and the outbox reads. This amends [decision 0035](0035-compute-journey-analytics-from-transitions-on-read.md). The definitions and the compute-on-read approach stay, and the source moves.
4. **Data import.** The import applier writes accepted records to Iceberg tables. The import metric pass reads them there and writes only its summarized results, `customer_attributes`, to the main Postgres, under the WAL governor of decision 0040. This supersedes decision 0040's import store. The rest of decision 0040 stands: the batch path, the drop zone, the governor, and `customer_attributes`.

AWS managed services are allowed: S3, S3 Tables or Glue, Athena, RDS or Aurora, MSK, and Managed Flink. Which ones the deployment uses is out of scope here. The owner put architecture first on 2026-11-17.

These are open, and the contracts list them under "Open questions":

- Who reads the lakehouse analytics and how fresh they must be: studio dashboards in seconds, or analysts in minutes. The query engine follows from the answer.
- The Iceberg catalog, Glue or S3 Tables against a REST catalog, and the table layout and partitioning.
- How long transitions stay in Postgres before they move.

## Why

**Object storage fits data that only grows.** S3 holds the raw events and the history at a cost per gigabyte far below a database volume, with no WAL, no replication slot, and no disk shared with Kafka. A backfill or a month of history adds files, not database load.

**An open table format keeps the engine a free choice.** Iceberg gives atomic commits, snapshots, schema evolution, and row-level deletes on plain files. Flink, Spark, Trino, Athena, and DuckDB read and write it. The query engine question stays open without blocking the storage choice.

**Raw events make state recoverable.** Today a lost savepoint past Kafka's 72 hours loses every journey in progress, and every metric series the Postgres copy has not caught up with. Decision 0005 rejected Flink state as the only copy for that reason. With the raw events kept, a batch run of the same jobs rebuilds state exactly. That is the only layer of decision 0054 that does not depend on the jobs having run.

**Analytics stop competing with the engine.** The analytics indexes cost the state machine's sink on every insert (decision 0035, consequences), and a cold analytics query reads tens of thousands of pages from the database the pipeline writes (#66). On the lakehouse the hot table needs only the indexes the engine and the outbox use.

**One store for imports instead of a second Postgres cluster.** Decision 0040 chose a separate cluster so that import WAL never reaches a slot. The lakehouse writes no Postgres WAL at all, needs no volume on a compute node, and holds history that grows past the import store's 10 GiB. The metric pass already reads in one snapshot and writes a summary, which is how a lakehouse is read.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Keep the import store, a second Postgres cluster | A database to run for batch data that a table format holds with no WAL and no disk to size. |
| Keep raw events only in Kafka, with longer retention | Kafka's disk is shared with Postgres today ([PLT-KI-20](../../known-issues/platform.md#plt-ki-20-the-6-gib-kafka-volume-cannot-hold-72-hours-of-snowplow-good-at-the-target-load)). Months of events in Kafka cost broker disk and are hard to query. |
| Keep analytics on the hot table and add a rollup, as decision 0035 allowed | A rollup cannot give Completed for the entries that reached a node (decision 0035). The full history still grows in Postgres. |
| Delta Lake or Apache Hudi | Both work. Iceberg has the widest engine support among the AWS services allowed, including S3 Tables, Glue, and Athena. |
| Parquet files on S3 without a table format | No atomic commit across files, no row-level delete for a person's deletion, and no snapshot isolation for the metric pass. |
| A columnar database, such as ClickHouse | Another database to run. The owner chose no new database ([decision 0052](0052-keep-hot-state-in-flink-and-a-redesigned-projection-in-postgres.md)). |

## Consequences

- A new component, the [lakehouse sink](../components/lakehouse.md), owns the raw events and transition history tables.
- The [import applier](../components/import-applier.md) and the [import metric pass](../components/import-metric-pass.md) change their store. The import store cluster, `cdp-import-pg`, and its DDL file go away when they land. [Decision 0019](0019-keep-schema-sql-the-only-ddl-source.md)'s amendment by decision 0040, one DDL file per Postgres cluster, then covers only the main Postgres.
- A person's deletion of imported data must reach the import tables' files and every snapshot that still references them, within the 24 hours of IAP-NFR-05. Iceberg keeps old snapshots until they expire, so snapshot expiry is part of a deletion, not housekeeping. Whether a deletion reaches `raw_events` too is open ([lakehouse sink](../components/lakehouse.md#open-questions)).
- Imported emails and phones now sit in files on S3. The lakehouse's bucket encrypts every object on the server with a customer-managed KMS key (SSE-KMS). The owner decided this on 2026-11-17, and DIM-NFR-08 and LKH-NFR-06 require it.
- Analytics reads are as fresh as the transition history in the lakehouse. Until the freshness question is answered, the home overview and journey analytics keep reading the hot table, and their known issues record it.
- `campaign_node_stats` counts only the rows still in Postgres once partitions move. Its all-time count must combine both stores, or move to the lakehouse with the rest of analytics ([journey execution](../components/journey-execution.md#open-questions)).
- Decision 0040 is superseded in part. Its batch path, governor, and `customer_attributes` stay. Its import store does not.

## Amendments

The owner answered this record's open questions on 2026-11-17. Each answer is written as requirements in the contract it changes.

| Question | Answer | Where |
|---|---|---|
| Who reads lakehouse analytics, how fresh, and with which engine | A hot window from Postgres, seconds fresh, for recent ranges, and history from the lakehouse through Athena, a serverless engine. No engine runs between queries. The two read paths must agree at the boundary (#111). | [LKH-FR-17](../components/lakehouse.md#functional-requirements), [JEX-FR-23](../components/journey-execution.md#functional-requirements), HOM-NFR-04, JBD-NFR-04 |
| The catalog | S3 Tables, with its built-in compaction, for every lakehouse table (#115). | [LKH-NFR-08](../components/lakehouse.md#non-functional-requirements) |
| How long transitions stay in Postgres | 90 days of entry starts (#114). | [JEX-NFR-12](../components/journey-execution.md#non-functional-requirements) |
| How long `raw_events` keeps records | 13 months. A rebuild is exact only for state whose inputs fall within them (#126). | [LKH-NFR-01](../components/lakehouse.md#non-functional-requirements), [REC-NFR-06](../components/state-recovery.md#non-functional-requirements) |
| Whether a person's deletion reaches `raw_events` | No. Raw events are kept as received, so rebuilds stay exact. Personal data in raw events outlives a deletion request for up to 13 months (#127). | [LKH-FR-16, LKH-NFR-09](../components/lakehouse.md#functional-requirements), [DIM-NFR-10](../../features/data-import.md#non-functional-requirements) |
| Simulator rows in `transition_history` | Not deleted. Analytics leave out `sim_` campaigns (#124). | [LKH-FR-18](../components/lakehouse.md#functional-requirements), [SIM-FR-28](../../features/traffic-simulator.md#functional-requirements) |
| Where customer lookup reads older transitions | From `transition_history` too, split at the same boundary as analytics (#125). | [CUS-FR-43](../../features/customer-lookup.md#functional-requirements) |
| The import record cap | 100 million records per file. The metric pass must still meet its time bound (#131). | [IAP-NFR-03](../components/import-applier.md#non-functional-requirements), [IMP-NFR-01](../components/import-metric-pass.md#non-functional-requirements) |

Two consequences differ from the text above. Analytics keep reading the hot table for recent ranges, so the analytics indexes stay on the hot partitions ([JEX-NFR-13](../components/journey-execution.md#non-functional-requirements)). The lakehouse also keeps the internal topics and the history of the Postgres tables a rebuild reads, by the answers in [decision 0054](0054-recover-flink-state-in-four-layers.md#amendments).

The partitioning of the tables other than `transition_history`, and the compaction bound, stay open in the [lakehouse sink](../components/lakehouse.md#open-questions).

## Related

- [0040. Import through a batch path and a separate store](0040-import-through-a-batch-path-and-a-separate-store.md), superseded in part
- [0035. Compute journey analytics from the transitions on read](0035-compute-journey-analytics-from-transitions-on-read.md), amended
- [0052. Keep hot state in Flink and a redesigned projection in Postgres](0052-keep-hot-state-in-flink-and-a-redesigned-projection-in-postgres.md)
- [0054. Recover Flink state in four layers](0054-recover-flink-state-in-four-layers.md)
- [Lakehouse sink](../components/lakehouse.md)
- [Import applier](../components/import-applier.md), [import metric pass](../components/import-metric-pass.md)
- [Home overview](../../features/home-overview.md), [journey builder: node analytics](../../features/journey-builder.md#node-analytics)
