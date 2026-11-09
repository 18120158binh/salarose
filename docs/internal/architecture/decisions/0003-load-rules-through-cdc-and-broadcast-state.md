---
title: Load rules through CDC and broadcast state
id: "0003"
status: accepted
date: 2026-06-03
tags: [flink, cdc, rules, consistency]
supersedes: []
superseded_by: []
---

# 0003. Load rules through CDC and broadcast state

## Context

Rules are the campaigns, the journey nodes with their conditions, and the metric definitions. Marketers change them in `studio`, which writes Postgres. The Flink jobs must see a change without a restart.

The first matcher loaded rules with a table function. Each parallel instance queried Postgres in `open()` and then polled on its own timer, from a `ScheduledExecutorService` inside the function.

## Decision

Read the rule tables through Postgres change data capture (CDC) and broadcast each change to every subtask with Flink broadcast state. Index the rules by the event name they react to, so that an event is checked only against rules for that name.

Today the jobs read `campaigns`, `campaign_nodes`, and `user_metric_definitions` this way.

## Why

A review of the polling matcher found five problems:

1. **Subtasks disagreed on the rule version.** Each JVM polled on its own schedule. Task manager A reloaded a changed node at time T1 and task manager B at T2. The stream was not keyed before evaluation, so one user's events could meet two versions of one campaign and break that user's journey.
2. **Every subtask hit Postgres at once on start.** Each instance queried in `open()`. A start or a recovery sent all of them to the database in the same millisecond.
3. **Threads leaked.** Flink did not manage the polling threads. After a partial failure, the threads survived.
4. **Credentials were in the code.** The JDBC URL, user, and password were hard-coded.
5. **Every event met every rule.** The matcher looped over all nodes for each event and built a new object for each, which loaded the CPU and the garbage collector.

CDC and broadcast state answer all five. Every subtask receives the same change from one stream. Broadcast state is part of each checkpoint, so recovery restores the rule set that matched the restored events. Flink owns the source's lifecycle. The source reads its connection settings from the environment. An index by event name makes the lookup per event close to constant.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Polling, with one poller and a broadcast | Fixes the version skew, but still polls a database that CDC already streams, and adds latency equal to the poll interval. |
| Query rules per event | One database round trip per event. |

## Consequences

- Each rule table needs a publication and a replication slot. [The data model](../data-model.md#publications-for-cdc) lists them.
- A slot that is dropped when its job stops makes the job read a full snapshot on start. For rule tables that rebuilds the rule set, which is correct. For a table of facts, such as transitions, snapshot rows look like new inserts. A consumer of such a table must deduplicate.
- Every task manager holds the whole rule set. Memory grows linearly with the number of nodes. Hundreds or a few thousand rules are cheap. Hundreds of thousands of complex nodes could exhaust task manager memory.
- Rule parsing happens once per change, at the edge. Code after the parser trusts the rule types.

## Related

- [Customer decision](../components/customer-decision.md)
- [Journey execution](../components/journey-execution.md)
