---
title: State recovery
slug: state-recovery
purpose: Make the Flink jobs' keyed state hard to lose and recoverable from any loss, in four layers with a fixed order of trust.
status: draft
implementation: partial
area: event-processor
tags: [flink, state, checkpoints, savepoints, recovery, lakehouse]
created: 2026-11-17
updated: 2026-11-17
version: 0.2
known_issues: ../../known-issues/components/state-recovery.md
---

# State recovery

## Purpose

While the jobs run, Flink keyed state is the source of truth for each person's metrics and profiles ([decision 0052](../decisions/0052-keep-hot-state-in-flink-and-a-redesigned-projection-in-postgres.md)). The jobs also keep other state in Flink, such as journey progress and segment flags, and this contract protects all of it. This contract says how that state survives a crash, a bad deploy, a lost savepoint, and a start from nothing, so that an operator always has a way back and knows what each way loses. [Decision 0054](../decisions/0054-recover-flink-state-in-four-layers.md) records why there are four layers.

## Scope

In scope:

- Checkpoints, their storage, and their retention.
- Savepoints: their schedule, their storage, their retention, and the restore test.
- Fixed operator ids.
- Reading the metric projection in Postgres on a state miss, as a recovery layer.
- Rebuilding state from the raw events in the lakehouse, the inputs that rebuild needs, and its limits.
- The order of trust between the layers.

Out of scope:

