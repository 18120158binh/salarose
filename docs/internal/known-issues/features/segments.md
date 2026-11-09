---
title: Segments known issues
contract: ../../features/segments.md
updated: 2026-11-08
verified_at: b2d1f2d6
---

# Segments known issues

The `segments` table and the `/segments` page are built. No campaign can use a segment yet, because the journey builder offers no segment trigger, audience, or condition ([JBD-KI-27](journey-builder.md#jbd-ki-27-no-segment-entry-or-business-event-triggers-no-segment-conditions-and-the-condition-split-is-still-a-segment-node)), and the decision job keeps no membership flags yet ([DEC-KI-41](../components/customer-decision.md#dec-ki-41-no-membership-flags-no-business-event-matches-and-no-entry-id)). The decision job reads `segments` through CDC, so a saved change reaches it without a restart and applies to the next `segment_membership` condition it evaluates (SEG-FR-05, SEG-NFR-01).

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| SEG-KI-01 | Minor | The segment editor is its own, and cannot add event filters to a behavior condition | SEG-FR-03 |

## SEG-KI-01. The segment editor is its own, and cannot add event filters to a behavior condition

- **Symptom.** The classic segment dialog and the studio v2 editor at `/v2/segments/new` and `/v2/segments/[id]` build groups of profile and behavior conditions with their own rows, not the journey builder's condition editor. Neither offers filters on a behavior condition's event, such as "`add_to_cart` where `product.price` > 500000". Hiding **+ filter** is right while customer decision does not apply event filters to segments (SEG-FR-11), but a shared editor would bring it when it does. A stored condition keeps the filters it has, and both editors say so.
- **Cause.** `SegmentEditorDialog.tsx` (classic) and `SegmentEditor.tsx` (v2) in `studio/src/features/segments/ui/` each have their own condition rows. The v2 rows follow the SegmentEditor board: plain-word measures with the system name beside, and chip-style rows. The v2 journey builder's condition editor is not on the deploy branch yet. The server accepts filters (`parseSegmentConditions` in `shared/lib/segments.ts`).
- **Evidence.** Read from the code.
- **Fix direction.** The journey builder now edits the same group shape with `ConditionGroupsEditor.tsx` and `BehaviorConditionRow.tsx` in `studio/app/campaign/components/`. Build the dialog's conditions on them, which brings event filters with them. The same shared editor is where segments gain imported fields and the relative-date operators (SEG-FR-40), so the fix is also the base for that work.
- **Fixed by.** [SEG-FR-11](../../features/segments.md#functional-requirements) (studio v3, not built yet). The segment editor becomes a page on the shared condition editor, and its **+ filter** appears once customer decision applies event filters to a segment's behavior conditions.
