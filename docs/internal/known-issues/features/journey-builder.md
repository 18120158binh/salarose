---
title: Journey builder known issues
contract: ../../features/journey-builder.md
updated: 2026-11-08
verified_at: 0db371f8
---

# Journey builder known issues

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| JBD-KI-27 | Wrong result | No segment entry or business event triggers, no segment conditions, and the condition split is still a segment node | JBD-FR-05, JBD-FR-15, JBD-FR-16, JBD-FR-17 |
| JBD-KI-28 | Wrong result | A second save gives an implicit End node a goal that the first save left out | JBD-FR-02 |
| JBD-KI-29 | Wrong result | The builder still offers Zalo as a message channel | JBD-FR-01 |
| JBD-KI-30 | Wrong result | Deleting any step deletes everything below it | JBD-FR-07, JBD-FR-42 |
| JBD-KI-33 | Missing | The checklist does not warn about a zero-count condition | JBD-FR-44 |
| JBD-KI-34 | Missing | A published journey's page has no Journey tab | JBD-FR-09 |
| JBD-KI-35 | Missing | The v2 journey list offers no move for drafts kept in this browser | JBD-FR-28 |

## JBD-KI-27. No segment entry or business event triggers, no segment conditions, and the condition split is still a segment node

- **Symptom.** The setup node's trigger list offers `price_drop` and `back_in_stock` as if a person did them, with no audience, so a campaign on them never starts for anyone. A setup node cannot start on a segment entry, and no node can test segment membership. The palette still calls the condition split a segment, and saves `node_type` `segment`.
- **Cause.** `NodeEditor.tsx` in `studio/app/campaign/components/` hardcodes the two business events, with their fields, next to the catalog events (from line 106). `studio/src/entities/journey/model/utils.ts` still names the node type `segment` (line 126). The contract changed on 2026-10-21 to trigger kinds, audiences, and `segment_membership` ([decision 0031](../../architecture/decisions/0031-reusable-segments-with-entry-triggers.md), [decision 0032](../../architecture/decisions/0032-fan-out-business-events-to-interested-people.md)). No segment exists to pick.
- **Evidence.** Read from the code.
- **Fix direction.** Build after [segments](../../features/segments.md) and the catalog's event kinds ([CAT-FR-16](../../features/event-catalog.md#functional-requirements)). Rename the node type in `studio`, `flattenCampaignTree`, `CampaignNode.load`, and `TransitionEngine` in one commit, as `AGENTS.md` requires for a node type.
- **Fixed by.** [JBD-FR-31](../../features/journey-builder.md#functional-requirements) with [JBD-FR-15 and JBD-FR-17](../../features/journey-builder.md#runtime-registry) (studio v3, not built yet). The v2 builder offers no business-event trigger while customer decision does not read business-event matches, and offers segment membership and segment entry once customer decision evaluates them. The segment-entry and segment-condition parts of this issue go when those registry entries ship in the v2 builder. The business-event trigger and the condition-split `node_type` rename stay open. The v2 builder says "Condition split" from the start, and the stored `segment` type changes only in the cross-stack commit above. The classic builder keeps this issue until it is removed.

Tracked in #223.

## JBD-KI-28. A second save gives an implicit End node a goal that the first save left out

- **Symptom.** A node with no child is saved with an End node that has no `goalId`, so its node row has no `goal_id`. Loading that journey draws the End node, and the next save writes it with `goal_default`. Saving, loading, and saving again changes the tree and the End's `goal_id`, with no edit by the marketer.
- **Cause.** In `studio/src/entities/journey/model/utils.ts`, `graphToTree` returns `{ type: "end" }` with no goal for a node without outgoing connections (`getNextNodes`, line 233). The same function writes an End node that is on the canvas with `goalId: node.config.goalId || "goal_default"` (line 399).
- **Evidence.** Found by the fixture round-trip test of studio v3 issue V3-01. The parse test's `journey` tree has a leaf push, and it does not round-trip, so it is not in the fixture corpus.
- **Fix direction.** Give the implicit End node the same goal that a drawn End node gets, so the first save already writes `goal_default`. Then add that tree to the corpus in `studio/src/entities/journey/model/__fixtures__/journeys/`.

## JBD-KI-29. The builder still offers Zalo as a message channel

- **Symptom.** A message step can pick Zalo, though the owner decided on 2026-11-08 that studio offers no Zalo for now.
- **Cause.** `CHANNELS` in `shared/types/campaigns.ts` (line 5) lists `zalo`, and `src/features/journey-analytics/model/labels.ts` labels it (line 16). The contract dropped Zalo on 2026-11-08.
- **Evidence.** Read from the code.
- **Fix direction.** Leave `zalo` out of the channels the palette and the channel picker offer. Keep `ZALO` in `Channel.java` and the analytics label, so journeys saved with Zalo still load, run, and show their counts.

## JBD-KI-30. Deleting any step deletes everything below it

- **Symptom.** Deleting a Wait for time or a message step also deletes the steps after it, instead of moving them up.
- **Cause.** `deleteNode` in `studio/src/entities/journey/model/graphEdits.ts` (line 156) calls `withoutSubtree` for every node type. The contract took the v3 rule on 2026-11-08.
- **Evidence.** Read from the code.
- **Fix direction.** For a one-path node, reattach its children to its parent with the node's incoming edge kind, then drop the node. Keep `withoutSubtree` and the dialog for branching nodes.

## JBD-KI-33. The checklist does not warn about a zero-count condition

- **Symptom.** A Check that tests "did an event 0 times in the last 30 days" publishes with no warning.
- **Cause.** The validator warns only about the `INACTION` measure (`problem(..., "which the runtime never matches")` in `studio/src/entities/journey/model/parseCampaign.ts`). It has no rule for a count of 0.
- **Evidence.** Read from the code.
- **Fix direction.** Add a warning rule for a behavior condition whose count must be 0, in the shared validator, so the browser and the server agree (JBD-FR-25).

## JBD-KI-34. A published journey's page has no Journey tab

- **Symptom.** `/v2/journeys/[id]` shows the analytics only. There is no Analytics | Journey tab pair and no read-only canvas with all-time Completed counts that refresh every 5 seconds.
- **Cause.** `studio/app/v2/journeys/[id]/page.tsx` renders `JourneyAnalytics` alone. The read-only canvas needs the builder's node cards in `studio/src/features/journey-builder/`, which shipped after the page.
- **Evidence.** Read from the code.
- **Fix direction.** Add the tabs, and render the builder canvas read-only with counts from `campaign_node_stats`, polled as JBD-FR-09 says.

## JBD-KI-35. The v2 journey list offers no move for drafts kept in this browser

- **Symptom.** The list shows the classic builder's browser drafts as rows that open the classic builder, and no banner offers **Move drafts**.
- **Cause.** No server action moves browser drafts into `journey_drafts`. `JourneyList.tsx` in `studio/src/features/journey-analytics/ui/` reads them with `loadDrafts` and links each to `/campaign/<id>`.
- **Evidence.** Read from the code.
- **Fix direction.** Build the move of [Moving browser drafts to the server](../../features/journey-builder.md#moving-browser-drafts-to-the-server), show the banner, and drop the browser rows and their classic links.
