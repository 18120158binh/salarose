---
title: Import metric pass
slug: import-metric-pass
purpose: Once a night, compute every imported metric and profile attribute from the import store, and publish only the values that changed, without filling the main Postgres's WAL.
status: accepted
implementation: partial
area: event-processor
tags: [data-import, batch, metrics, wal, idempotency]
created: 2026-11-08
updated: 2026-11-14
version: 1.0
known_issues: ../../known-issues/components/import-metric-pass.md
---

# Import metric pass

## Purpose

Marketers target on values such as "spend in the last 90 days" and "loyalty tier", which come from a shop's imported records ([data import](../../features/data-import.md)). The import metric pass computes those values once a night from the import store, and writes them to `customer_attributes` in the main Postgres, where [customer decision](customer-decision.md) and the segment runtime's nightly pass read them. It writes only rows whose values changed, at a pace the main Postgres's replication slots and disk can absorb, so a backfill cannot repeat #320.

## Scope

In scope:

- The schedule, the pass's `as_of`, and which applied runs a pass includes.
- Computing every imported metric definition that is not archived in SQL over every record, and carrying archived metrics' stored values forward.
- Reading every profile dataset's attribute columns and identifiers.
- Counting shared emails and phones.
- Publishing changed rows to `customer_attributes`, and deleting rows that nothing backs.
- The WAL governor.
- The pass record in `import_metric_passes`.

Out of scope:

