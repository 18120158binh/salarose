---
title: Journey builder known issues
contract: ../../features/journey-builder.md
updated: 2026-11-14
verified_at: 49973e0
---

# Journey builder known issues

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| JBD-KI-27 | Wrong result | No segment entry or business event triggers, no segment conditions, and the condition split is still a segment node | JBD-FR-05, JBD-FR-15, JBD-FR-16, JBD-FR-17 |
| JBD-KI-34 | Missing | A published journey's page has no Journey tab | JBD-FR-09 |
| JBD-KI-35 | Missing | The v2 journey list offers no move for drafts kept in this browser | JBD-FR-28 |

## JBD-KI-27. No segment entry or business event triggers, no segment conditions, and the condition split is still a segment node

- **Symptom.** The setup node's trigger list offers `price_drop` and `back_in_stock` as if a person did them, with no audience, so a campaign on them never starts for anyone. A setup node cannot start on a segment entry, and no node can test segment membership. The palette still calls the condition split a segment, and saves `node_type` `segment`.
- **Cause.** `NodeEditor.tsx` in `studio/app/campaign/components/` hardcodes the two business events, with their fields, next to the catalog events (from line 106). `studio/src/entities/journey/model/utils.ts` still names the node type `segment` (line 126). The contract changed on 2026-10-21 to trigger kinds, audiences, and `segment_membership` ([decision 0031](../../architecture/decisions/0031-reusable-segments-with-entry-triggers.md), [decision 0032](../../architecture/decisions/0032-fan-out-business-events-to-interested-people.md)). No segment exists to pick.
- **Evidence.** Read from the code.
- **Fix direction.** Build after [segments](../../features/segments.md) and the catalog's event kinds ([CAT-FR-16](../../features/event-catalog.md#functional-requirements)). Rename the node type in `studio`, `flattenCampaignTree`, `CampaignNode.load`, and `TransitionEngine` in one commit, as `AGENTS.md` requires for a node type.
- **Fixed by.** [JBD-FR-31](../../features/journey-builder.md#functional-requirements) with [JBD-FR-15 and JBD-FR-17](../../features/journey-builder.md#runtime-registry) (studio v3, not built yet). The v2 builder offers no business-event trigger while customer decision does not read business-event matches, and offers segment membership and segment entry once customer decision evaluates them. The segment-entry and segment-condition parts of this issue go when those registry entries ship in the v2 builder. The business-event trigger and the condition-split `node_type` rename stay open. The v2 builder says "Condition split" from the start, and the stored `segment` type changes only in the cross-stack commit above. The classic builder keeps this issue until it is removed.

Tracked in #223.

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
