---
title: Version each published graph and drop triggers decided against an older one
id: "0022"
status: proposed
date: 2026-10-19
tags: [flink, cdc, journeys, state-machine, kafka]
supersedes: []
superseded_by: []
---

# 0022. Version each published graph and drop triggers decided against an older one

## Context

A trigger names its node by campaign id and node id only. Customer decision and the state machine read `campaign_nodes` through separate CDC slots, and the timer flow fires watch timeouts minutes or days after the transition that started them. So a trigger can reach the state machine after the graph it was decided against was replaced.

[Decision 0013](0013-apply-a-campaign-save-as-one-change.md) takes a campaign's graph down at the first delete row of a save. Since then, that delete row drops every buffered trigger for a node of the graph it takes down. Two cases were left, recorded as JEX-KI-33:

- A trigger decided against a deleted graph that reaches the state machine after the delete row, such as the timeout of a watch started before it, waits for the graph. If the campaign is published again under the same ids within the graph-load allowance, the trigger completes the new node.
- Customer decision can apply a publish before the state machine reads its first delete row. A trigger decided against the new graph that waits for its parent is then dropped by that delete row.

A resume also rewrites the node rows: Studio deletes them and inserts the stored journey again.

## Decision

Each publish writes its graph at a version, `campaign_nodes.graph_version`, the next value of the sequence `campaign_graph_version_seq`. A resume writes the stored journey again at the version of the rows it replaces.

Customer decision copies the version of the rule into each trigger. The state machine keeps the highest version among a graph's rows, and lists it with each watch child in the transition row. The timer flow copies it into the timeout. The trigger topic carries it as `graph_version`, from trigger schema version 4.

The state machine compares the trigger's version with the live graph's:

- An older version: the trigger is dropped as unreachable.
- A newer version: the trigger waits for its graph, as a trigger whose graph has not arrived does, for at most the graph-load allowance.
- No version: the trigger applies against the live graph, as before. Producers wrote no version before this change, and a restored buffer holds triggers without one.

A delete row no longer drops a buffered trigger that has a version. The next graph decides: it drops the trigger if it is newer, and applies it if it has the trigger's version.

## Why

The version tells the state machine which graph a trigger was decided against, which nothing else in the trigger does. Both cases need that fact. A delete row cannot tell an old trigger from one decided against the publish that follows the delete. A graph that arrives later cannot tell a trigger decided against it from one decided against the graph it replaced.

Workflow engines tie each running instance to one version of its definition for the same reason. Temporal versions workflow code, and Camunda keeps a process instance on its definition version until an explicit migration ([decision 0013](0013-apply-a-campaign-save-as-one-change.md) cites both). Here a version per publish is enough, because a published campaign is read-only in Studio, so a publish replaces the whole graph.

A sequence gives a version above every earlier one, also after the campaign is deleted, which a counter in `campaigns` would not, since the row goes with the campaign. Studio takes the value after it locks the campaign row, so two publishes of one campaign take their versions in commit order.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Clear a campaign's journey state when the campaign is deleted | Fixes only the timeout case of a deleted campaign. A node deleted from a campaign that stays, and the early trigger that a delete row drops, are not covered. The state machine would also need to walk every journey of the campaign. |
| A version per node, kept only while the node's row does not change | Studio rewrites every row on each publish and resume, so it would need to compare each node with the stored one. One version per publish is the same for a read-only campaign. |
| A version taken from the CDC change, such as its commit time | A snapshot read has no commit time, so a fresh start of one job would compare different values from the other. |
| A new resume version | Every watch timeout and buffered trigger from before a pause would be dropped after the resume, so a person waiting at a watch would never take its timeout branch. |
| The version as a field of `JourneyTriggerEvent` | The state machine's old buffer holds that record through Kryo, and a restore fails once the record gains a field. The version is carried beside it, and the buffer moved to state typed with Flink's POJO serializer. |

## Consequences

- `campaign_nodes` has a new `NOT NULL` column. Every writer of node rows must set it: the next sequence value for a new graph, the current value to write the same graph again.
- A trigger in flight across a publish is dropped, and the person moves on at the next qualifying trigger. This covers customer decision lagging behind the state machine during a publish, and the timeouts of watches started before it.
- The trigger message carries `graph_version`. The deploy order is in [the upgrade note](../../operations/deployment.md#trigger-graph-versions).
- A person's completed nodes are not tied to a version. A campaign published again under the same id is the same journey instance, so a node the person completed before does not complete again (JEX-FR-01).

## Related

- [Journey execution](../components/journey-execution.md)
- [Customer decision](../components/customer-decision.md)
- [0003. Load rules through CDC and broadcast state](0003-load-rules-through-cdc-and-broadcast-state.md)
- [0013. Apply a campaign save as one change](0013-apply-a-campaign-save-as-one-change.md)