- Validating and storing records. The [import applier](import-applier.md) does that.
- Evaluating conditions. [Customer decision](customer-decision.md#condition-language) evaluates them for tracked people, and the segment runtime's nightly pass for imported-only customers ([decision 0038](../decisions/0038-store-segment-membership-and-evaluate-every-segment.md)).
- Defining metrics. Staff define them in studio ([data import](../../features/data-import.md#imported-metrics)).

## Terms

| Term | Meaning |
|---|---|
| Pass | One run of this job, for one `as_of`. Row in `import_metric_passes`. No two passes share an `as_of`. |
| Pass lock | A session-level advisory lock on the main Postgres, apart from the applier's. The pass instance that holds it is the only one running. |
| `as_of` | The pass's scheduled time, 03:00 in the reporting time zone on the pass's date. Every window ends at it. |
| Imported metric definition | A dataset of kind `event`, a function, a column where the function needs one, filters, and a window in days or none. Row in `import_metric_definitions`. |
| Source | A profile dataset, or an event dataset's set of metrics. Column `source_id` of `customer_attributes`, which holds the dataset's name. |
| Attribute object | The JSON object of one customer's values from one source. |
| Attribute hash | The SHA-256 of the attribute object's canonical form, defined in [Build each row](#3-build-each-row). Column `attributes_hash`. |
| Shared value | An email or a phone that two or more customer keys hold across all profile datasets. |
| WAL governor | The pacing rules in [Publish under the WAL governor](#4-publish-under-the-wal-governor). |
| Cluster WAL rate | The main Postgres's total WAL rate, from the change in `pg_current_wal_lsn()` over time. It includes the live pipeline. |
| Own WAL | The WAL the pass's own statements wrote, from the WAL usage Postgres reports for each statement, such as `EXPLAIN (ANALYZE, WAL)` around each batch. That works on Postgres 16 with no extension loaded. |
| Deadline | 15 minutes before the next scheduled start after an attempt begins. A pass not `done` by then fails, so the next night starts fresh. |
| Disk reading | The worse of two free shares: the free share of the main Postgres node's root filesystem, and the main Postgres's database bytes against the size of its volume claim. |
| Reporting time zone | The deployment's IANA time zone for nightly schedules and for datetimes without an offset. A deployment setting, default `Asia/Ho_Chi_Minh`. |

## Behavior

At 03:00 on 2026-11-08 the pass starts with `as_of` `2026-11-08T03:00:00+07:00`. Every run that committed to the import store before its snapshot is in the pass. A run that commits at 03:01 lands in the 2026-11-09 pass.

The pass computes three `orders` metrics that are not archived, `spend_90d` (`SUM` of `total` over 90 days, `status = 'completed'`), `orders_90d` (`COUNT` over 90 days), and `last_order_at` (`LAST_TIME`, no window), and the attribute columns of the `customers` profile type. Customer `0912345678` has the row:

```json
{
	"customer_key": "0912345678",
	"source_id": "orders",
	"attributes": {
		"spend_90d": 12990000,
		"orders_90d": 3,
		"last_order_at": "2026-11-07T14:02:00+07:00"
	},
	"pass_id": "pass-2026-11-08"
}
```

The hash of that object equals the stored hash, because nothing changed since last night, so the pass does not write the row. Of 500,000 customers, 14,200 rows changed: new orders, and orders that left a 90-day window. The pass wrote those, recorded 14,200 changed rows and their WAL bytes, and ended at `done`.

The pass runs every night, with or without a delivery. A window moves each night, so a customer whose old order crossed a window edge gets a new value even when the shop sent nothing.

## Algorithm

### 1. Start

A pass has these transitions, each one a conditional update from the state it leaves:

| Transition | Owner |
|---|---|
| Insert at `running` | The pass job, on the first start at or after the scheduled time |
| Stamp `retry_requested_at` on a `failed` pass | Studio, on an admin's retry, after checking IMP-FR-18 |
| `failed` with `retry_requested_at` to `running`, clearing the stamp | The pass job |
| `running` to `done` | The pass job |
| `running` to `failed`, on an error, a crash reset, or the deadline | The pass job |

The pass job starts every 10 minutes and does this:

1. Take the pass lock. If another instance holds it, exit. If the connection that holds the lock drops, stop at once.
2. Move every pass at `running` to `failed` with reason `crashed`. The lock proves that it crashed.
3. If the latest scheduled time at or before now has no pass, insert one at `running` with that time as `as_of`. `as_of` is unique, so a second start for the same night inserts nothing. A missed 03:00 start runs at the next start.
4. Otherwise, if a `failed` pass has `retry_requested_at`, check IMP-FR-18 again. Clear the stamp and refuse when it fails. Otherwise move the pass to `running`, keeping its row and its `as_of`.
5. Otherwise exit.
6. Open one repeatable-read transaction on the import store. Every read in [Compute values](#2-compute-values) and [Build each row](#3-build-each-row) uses it.
7. Read the commit markers in `import_run_commits`. The pass includes exactly the runs whose markers it sees, and keeps their ids. Record the latest `committed_at` as `last_run_finished_at`.

### 2. Compute values

For each imported metric definition whose `archived_at` is null, run one grouped query over every record of its type, grouped by `customer_key`. The window is (`as_of` minus N days, `as_of`], measured as N times 86,400 seconds on `event_time`. A definition without a window covers every record with an `event_time` at or before `as_of`. Filters use the [catalog operators](customer-decision.md#condition-language) on the dataset's columns.

| Function | Value | Type |
|---|---|---|
| `COUNT` | Records in the window | `number` |
| `SUM`, `AVG`, `MIN`, `MAX`, `MEDIAN` | Over a `number` column's values in the window | `number` |
| `DISTINCT_COUNT` | Distinct values of a column in the window | `number` |
| `LATEST` | The column's value on the record with the latest `event_time`. A tie goes to the greatest `record_id`. | The column's type |
| `FIRST_TIME`, `LAST_TIME` | The earliest and the latest `event_time` in the window | `datetime` |

Every function is exact. A record whose column has no value is left out of a function that reads the column. `MEDIAN` of an even count is the mean of the two middle values. A customer with records of the type but none in the window gets 0 for `COUNT`, `SUM`, and `DISTINCT_COUNT`, and no value for every other function, as [customer decision's empty-window rule](customer-decision.md#metric-functions) says. No function returns a day count.

For each profile dataset, read each customer's row in `import_profiles`: every attribute column of the type's current version, plus the customer's normalized values from `import_identifiers` as the arrays `emails` and `phones`.

Count the holders of each email and phone value across all profile datasets. A value held by two or more customer keys is shared. A value that is a placeholder id of [event ingestion](event-ingestion.md), or that normalizes to one digit repeated, such as `+84000000000`, is shared too. The pass stores a shared value on every holder, and records the count of shared values on its row. In phases 1 and 2 of [data import identity](../../features/data-import.md#identity), shared values only show in reports. Phase 3 uses them to block merges.

### 3. Build each row

For each customer and source, build the attribute object:

- Keys are the metric names, or the profile type's column names plus `emails` and `phones`.
- For an event source, each metric whose `archived_at` is set keeps the key and value of the customer's stored `customer_attributes` row for that source, unchanged. The pass reads them in the repeatable-read transaction. A key the stored row lacks stays absent. Unarchiving ends the carry: the next pass computes the metric again.
- A value with no value is left out of the object.
- A `datetime` is written as ISO 8601 with the reporting time zone's offset, to the second.
- A `number` is converted to an IEEE 754 double, whatever type the query returned it as.
- `emails` and `phones` are sorted by code point, with duplicates removed. Every other array keeps its order, because its order is data.

The canonical form is the JSON Canonicalization Scheme of RFC 8785. It sorts object keys at every level, writes no spaces, and writes each number in one form, the shortest that reads back as the same double, so `300`, `300.0`, and `3e2` are all `300`. Two objects with the same values have the same canonical form and the same hash.

A customer and an event source get a row when the customer has at least one record of the type, in any window or none, or when their stored row holds a value of an archived metric. A customer whose only values are archived metrics keeps the row with those values. A customer and a profile source get a row when the customer has a row in `import_profiles` for the type.

The pass stages every built row and its hash in memory or in a local file of its own container, never in a main Postgres table, whose writes would count against the governor. It then ends the repeatable-read transaction before it publishes. A governor pause then holds no snapshot open on the import store, and vacuum there is not blocked.

### 4. Publish under the WAL governor

Compare each row's hash with `customer_attributes.attributes_hash` for the same (`customer_key`, `source_id`).

- Upsert each row whose hash differs, or which has no stored row, with this pass's `pass_id`.
- Delete each stored row whose (`customer_key`, `source_id`) got no row in [Build each row](#3-build-each-row), including rows of a dataset that no longer exists. A row that holds an archived metric's value always gets a row there, so only a tombstone or the dataset's removal deletes it.
- Read `person_tombstones` when publishing starts. Publish no row for a customer key whose tombstone is there, and delete its stored rows. A snapshot taken before a deletion then cannot bring the person back.
- Leave every other row alone.

Writes go in batches of 500. Before each batch, the governor reads:

- The cluster WAL rate over the last 60 seconds.
- The pass's own WAL, summed over its statements so far.
- Every slot's `safe_wal_size` from `pg_replication_slots`, and the `max_slot_wal_keep_size` setting.
- The disk reading: the free bytes of the main Postgres node's root filesystem from the monitoring stack, and the main Postgres's database bytes against its claim's size.

Then:

1. **Own rate.** Hold the pass's own WAL rate under 0.25 MB/s. Sleep to hold it.
2. **Cluster rate.** Pause while the cluster WAL rate is above 2 MB/s. Resume under 1.5 MB/s. The live pipeline at its peak writes about 6 MB/s, so the pass waits out a peak rather than adding to it.
3. **Slot headroom.** Pause while any slot's `safe_wal_size` is under half of `max_slot_wal_keep_size`. Resume when every slot is above two thirds of it. With no cap set, the reading counts as missing.
4. **Disk.** Pause while the disk reading's worse share is under 20% free. Resume when both shares are above 25% free.
5. **Deadline.** Before each batch and once a minute during a pause, check the deadline. At the deadline, stop, move the pass to `failed` with reason `timed_out:<last pause reason>`, and release the lock. The next night's pass computes every value from scratch.
6. **Missing readings.** Pause while any reading is missing, with the reading's name as the reason.
7. Record each pause, with its start, its end, and its reason, on the pass's row.

The cluster rate and the slot headroom bound what reaches the slots. The own rate bounds the pass's share of it. The pass's `wal_bytes` is its own WAL, never an LSN difference, because an LSN difference counts the live pipeline too.

### 5. End

Record `changed_rows`, `wal_bytes`, `counts`, and `finished_at`, and move the pass to `done`. In the same transaction, set `first_pass_id` to this pass on each included run that has none. On an error, record what was published and move the pass to `failed` with the error's class as its reason.

A failed pass leaves some rows from itself and the rest from the pass before. Each row carries its `pass_id`. Every value still comes from applied runs only. A retry takes a new snapshot, so it includes every run committed by then, which may be more than the failed attempt saw. It computes values for those runs, skips rows whose hash already matches, and finishes the pass. A retry is refused once a later pass is `done`, so it never publishes values older than the ones already live.

### Worked example

`orders_90d` is `COUNT` over 90 days. Customer `c-4` has orders at 2026-08-09T10:00+07:00 and 2026-10-20T10:00+07:00.

- The 2026-11-06 pass has `as_of` 2026-11-06T03:00+07:00, so its window starts at 2026-08-08T03:00+07:00. Both orders count: `orders_90d` is 2.
- The 2026-11-07 pass's window starts at 2026-08-09T03:00+07:00. Both still count. The hash is unchanged, so the row is not written.
- The 2026-11-08 pass's window starts at 2026-08-10T03:00+07:00. Only the October order counts: `orders_90d` is 1. The hash changes, and the row is written.
- `last_order_at` is 2026-10-20T10:00:00+07:00 on all three nights.

## Functional requirements

| Id | Requirement |
|---|---|
| IMP-FR-01 | A pass must start once a night, at the pass job's first start at or after 03:00 in the reporting time zone, whether or not a run arrived, with `as_of` set to that scheduled time. |
| IMP-FR-02 | Only the instance that holds the pass lock may run, and it must stop when the lock's connection drops. Before it starts its own pass, it must move every pass at `running` to `failed`. (the lead's default) |
| IMP-FR-03 | A pass must read the import store in one repeatable-read snapshot, must include exactly the runs whose commit markers that snapshot holds, and must end that transaction before it publishes. |
| IMP-FR-04 | A pass must set `first_pass_id` to itself on each run it includes that has none, in the transaction that moves it to `done`. A pass that fails sets none. |
| IMP-FR-05 | Each imported metric definition whose `archived_at` is null must compute, for every customer with a record of its type, the function in [Compute values](#2-compute-values) over the records in (`as_of` minus N days, `as_of`] that pass its filters, exactly. |
| IMP-FR-06 | A customer with records of the type but none in the window must get 0 for `COUNT`, `SUM`, and `DISTINCT_COUNT`, and no value for every other function. |
| IMP-FR-07 | A profile source's attribute object must hold the current version's attribute columns and the normalized `emails` and `phones` of the customer's profile row. |
| IMP-FR-08 | The pass must mark an email or phone as shared when two or more customer keys hold it, or when it is a placeholder or one digit repeated, and must record the count. |
| IMP-FR-09 | The pass must write a `customer_attributes` row only when its attribute hash differs from the stored row's, or no row is stored. |
| IMP-FR-10 | The pass must delete every `customer_attributes` row whose customer and source no longer have a backing profile row or record, except a row kept by IMP-FR-21. |
| IMP-FR-21 | For each imported metric definition whose `archived_at` is set, the pass must not compute it, and must carry the key and value of each customer's stored `customer_attributes` row forward unchanged. A customer whose stored row holds an archived metric's value must keep that row, with those values, even when no metric that is not archived has a value for them. A tombstone (IMP-FR-17) or the removal of the dataset still deletes the row. |
| IMP-FR-11 | The attribute hash must be the SHA-256 of the object's RFC 8785 canonical form, after numbers become doubles and `emails` and `phones` are sorted and deduplicated, so it depends on the values only. |
| IMP-FR-12 | Values of metrics that are not archived must be a pure function of the included runs, the definitions, and `as_of`. Archived metrics' values come from the stored rows by IMP-FR-21. Two passes with the same included runs, definitions, and `as_of` must compute the same values. |
| IMP-FR-18 | `as_of` must be unique across passes. A retry must keep its pass's `as_of`, and must be refused unless the pass is `failed` and no pass with a later `as_of` is `done`. (the lead's default) |
| IMP-FR-19 | An admin's retry must reach the job only through `retry_requested_at`, which studio stamps and the pass job clears when it moves the pass to `running` or refuses it. The job must act on it within 10 minutes. (the lead's default) |
| IMP-FR-20 | A pass that is not `done` at its deadline must stop, move to `failed` with reason `timed_out:<last pause reason>`, and release the pass lock. (the lead's default) |
| IMP-FR-13 | The pass must write under every rule of the WAL governor in [Publish under the WAL governor](#4-publish-under-the-wal-governor), and must pause when a reading it needs is missing, an unset slot cap included. (the lead's default) |
| IMP-FR-14 | The pass's row must record `as_of`, its state, `last_run_finished_at`, `changed_rows`, its own WAL as `wal_bytes`, its pauses, its counts, and its start and finish times. |
| IMP-FR-15 | The pass must be the only writer of `customer_attributes`. |
| IMP-FR-16 | The pass must write nothing to the import store. |
| IMP-FR-17 | The pass must publish no row for a customer key whose tombstone is in `person_tombstones` when publishing starts, and must delete that key's stored rows. |

## Non-functional requirements

| Id | Requirement |
|---|---|
| IMP-NFR-01 | At the record cap of 5 million records, a pass that writes no rows must finish within 1 hour with 1 vCPU and 2 GiB of memory. |
| IMP-NFR-02 | The pass's own WAL rate on the main Postgres, measured from its statements' WAL usage, must stay under 0.25 MB/s. The pass must not write while the cluster WAL rate is above 2 MB/s. (the lead's default) |
| IMP-NFR-03 | The schedule, the reporting time zone, the batch size, the own WAL rate, the cluster rate thresholds, the slot thresholds, and the disk thresholds must be configurable. Defaults: 03:00, `Asia/Ho_Chi_Minh`, 500 rows, 0.25 MB/s, pause above 2 MB/s and resume under 1.5 MB/s, pause under half of the cap and resume above two thirds, pause under 20% free and resume above 25%. |
| IMP-NFR-04 | `customer_attributes` must stay at the default replica identity and must join no publication. |
| IMP-NFR-05 | The pass's logs must carry pass ids, counts, and pauses, and must never carry a value or a customer key. |

## Interfaces

| Direction | Interface | Contract |
|---|---|---|
| Read | Import store `import_records`, `import_profiles`, `import_identifiers`, `import_run_commits` | See [import applier](import-applier.md#interfaces) |
| Read | `import_metric_definitions` | `id`, `record_type_id`, `name`, `display_name`, `function`, `column`, `filters`, `window_days`, `archived_at` |
| Read | `import_record_types`, `import_record_type_versions` | Names, kinds, and current columns |
| Read | `person_tombstones` | Tombstones, checked with the tombstone key |
| Write | `import_runs` | `first_pass_id` only |
| Read and write | `import_metric_passes` | `id`, `as_of` (unique), `state` (`running`, `done`, or `failed`), `reason`, `retry_requested_at`, `last_run_finished_at`, `counts`, `changed_rows`, `wal_bytes` (own WAL), `pauses`, `started_at`, `finished_at` |
| Read and write | `customer_attributes` | `customer_key`, `source_id`, `attributes` (`jsonb`), `attributes_hash`, `pass_id`, `updated_at`. Key (`customer_key`, `source_id`). |
| Read | `pg_replication_slots`, `pg_current_wal_lsn()`, `max_slot_wal_keep_size`, each statement's WAL usage, database sizes | Slot headroom, cluster WAL rate, own WAL, and database bytes on the main Postgres |
| Read | Monitoring stack | Free bytes of the main Postgres node's root filesystem |

Customer decision reads `customer_attributes` by `customer_key` ([customer decision](customer-decision.md#interfaces)). The segment runtime's nightly pass starts after this pass reaches `done` ([decision 0038](../decisions/0038-store-segment-membership-and-evaluate-every-segment.md)).

## Failure handling

| Case | Behavior |
|---|---|
| A crash or an error mid-publish | The pass ends at `failed`, or stays at `running` after a crash until the next lock holder moves it to `failed`. Published rows stay. An admin retries the pass with the same `as_of`, which skips rows whose hash already matches. |
| The schedule fires twice for one night | The second start finds the `as_of` taken, or the lock held, and exits. |
| An admin retries a failed pass after a later pass is `done` | Studio refuses the retry. |
| A reading stays missing, or the disk stays low, all day | The pass fails at its deadline with `timed_out:<reason>`, and `/data/imports` shows it. The next night's pass starts fresh. |
| A night's pass is missed entirely, such as during an outage | The next night's pass computes every value from scratch, so nothing is lost. |
| A pass still at `running` from a crash | The next lock holder moves it to `failed`, and then runs its own pass. |
| No slot cap is set | The slot reading is missing, so the governor pauses with reason `slot_cap_unset`. |
| The live pipeline writes above 2 MB/s | The governor pauses until the cluster rate is under 1.5 MB/s. |
| The monitoring stack is unreachable | The filesystem share is missing, so the governor pauses. The pass waits until the reading returns or its deadline passes. |
| A slot runs low on headroom mid-pass | The governor pauses until the slot recovers. |
| A metric definition names a column the current version no longer has | The definition gives no value for every customer. Studio's guards refuse that change while a definition uses the column, so this happens only after a hand edit. Log it. |
| The import store is unreachable | The pass ends at `failed` and writes nothing. |

## Acceptance criteria

- Given a night with no delivery, then a pass runs at 03:00 with `as_of` that night's 03:00. (IMP-FR-01)
- Given a pass instance that holds the pass lock, when a second instance starts, then it exits and writes nothing. (IMP-FR-02)
- Given a pass left at `running` by a crash, when the next instance takes the lock, then that pass is `failed` before the new pass's row exists. (IMP-FR-02)
- Given a pass with `as_of` 2026-11-08T03:00+07:00, when the schedule fires again that night, then no second row is inserted. (IMP-FR-18)
- Given a failed pass for 2026-11-07 and a `done` pass for 2026-11-08, when an admin retries the 2026-11-07 pass, then it is refused and no row changes. (IMP-FR-18)
- Given a run that commits after the pass's snapshot, then the pass's values exclude its records, and the next night's pass sets the run's `first_pass_id` when it reaches `done`. (IMP-FR-03, IMP-FR-04)
- Given a pass that includes a run and then fails, then the run's `first_pass_id` stays empty. When a later pass reaches `done`, then it holds that later pass. (IMP-FR-04)
- Given a failed pass with no later `done` pass, when an admin retries it at 10:00, then studio stamps `retry_requested_at`, and by 10:10 the job has moved the pass to `running` and cleared the stamp. (IMP-FR-19)
- Given a pass paused on a missing disk reading from 03:05 onward, then at 02:45 the next night it is `failed` with reason `timed_out:disk_reading`, the lock is free, and the 03:00 pass starts. (IMP-FR-20)
- Given the [worked example](#worked-example), then each night ends as it says. (IMP-FR-05, IMP-FR-09)
- Given orders with totals 100, 200, and an order with no total in the window, then `SUM` is 300, `AVG` is 150, and `COUNT` is 3. (IMP-FR-05)
- Given a customer whose only order is 200 days old, then `orders_90d` is 0, `spend_90d` is 0, and `MAX` of `total` over 90 days has no value. (IMP-FR-06)
- Given a `customers` profile with `loyalty_tier` `Gold` and the email `ann@example.com`, then the row for source `customers` holds `loyalty_tier` and `emails` `["ann@example.com"]`. (IMP-FR-07)
- Given two customer keys that both hold `ann@example.com`, then the pass counts one shared value and stores it on both. (IMP-FR-08)
- Given records unchanged since the last pass and no window crossings, then the pass writes zero rows. (IMP-FR-09)
- Given a customer whose only `orders` record is deleted by a tombstone, then the next pass deletes their `orders` row. (IMP-FR-10)
- Given customer `c-1` with a stored `orders` row `{"aov": 150, "spend_90d": 300}`, when staff archive `aov` and new orders for `c-1` arrive, then after the next pass `aov` is still 150 and `spend_90d` holds the new sum. Given customer `c-2` whose stored `orders` row is `{"aov": 90}` and every other `orders` metric archived, then after the next pass the row still exists with `{"aov": 90}`, and the pass wrote no new version of it. When `aov` is unarchived, then the next pass computes it again for both. (IMP-FR-21, IMP-FR-10)
- Given a pass whose snapshot was taken before a tombstone for `c-4` was requested, then the pass publishes no row for `c-4` and deletes its stored rows. (IMP-FR-17)
- Given two attribute objects with the same values, keys in different orders, `emails` `["b@x.vn", "a@x.vn"]` and `["a@x.vn", "b@x.vn"]`, and `spend_90d` returned as `300` and as `300.00`, then their hashes are equal. (IMP-FR-11)
- Given a pass that failed after publishing 600 of 1,000 changed rows, and no run committed since, when it is retried, then it writes the remaining 400, and `customer_attributes` equals that of a single clean pass with the same runs, definitions, and `as_of`. (IMP-FR-12)
- Given a pass that has staged its rows and is paused by the governor, then it holds no open transaction on the import store. (IMP-FR-03)
- Given a test that lowers a slot's `safe_wal_size` under half the cap, then the pass pauses, and resumes when it rises above two thirds. Given no cap set, or a missing filesystem reading, then the pass pauses with that reason. (IMP-FR-13)
- Given 30% free on the node's filesystem and database bytes at 85% of the claim, then the pass pauses for disk. (IMP-FR-13)
- Given a fake cluster WAL rate of 3 MB/s, then the pass writes nothing until the rate is under 1.5 MB/s. (IMP-FR-13, IMP-NFR-02)
- Given a test database where the applier, studio, and customer decision each run their writes, then no row of `customer_attributes` was written by any role but the pass's. (IMP-FR-15)
- Given a pass with the applier stopped, then every import store table holds the same rows before and after it, and the pass connects to the import store as a user that may only read. (IMP-FR-16)
- Given a finished pass while the live pipeline also wrote WAL, then its `wal_bytes` equals the sum of its own statements' WAL usage, not the LSN difference, and its row holds `changed_rows` and each pause. (IMP-FR-14)
- Given a backfill on a staging copy, then the pass reports its own measured WAL bytes, and its own rate stays under 0.25 MB/s. (IMP-NFR-02)
- Given 5 million records on a staging copy and no change since the last pass, then a pass with 1 vCPU and 2 GiB writes zero rows and is `done` within 1 hour. (IMP-NFR-01)
- Given the batch size set to 100 and the schedule to 04:00, then the pass starts at 04:00 and checks the governor every 100 rows. Given no settings, then the defaults in IMP-NFR-03 hold. (IMP-NFR-03)
- Given the main Postgres, then `customer_attributes` has replica identity `default` and is in no row of `pg_publication_tables`. (IMP-NFR-04)
- Given a pass that pauses and publishes, then its log lines hold its pass id, counts, and pauses, and no customer key or attribute value. (IMP-NFR-05)

## Open questions

None. The figures for WAL per changed row and pass duration are estimates in [decision 0040](../decisions/0040-import-through-a-batch-path-and-a-separate-store.md#why). The first backfill and the first week of passes correct them from `wal_bytes` and the pass durations.

## Related

- [Import applier](import-applier.md)
- [Customer decision](customer-decision.md)
- [Data import](../../features/data-import.md)
- [0040. Import through a batch path and a separate store](../decisions/0040-import-through-a-batch-path-and-a-separate-store.md)
- [0041. Imported data reaches conditions as profile attributes](../decisions/0041-imported-data-reaches-conditions-as-profile-attributes.md)
- [0038. Store segment membership and evaluate every segment](../decisions/0038-store-segment-membership-and-evaluate-every-segment.md)
- [Known issues](../../known-issues/components/import-metric-pass.md)
