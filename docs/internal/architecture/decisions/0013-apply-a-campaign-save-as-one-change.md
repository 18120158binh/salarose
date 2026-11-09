---
title: Apply a campaign save as one change
id: "0013"
status: proposed
date: 2026-10-18
tags: [flink, cdc, journeys, state-machine]
supersedes: []
superseded_by: []
---

# 0013. Apply a campaign save as one change

## Context

[Decision 0003](0003-load-rules-through-cdc-and-broadcast-state.md) loads the campaign graph through CDC on `campaign_nodes`. Studio saves a campaign by deleting every node row and inserting each one again, in one transaction. CDC still delivers each row as its own change, and the state machine applied each row as it arrived. On a fresh start, the snapshot delivers the rows in table order.

A trigger could therefore apply while the state machine held only part of a save. A node that completed then did not see the rows of its children that came later. Its `engagement` and `end` children never completed, and its watch children got no timer. This was known issue JEX-KI-18, GitHub issue #92. Triggers that wait for their graph, under [the graph-load allowance](../components/journey-execution.md#release-the-buffer), made it likely. Each one applied as soon as its own node arrived, before the rows below it.

Two answers were open. The engine could apply a save as one change. Or it could start a child whose row arrives under a parent that already completed.

## Decision

The state machine applies a campaign save as one change.

- Each `campaign_nodes` row carries `campaign_node_count`, the number of nodes in the save that wrote it. Studio writes it.
- A deleted row takes the campaign's graph down. A save deletes every row before it inserts any, so the graph is down from the first delete of a save until the save is complete. A trigger that arrives in between waits for the graph, as a trigger that beats its graph already does.
- Inserted rows collect in a load. The graph goes live when the load holds `campaign_node_count` rows. A row that is not loaded, such as a watch with an invalid limit, still counts.
- An updated row changes one whole node, so it applies to the live graph at once. While the graph is down, it joins the load. The before image of an update is ignored.

A node that a later save adds under a parent that a journey instance already completed does not start for that instance.

## Why

Established engines run an in-flight instance against one whole version of its definition, and do not run a step added behind it:

- Temporal replays a running workflow against the code it started with. A change applies to new executions through versioning or a patch, which leaves running ones on the old path ([Temporal versioning](https://docs.temporal.io/develop/java/workflows/versioning)).
- Camunda keeps a running process instance on its definition version. It moves to a new version only by an explicit migration with a mapping plan ([Camunda process instance migration](https://docs.camunda.io/docs/components/operate/userguide/process-instance-migration/)).
- Braze lets users still in a live Canvas receive a step added ahead of them. Users who already passed the point where it was added receive it only if the Canvas allows re-entry ([Braze, editing Canvases after launch](https://www.braze.com/docs/user_guide/engagement_tools/canvas/create_a_canvas/change_your_canvas_after_launch/)).
- Debezium's transaction metadata ends each transaction with an event count, so that a consumer can buffer the changes until all of them have arrived ([Debezium 1.1 transaction metadata](https://debezium.io/blog/2020/02/11/debezium-1-1-beta1-released/), [Decodable, aggregating CDC events by transaction](https://www.decodable.co/blog/aggregating-change-data-capture-events-based-on-transactional-boundaries)). `campaign_node_count` is the same count, written by the one writer that knows it.

The other answer, starting a child that arrives under a completed parent, cannot tell a row that is still loading from a step a marketer added later. Without that, it would send a new engagement to everyone who passed the parent in the last 90 days, which the engines above avoid. A time window would bound that, but it guesses. It would also not fix watch children. Their timers start from the parent's transition row, which the sink never rewrites, so a parent that already completed cannot list a watch that arrived later.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Start a child whose row arrives under a completed parent | Cannot tell a loading row from a new step. Starts new steps for people who passed the parent long ago. Cannot give a late watch a timer, because transitions are written once. Each node row would also walk every journey with a completed node, not only the ones with buffered triggers. |
| One CDC row per campaign, such as `campaigns.root` | The engine would parse the tree and build node rows itself, a second copy of Studio's flattening and of the branch contract. It also needs a new CDC source and slot. |
| A version row in `campaigns`, written after the nodes | Ordering between two tables needs one CDC source for both, so one slot and publication. The Table API source reads one table each. |
| Debezium transaction metadata | The Flink Postgres CDC table source does not expose it, and an END marker can wait for the next transaction. |
| A short processing-time quiet period per campaign | The broadcast side of the operator has no timers, and a quiet period guesses how long a save takes. |

## Consequences

- `campaign_nodes` has a new `NOT NULL` column. Every writer of node rows must set it to the number of rows in its save. Studio is the only writer.
- A delete outside a save takes the campaign's graph down until the next save. Change node rows only through Studio. To roll back to an older savepoint, save each campaign edited since then again. A save now replaces the whole graph, so a node deleted in the window leaves the restored graph too.
- A save holds its campaign's triggers for the time its rows take to arrive. They wait as triggers that beat their graph do, so a save longer than the graph-load allowance drops them.
- The state machine keeps the load of each campaign in a second broadcast state, `campaign-graph-loads`. A load lives only while a save arrives, so it adds little memory.
- Buffered triggers are retried once per save, not once per row.
- Customer decision still reads node rows one at a time, without the count. This record does not change it.

## Related

- [Journey execution](../components/journey-execution.md)
- [Campaign management](../../features/campaign-management.md)
- [0003. Load rules through CDC and broadcast state](0003-load-rules-through-cdc-and-broadcast-state.md)
- [0005. Keep live state in Flink](0005-keep-live-state-in-flink.md)
