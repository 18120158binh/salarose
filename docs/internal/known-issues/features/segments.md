---
title: Segments known issues
contract: ../../features/segments.md
updated: 2026-11-14
verified_at: b2d1f2d6
---

# Segments known issues

The `segments` table and the `/segments` page are built. No campaign can use a segment yet, because the journey builder offers no segment trigger, audience, or condition ([JBD-KI-27](journey-builder.md#jbd-ki-27-no-segment-entry-or-business-event-triggers-no-segment-conditions-and-the-condition-split-is-still-a-segment-node)), and the decision job keeps no membership flags yet ([DEC-KI-41](../components/customer-decision.md#dec-ki-41-no-membership-flags-no-business-event-matches-and-no-entry-id)). The decision job reads `segments` through CDC, so a saved change reaches it without a restart and applies to the next `segment_membership` condition it evaluates (SEG-FR-05, SEG-NFR-01).

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| SEG-KI-02 | Minor | The segment editor's condition rows are its own, not the journey builder's | SEG-FR-11 |

## SEG-KI-02. The segment editor's condition rows are its own, not the journey builder's

- **Symptom.** Both segment editors, the classic dialog and the v2 page at `/v2/segments/new` and `/v2/segments/[id]`, build profile and behavior rows of their own. They offer **+ filter** on a behavior condition, so the marketer can count only events such as "`add_to_cart` where `product.price` > 500000", but the rows look and read unlike the journey builder's. A stored condition whose filters put an OR inside a group keeps them, and the row shows a note instead of the filters, because the segment rows edit only filters that must all pass.
- **Cause.** `SegmentEditorDialog.tsx` (classic) and `SegmentEditor.tsx` (v2) in `studio/src/features/segments/ui/` keep their own rows, and share `EventFilters.tsx` for the filters. The v2 rows follow the SegmentEditor board: plain-word measures with the system name beside, and chip-style rows. The journey builder's `BehaviorConditionRow.tsx` in `studio/app/campaign/components/node-editors/` has no filter editor yet.
- **Evidence.** Read from the code.
- **Fix direction.** Build the segment rows and the journey builder's behavior row on one condition editor, with `EventFilters.tsx` as its filter part. The same shared editor is where segments gain imported fields and the relative-date operators (SEG-FR-40).