- `identity_graph`. Postgres keeps owning it, as [decision 0012](../decisions/0012-resolve-events-without-a-device-from-the-durable-copy.md) and the [identity contracts](identity/README.md) say. It is not a layer of this contract.
- The CDC restore window of a restored job. [Journey execution](journey-execution.md#non-functional-requirements), JEX-NFR-10, owns it.
- How a job merges what it reads on a state miss with its own state. Each job's contract owns it, such as [customer decision](customer-decision.md).
- Storing the raw events and the other rebuild inputs. The [lakehouse sink](lakehouse.md) owns it.
- Backups of Postgres.

## Terms

| Term | Meaning |
|---|---|
| Job with state | A Flink job that keeps keyed or operator state: event parse, customer decision, the profile writer, the state machine, the outbox with its timer flow, and the business event fan-out. |
| Checkpoint | A snapshot of a job's state that the job takes on its own, at its checkpoint interval. |
| Retained checkpoint | A checkpoint that stays in storage after its job is cancelled. |
| Savepoint | A snapshot of a job's state that an operator or a schedule triggers, kept apart from checkpoints, and used for upgrades and rollbacks. |
| Operator id | The fixed name of an operator in a job graph. A savepoint stores state per operator id. |
| Restore test | Starting the new build of a job from a savepoint the running build wrote, and checking that it runs and completes a checkpoint. |
| Projection | The tier-2 copy of metrics in Postgres, `user_metrics`. |
| Rebuild | A batch run of the jobs over `raw_events`, and the other inputs [Rebuild from raw events](#rebuild-from-raw-events) lists, that rebuilds their state from scratch and ends with a savepoint. |
| Rebuild window | The 13 months of records `raw_events` keeps ([LKH-NFR-01](lakehouse.md#non-functional-requirements)). |
| Cut | The positions where a rebuild stops reading: one offset per partition of each ingestion topic, and the matching position per partition of each internal topic. |
| Rebuild epoch | A number that each rebuild raises by one. The profile writer compares it before the behavior version (PRW-FR-16). |
| Trust order | Raw events in the lakehouse first, then Flink state, then the projection. When two disagree, the one earlier in the order wins. |

## Behavior

| Loss | Layer | What the operator does | What is lost |
|---|---|---|---|
| A task manager crashes | 1 | Nothing. The job restores its latest checkpoint. | Nothing. The sources replay from the checkpoint. |
| A job is cancelled by mistake | 1 | Start it from its latest retained checkpoint. | Nothing, within the CDC restore window. |
| A deploy breaks state | 2 | Roll back to the savepoint taken before the deploy. | Changes the sources can no longer replay. Past the CDC restore window, CDC changes up to the slot's position. |
| A checkpoint and its savepoints are deleted | 2 | Restore an older version of the savepoint from versioned storage. | As above, from that older savepoint. |
| No usable savepoint, metrics needed | 3 | Start without state. Customer decision reads `user_metrics` on a miss. | Up to one coalescing window plus one flush of metric changes, and the rows the profile writer held. All journey progress. Segment flags, which customer decision publishes again at each person's next event. |
| No usable savepoint, everything needed | 4 | Run a rebuild, take its savepoint, and start the streaming jobs from it. | Nothing within the rebuild window. State whose inputs are older than 13 months, such as a segment flag set 14 months ago and never changed, cannot be rebuilt. |

Example. A release of customer decision changes a state type, and the new build cannot read the savepoint. The restore test in CI fails on the pull request, so the release does not ship. Had it shipped, the operator would restore the savepoint taken before the deploy with the old build.

### The limits of a rebuild

A rebuild is exact only within the rebuild window. The owner decided on 2026-11-17 that `raw_events` keeps 13 months (#126). State built from inputs older than that cannot be rebuilt from raw events. A metric over a window longer than 13 months, a segment flag whose last change is older, and a journey entry that opened before the window are rebuilt as if those older inputs never happened.

A rebuild also reads personal data that a deletion request did not remove. The owner decided on 2026-11-17 that a person's deletion does not reach `raw_events` (#127). Personal data in raw events outlives a deletion request for up to the 13 months of the window, and a rebuild inside that time restores the person's state from them.

## Algorithm

### Rebuild from raw events

The owner decided on 2026-11-17 that every input a job reads is kept in the lakehouse, so that a rebuild is exact (#118, #119). The rebuild is exact within the rebuild window when these inputs are complete:

- The configuration each job read at each event, from `change_history`: `campaign_nodes` with its `graph_version`, `user_metric_definitions`, `segments`, and the event catalog's `user_events` and `user_event_fields` ([LKH-FR-14](lakehouse.md#functional-requirements)).
- `customer_attributes` and `customer_profiles` as they were at each event, from `change_history` (LKH-FR-15).
- The records of the internal topics, such as `snowplow-parsed` and `journey-engine-matched-events`, from `internal_events` (LKH-FR-13).

Steps:

1. Stop the streaming jobs, taking a savepoint of each if they can still take one.
2. Record the cut (REC-FR-13). For each partition of each ingestion topic, take the newest offset `raw_events` holds. For each partition of each internal topic, take the matching position: the position after the last record the jobs derived from ingestion records at or before the cut.
3. Run every job with state in batch over its own inputs up to the cut, in the order the pipeline reads them: event parse, customer decision, the business event fan-out, the state machine, the outbox with its timer flow, and the profile writer. A job that reads an ingestion topic reads `raw_events`. A job that reads an internal topic reads `internal_events`. Each job reads its Postgres inputs from `change_history` as of each record's time.
4. Fire every watch timer at its deadline in event time (REC-FR-14). The outbox builds its state and sends nothing.
5. Write nothing to Postgres, Kafka, or a sender during the rebuild. The rebuild produces state only.
6. Raise the rebuild epoch, and take a savepoint of each job at the end.
7. Start each streaming job from its rebuilt savepoint, at the cut. A job that reads an ingestion topic starts after the newest ingestion record. A job that reads an internal topic starts at the matching position.

## Functional requirements

| Id | Requirement |
|---|---|
| REC-FR-01 | Every job with state must write its checkpoints to object storage, and must retain them when the job is cancelled. |
| REC-FR-02 | Every job with state must take a savepoint at least once a day, on a schedule. |
| REC-FR-03 | Every deploy of a job with state must take a savepoint before it stops the running job. When that savepoint fails, the deploy must stop, and the running job must keep running. The owner decided this on 2026-11-17 (#133). |
| REC-FR-04 | Savepoints must be kept for 7 days in storage that keeps earlier versions of every object, so that a deleted or overwritten savepoint can be restored. The owner decided the 7 days on 2026-11-17 (#113). |
| REC-FR-05 | Every operator of every job with state must have a fixed operator id that does not change when the job graph changes. |
| REC-FR-06 | CI must run a real restore test for every job with state on every change to `event-processor`: the new build must restore a savepoint that the running build wrote, run, and complete a checkpoint. The owner decided the trigger on 2026-11-17 (#123). |
| REC-FR-07 | A job that has no metric state for a key must read the projection and merge its own state over it, as [decision 0005](../decisions/0005-keep-live-state-in-flink.md) says. |
| REC-FR-08 | When its inputs are complete, a rebuild must produce, for every key, the state that the streaming jobs would hold after reading the same records within the rebuild window. |
| REC-FR-09 | A rebuild must write nothing to Postgres, Kafka, or a sender, and must end with a savepoint of each job. |
| REC-FR-10 | When two layers disagree, the one earlier in the trust order must win: raw events, then Flink state, then the projection. |
| REC-FR-11 | The versioned storage of savepoints must not keep earlier versions of imported files longer than DIM-NFR-08 allows. |
| REC-FR-12 | A deploy of a job with state must refuse to roll when the job's last completed checkpoint is older than 1 hour. The running job must keep running. The owner decided this on 2026-11-17 (#133), and set the 1 hour during the review of PR #173. |
| REC-FR-13 | A rebuild must record its cut and start each streaming job at it: after the newest ingestion record it read, and at the matching position of each internal topic. No record before the cut may be read twice by the streaming jobs, and none after it skipped. The owner decided this on 2026-11-17 (#120). |
| REC-FR-14 | A rebuild must fire every watch timer at its deadline in event time, and must give the outbox and its timer flow rebuilt state. The outbox must send nothing during a rebuild. The owner decided this on 2026-11-17 (#132). |
| REC-FR-15 | A rebuild must raise the rebuild epoch. Rebuilt state must carry it into every metric mutation, so that its rows replace older rows in `user_metrics` ([PRW-FR-16](profile-writer.md#functional-requirements)). A rebuild must not rewrite `user_metrics` in bulk. A person's row catches up at their next flush. The owner decided this on 2026-11-17 (#121). |

## Non-functional requirements

| Id | Requirement |
|---|---|
| REC-NFR-01 | Layer 1 loses no change the sources can replay. |
| REC-NFR-02 | Layer 3 loses at most one coalescing window plus one flush of metric changes per person ([PRW-NFR-02](profile-writer.md#non-functional-requirements)), all journey progress, and segment flags until each person's next event. |
| REC-NFR-03 | Layer 4 is exact for every record `raw_events` holds, when the inputs of [Rebuild from raw events](#rebuild-from-raw-events) are complete. |
| REC-NFR-04 | Savepoint age is monitored for every job with state. An alert fires when a job has had no new scheduled savepoint for more than 26 hours. The owner decided this on 2026-11-17, during the review of PR #173 (#113). |
| REC-NFR-05 | The duration of a rebuild is measured and recorded. No bound is set until the first rebuild runs. |
| REC-NFR-06 | Layer 4 cannot rebuild state whose inputs are older than the 13 months `raw_events` keeps ([LKH-NFR-01](lakehouse.md#non-functional-requirements)). Such state is rebuilt as if those inputs never happened. The owner accepted this limit on 2026-11-17 (#126). |
| REC-NFR-07 | Personal data in `raw_events` outlives a person's deletion request for up to 13 months ([LKH-NFR-09](lakehouse.md#non-functional-requirements)), and a rebuild in that time restores the person's state from it. The owner accepted this limit on 2026-11-17 (#127). |

## Interfaces

| Direction | Interface | Contract |
|---|---|---|
| Write and read | Object storage, checkpoints | Per job, retained on cancel |
| Write and read | Object storage, savepoints | Per job, versioned, kept 7 days |
| Read | `user_metrics` | The projection, on a state miss. See [the data model](../data-model.md). |
| Read | Lakehouse `raw_events`, `internal_events`, and `change_history` | For a rebuild. See [the lakehouse sink](lakehouse.md#interfaces). |

[Configuration](../../operations/configuration.md) will name the schedule, the retention, and the storage paths.

## Failure handling

| Case | Behavior |
|---|---|
| A scheduled savepoint fails | Alert. The job keeps running. The next schedule tries again. |
| A deploy's savepoint fails | The deploy stops. The running job keeps running, and an operator is alerted (REC-FR-03). |
| A deploy finds the job's last completed checkpoint older than 1 hour | The deploy refuses to roll. The running job keeps running, and an operator is alerted (REC-FR-12). |
| A restore test fails in CI | The change does not merge until the build restores the savepoint, or a decision accepts the state loss. |
| A savepoint is restored past the CDC restore window | The job skips CDC changes up to its slot's position, as JEX-NFR-10 says. Apply campaign edits again after the restore. |
| The projection is behind | A miss reads values up to one coalescing window plus one flush old (REC-NFR-02). |
| `raw_events` has a gap, such as an outage longer than Kafka's retention | A rebuild over the gap is not exact. It reports the gap by offset. |
| A rebuild's input is incomplete | The rebuild is not exact. It reports which input was missing. |
| A rebuild reaches the start of the rebuild window | State from older inputs is not rebuilt (REC-NFR-06). The report says so. |

## Acceptance criteria

- Given a job cancelled without a savepoint, then its latest checkpoint is still in object storage, and the job starts from it. (REC-FR-01)
- Given a job running for 48 hours with no deploy, then at least two scheduled savepoints of it exist. (REC-FR-02)
- Given a deploy of a job with state, then a savepoint of the running job exists, taken before the job stopped. Given a deploy whose savepoint fails, then the deploy stops and the old job is still running. (REC-FR-03)
- Given a savepoint deleted by hand, then an earlier version of it can be restored from storage for 7 days. (REC-FR-04)
- Given a change that adds an operator to a job graph, then the new build restores the previous build's savepoint with no state left unmatched. (REC-FR-05, REC-FR-06)
- Given a change that breaks a state type of any job with state, when the restore test runs, then it fails. Given a change to any file under `event-processor/`, then the restore test runs for every job with state. (REC-FR-06)
- Given customer decision started without state, when an event for a person with a `user_metrics` row arrives, then the job's series start from that row. (REC-FR-07)
- Given one day of `raw_events`, `internal_events`, and `change_history`, and a rebuild over them, then each job's state for a sample of keys equals the state of the streaming job that read the same records. (REC-FR-08, REC-NFR-03)
- Given a job whose last completed checkpoint is 61 minutes old, when a deploy runs, then it refuses to roll and the old job keeps running. Given one 59 minutes old and a savepoint that succeeds, then the deploy rolls. (REC-FR-12)
- Given a rebuild with its cut at offset 500 of `snowplow-good` partition 0, then event parse starts at 501, and customer decision starts on `snowplow-parsed` at the position after the last record derived from offset 500 or earlier. (REC-FR-13)
- Given a watch with a deadline of 10:15 in event time and no `success` before it in the raw events, when the rebuild passes 10:15, then the watch completes on `timeout`, and the outbox writes no request to Kafka. (REC-FR-14)
- Given a `user_metrics` row at behavior version 40 and a rebuild whose state for that series is at version 12, when the person's next event flushes, then the row holds the rebuilt series. (REC-FR-15)
- Given a segment flag whose only change is 14 months old, when a rebuild runs, then the rebuilt state holds no flag for it, and the rebuild's report states the window. (REC-NFR-06)
- Given a rebuild, then no row in Postgres, no Kafka record, and no notification request was written during it, and each job has a new savepoint. (REC-FR-09)
- Given rebuilt state and a `user_metrics` row that differ, when customer decision reads that person, then it uses the rebuilt state. (REC-FR-10)
- Given an imported file rewritten for a deletion, then one day later no earlier version of it exists, while savepoints keep theirs. (REC-FR-11)
- Given a crash of a task manager, then after the restore the job's state equals its state at the last checkpoint plus the replayed records. (REC-NFR-01)
- Given customer decision started without state, then each person's series lag their true value by at most one coalescing window plus one flush of changes. (REC-NFR-02)
- Given a job whose newest scheduled savepoint is 26 hours and 5 minutes old, then an alert fires. Given one 25 hours old, then none fires. (REC-NFR-04)
- Given a person's deletion request and their raw events 2 months old, when a rebuild runs, then the person's rebuilt state reflects those raw events. (REC-NFR-07)
- Given a rebuild, then its report states its duration. (REC-NFR-05)

## Open questions

None. The owner decided the rebuild and savepoint questions on 2026-11-17 (#113, #118 to #121, #123, #132, #133), and set the savepoint alert age and the checkpoint age the same day, during the review of PR #173.

## Related

- [0054. Recover Flink state in four layers](../decisions/0054-recover-flink-state-in-four-layers.md)
- [0005. Keep live state in Flink and a durable copy in Postgres](../decisions/0005-keep-live-state-in-flink.md)
- [0012. Resolve events without a device from the durable copy](../decisions/0012-resolve-events-without-a-device-from-the-durable-copy.md)
- [0039. Shorten the CDC restore window](../decisions/0039-shorten-the-cdc-restore-window.md)
- [Lakehouse sink](lakehouse.md)
- [Profile writer](profile-writer.md)
- [Journey execution](journey-execution.md)
- [Known issues](../../known-issues/components/state-recovery.md)
