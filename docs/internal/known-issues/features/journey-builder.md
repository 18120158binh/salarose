---
title: Journey builder known issues
contract: ../../features/journey-builder.md
updated: 2026-11-17
verified_at: 49973e0
---

# Journey builder known issues

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| JBD-KI-27 | Wrong result | No segment entry or business event triggers, no segment conditions, and the condition split is still a segment node | JBD-FR-05, JBD-FR-15, JBD-FR-16, JBD-FR-17 |
| JBD-KI-35 | Missing | The v2 journey list offers no move for drafts kept in this browser | JBD-FR-28 |
| JBD-KI-36 | Departure | The Analytics tab's graph draws its own node cards, not the builder's | [Journey pages](../../features/journey-builder.md#journey-pages) |
| JBD-KI-37 | Risk | Journey analytics read the hot transitions table, not the lakehouse | JBD-NFR-03, JBD-NFR-04 |

## JBD-KI-27. No segment entry or business event triggers, no segment conditions, and the condition split is still a segment node

- **Symptom.** The setup node's trigger list offers `price_drop` and `back_in_stock` as if a person did them, with no audience, so a campaign on them never starts for anyone. A setup node cannot start on a segment entry, and no node can test segment membership. The palette still calls the condition split a segment, and saves `node_type` `segment`.
- **Cause.** `NodeEditor.tsx` in `studio/app/campaign/components/` hardcodes the two business events, with their fields, next to the catalog events (from line 106). `studio/src/entities/journey/model/utils.ts` still names the node type `segment` (line 126). The contract changed on 2026-10-21 to trigger kinds, audiences, and `segment_membership` ([decision 0031](../../architecture/decisions/0031-reusable-segments-with-entry-triggers.md), [decision 0032](../../architecture/decisions/0032-fan-out-business-events-to-interested-people.md)). No segment exists to pick.
- **Evidence.** Read from the code.
- **Fix direction.** Build after [segments](../../features/segments.md) and the catalog's event kinds ([CAT-FR-16](../../features/event-catalog.md#functional-requirements)). Rename the node type in `studio`, `flattenCampaignTree`, `CampaignNode.load`, and `TransitionEngine` in one commit, as `AGENTS.md` requires for a node type.
- **Fixed by.** [JBD-FR-31](../../features/journey-builder.md#functional-requirements) with [JBD-FR-15 and JBD-FR-17](../../features/journey-builder.md#runtime-registry) (studio v3, not built yet). The v2 builder offers no business-event trigger while customer decision does not read business-event matches, and offers segment membership and segment entry once customer decision evaluates them. The segment-entry and segment-condition parts of this issue go when those registry entries ship in the v2 builder. The business-event trigger and the condition-split `node_type` rename stay open. The v2 builder says "Condition split" from the start, and the stored `segment` type changes only in the cross-stack commit above. The classic builder keeps this issue until it is removed.

Tracked in #223.

## JBD-KI-35. The v2 journey list offers no move for drafts kept in this browser

- **Symptom.** The list shows the classic builder's browser drafts as rows that open the classic builder, and no banner offers **Move drafts**.
- **Cause.** No server action moves browser drafts into `journey_drafts`. `JourneyList.tsx` in `studio/src/features/journey-analytics/ui/` reads them with `loadDrafts` and links each to `/campaign/<id>`.
- **Evidence.** Read from the code.
- **Fix direction.** Build the move of [Moving browser drafts to the server](../../features/journey-builder.md#moving-browser-drafts-to-the-server), show the banner, and drop the browser rows and their classic links.

## JBD-KI-36. The Analytics tab's graph draws its own node cards, not the builder's

- **Symptom.** On `/v2/journeys/[id]`, the Journey tab draws the builder's cards, laid out as the builder lays them out. The Analytics tab's graph draws other cards, with the node label only and no step kind or icon, in a different layout.
- **Cause.** `JourneyGraph.tsx` in `studio/src/features/journey-analytics/ui/` renders its own `StepCard` from the `campaign_nodes` rows. The builder's card face, `StepCardFace` in `studio/src/features/journey-builder/ui/StepCard.tsx`, takes a builder node parsed from `campaigns.root`.
- **Evidence.** Read from the code.
- **Fix direction.** Draw the analytics graph with `StepCardFace` and the builder layout, mapping each analytics row to its builder node by `node_id`, as the Journey tab does.

## JBD-KI-37. Journey analytics read the hot transitions table, not the lakehouse

- **Symptom.** Every analytics view runs its node query against `user_campaign_state_transitions`, the table the state machine writes and the outbox reads. For a journey of 847,118 transitions it took 6.6 s on a cold cache (#66).
- **Cause.** `nodeAnalyticsQuery` in `studio/src/features/journey-analytics/model/queries.ts` reads `user_campaign_state_transitions` (lines 72 to 81). No transition history exists in a lakehouse to read instead.
- **Evidence.** Read from the code at `a29730c`. The time is from #66, measured on 2026-11-08.
- **Fix direction.** Read `transition_history` once the lakehouse sink lands and the owner sets the freshness bound. #66 tracks the latency on the current table.

Tracked in #105.
