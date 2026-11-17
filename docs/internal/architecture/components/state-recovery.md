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
version: 0.1
known_issues: ../../known-issues/components/state-recovery.md
---

# State recovery

## Purpose

While the jobs run, Flink keyed state is the source of truth for each person's identity, metrics, segment flags, and journey progress ([decision 0052](../decisions/0052-keep-hot-state-in-flink-and-a-redesigned-projection-in-postgres.md)). This contract says how that state survives a crash, a bad deploy, a lost savepoint, and a start from nothing, so that an operator always has a way back and knows what each way loses. [Decision 0054](../decisions/0054-recover-flink-state-in-four-layers.md) records why there are four layers.

## Scope

In scope:

- Checkpoints, their storage, and their retention.
- Savepoints: their schedule, their storage, their retention, and the restore test.
- Fixed operator ids.
- Reading the Postgres projection on a state miss, as a recovery layer.
- Rebuilding state from the raw events in the lakehouse.
- The order of trust between the layers.

Out of scope:

- The CDC restore window of a restored job. [Journey execution](journey-execution.md#non-functional-requirements), JEX-NFR-10, owns it.
- How a job merges what it reads on a state miss with its own state. Each job's contract owns it, such as [customer decision](customer-decision.md).
- Storing the raw events. The [lakehouse sink](lakehouse.md) owns it.
- Backups of Postgres.

## Terms

| Term | Meaning |
|---|---|
| Job with state | A Flink job that keeps keyed or operator state: event parse, customer decision, profile writer, state machine, and outbox with its timer flow, and the business event fan-out once built. |
| Checkpoint | A snapshot of a job's state that the job takes on its own, at its checkpoint interval. |
| Retained checkpoint | A checkpoint that stays in storage after its job is cancelled. |
| Savepoint | A snapshot of a job's state that an operator or a schedule triggers, kept apart from checkpoints, and used for upgrades and rollbacks. |
| Operator id | The fixed name of an operator in a job graph. A savepoint stores state per operator id. |
| Restore test | Starting the new build of a job from a savepoint the running build wrote, and checking that it runs and completes a checkpoint. |
| Projection | The tier-2 copy of state in Postgres: `user_metrics` and `identity_graph`. |
| Rebuild | A batch run of the jobs over `raw_events` that rebuilds their state from scratch and ends with a savepoint. |
| Trust order | Raw events in the lakehouse, then Flink state, then the projection. |

## Behavior

| Loss | Layer | What the operator does | What is lost |
|---|---|---|---|
| A task manager crashes | 1 | Nothing. The job restores its latest checkpoint. | Nothing. The sources replay from the checkpoint. |
| A job is cancelled by mistake | 1 | Start it from its latest retained checkpoint. | Nothing, within the CDC restore window. |
| A deploy breaks state | 2 | Roll back to the savepoint taken before the deploy. | Changes the sources can no longer replay. Past the CDC restore window, CDC changes up to the slot's position. |
| A checkpoint and its savepoints are deleted | 2 | Restore an older version of the savepoint from versioned storage. | As above, from that older savepoint. |
| No usable savepoint, metrics and identity needed | 3 | Start without state. Each job reads the projection on a miss. | Up to one coalescing window of metric changes. All journey progress. |
| No usable savepoint, everything needed | 4 | Run a rebuild over `raw_events`, take its savepoint, start the streaming jobs from it. | Nothing that `raw_events` holds. |

Example. A release of customer decision changes a state type, and the new build cannot read the savepoint. The restore test in CI fails on the pull request, so the release does not ship. Had it shipped, the operator would restore the savepoint taken before the deploy with the old build.

## Algorithm

### Rebuild from raw events

1. Stop the streaming jobs, taking a savepoint of each if they can still take one.
2. Run each job with state in batch over `raw_events`, from the oldest record the rebuild needs to the newest committed record, in the order the pipeline reads them: event parse, then customer decision, then the state machine with the outbox.
3. Write nothing to Postgres, Kafka, or a sender during the rebuild. The rebuild produces state only.
4. Take a savepoint of each job at the end.
5. Start each streaming job from its rebuilt savepoint, with its Kafka offsets set to the positions after the newest record the rebuild read.

Where layers disagree, the higher layer wins. A rebuild replaces both the state and, at the jobs' next writes, the projection.

## Functional requirements

| Id | Requirement |
|---|---|
| REC-FR-01 | Every job with state must write its checkpoints to object storage, and must retain them when the job is cancelled. |
| REC-FR-02 | Every job with state must take a savepoint at least once a day, on a schedule. |
| REC-FR-03 | Every deploy of a job with state must take a savepoint before it stops the running job. A failed savepoint must stop the deploy. |
| REC-FR-04 | Savepoints must be kept for N days in storage that keeps earlier versions of every object, so that a deleted or overwritten savepoint can be restored. N is an [open question](#open-questions). |
| REC-FR-05 | Every stateful operator, and every source and sink, of every job with state must have a fixed operator id that does not change when the job graph changes. |
| REC-FR-06 | CI must run a restore test for every job with state on every change to the jobs' code: the new build must restore a savepoint that the running build wrote, run, and complete a checkpoint. |
| REC-FR-07 | A job that has no state for a key must read the projection, where one exists for that state, and merge its own state over it, as [decision 0005](../decisions/0005-keep-live-state-in-flink.md) says. |
| REC-FR-08 | A rebuild must produce, for every key, the state that the streaming jobs would hold after reading the same records. |
| REC-FR-09 | A rebuild must write nothing to Postgres, Kafka, or a sender, and must end with a savepoint of each job. |
| REC-FR-10 | When two layers disagree, the higher one in the trust order must win: raw events, then Flink state, then the projection. |
| REC-FR-11 | The versioned storage of savepoints must not keep earlier versions of imported files longer than DIM-NFR-08 allows. |

## Non-functional requirements

| Id | Requirement |
|---|---|
| REC-NFR-01 | Layer 1 loses no change the sources can replay. |
| REC-NFR-02 | Layer 3 loses at most one coalescing window of metric changes per person ([PRW-NFR-07](profile-writer.md#non-functional-requirements)), and all journey progress. |
| REC-NFR-03 | Layer 4 is exact for every record `raw_events` holds. |
| REC-NFR-04 | Savepoint age at any time is under 26 hours for every job with state: the daily schedule plus 2 hours of slack. This is the lead's default, pending owner review. |
| REC-NFR-05 | The duration of a rebuild is measured and recorded. No bound is set until the first rebuild runs. |

## Interfaces

| Direction | Interface | Contract |
|---|---|---|
| Write and read | Object storage, checkpoints | Per job, retained on cancel |
| Write and read | Object storage, savepoints | Per job, versioned, kept N days |
| Read | `user_metrics`, `identity_graph` | The projection, on a state miss. See [the data model](../data-model.md). |
| Read | Lakehouse `raw_events` | For a rebuild. See [the lakehouse sink](lakehouse.md#interfaces). |

[Configuration](../../operations/configuration.md) will name the schedule, the retention, and the storage paths.

## Failure handling

| Case | Behavior |
|---|---|
| A scheduled savepoint fails | Alert. The job keeps running. The next schedule tries again. Savepoint age passes REC-NFR-04 and alerts again. |
| A deploy's savepoint fails | The deploy stops, and the running job keeps running (REC-FR-03). |
| A restore test fails in CI | The change does not merge until the build restores the savepoint, or a decision accepts the state loss. |
| A savepoint is restored past the CDC restore window | The job skips CDC changes up to its slot's position, as JEX-NFR-10 says. Apply campaign edits again after the restore. |
| The projection is behind | A miss reads values up to one coalescing window old (REC-NFR-02). |
| `raw_events` has a gap, such as an outage longer than Kafka's retention | A rebuild over the gap is not exact. It reports the gap by offset. |

## Acceptance criteria

- Given a job cancelled without a savepoint, then its latest checkpoint is still in object storage, and the job starts from it. (REC-FR-01)
- Given a job running for 48 hours, then at least two scheduled savepoints of it exist, and the newest is under 26 hours old. (REC-FR-02, REC-NFR-04)
- Given a deploy whose savepoint fails, then the running job keeps running and the new version does not start. (REC-FR-03)
- Given a savepoint deleted by hand, then an earlier version of it can be restored from storage within N days. (REC-FR-04)
- Given a change that adds an operator to a job graph, then the new build restores the previous build's savepoint with no state left unmatched. (REC-FR-05, REC-FR-06)
- Given a pull request that changes a state type of any job with state, then CI fails it unless the new build restores the running build's savepoint. (REC-FR-06)
- Given customer decision started without state, when an event for a person with a `user_metrics` row arrives, then the job's series start from that row. (REC-FR-07)
- Given one day of `raw_events` and a rebuild over it, then each job's state for a sample of keys equals the state of the streaming job that read the same records. (REC-FR-08)
- Given a rebuild, then no row in Postgres, no Kafka record, and no notification request was written during it, and each job has a new savepoint. (REC-FR-09)
- Given a rebuilt state and a projection row that differ, then after the job's next write the projection equals the rebuilt state. (REC-FR-10)
- Given an imported file rewritten for a deletion, then one day later no earlier version of it exists, while savepoints keep theirs. (REC-FR-11)

## Open questions

- **Savepoint retention.** N, the days a savepoint is kept (REC-FR-04).
- **Rebuild with processing-time logic.** Watch timers fire on wall-clock time ([journey execution](journey-execution.md#watch-timers)). A rebuild runs over months of events in hours. Whether the rebuild fires a timer at its deadline in event time, and how it treats a deadline that passed while the person had no event, is undecided.
- **Rebuild and the outbox.** The rebuild sends nothing (REC-FR-09). Whether the outbox's and the timer flow's state need a rebuild at all, or start empty after one, is undecided.
- **The lead's default.** The 2 hours of slack in REC-NFR-04 waits for owner review.
- **The deploy savepoint's age.** A deploy takes a fresh savepoint (REC-FR-03). Whether a deploy must refuse to roll when the job's last completed checkpoint is old is undecided.

## Related

- [0054. Recover Flink state in four layers](../decisions/0054-recover-flink-state-in-four-layers.md)
- [0005. Keep live state in Flink and a durable copy in Postgres](../decisions/0005-keep-live-state-in-flink.md)
- [0039. Shorten the CDC restore window](../decisions/0039-shorten-the-cdc-restore-window.md)
- [Lakehouse sink](lakehouse.md)
- [Profile writer](profile-writer.md)
- [Journey execution](journey-execution.md)
- [Known issues](../../known-issues/components/state-recovery.md)
