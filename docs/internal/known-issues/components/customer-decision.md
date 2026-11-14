---
title: Customer decision known issues
contract: ../../architecture/components/customer-decision.md
updated: 2026-11-08
verified_at: f971ed5a
---

# Customer decision known issues

Java paths are relative to `event-processor/src/main/java/com/cdp/platform/`.

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| DEC-KI-41 | Wrong result | No membership flags, no business-event matches, and no entry id | DEC-FR-31, DEC-FR-32, DEC-FR-33, DEC-FR-34 |
| DEC-KI-44 | Wrong result | Rules cannot reach an entity key that contains dots | DEC-FR-08, CAT-FR-15 |

## DEC-KI-41. No membership flags, no business-event matches, and no entry id

- **Symptom.** No campaign can start on a segment entry or a business event. A `segment_membership` condition works (DEC-FR-30, DEC-FR-36), but the job keeps no membership flag and publishes no membership change. Setup triggers carry no entry id, so journey execution cannot tell one price drop from the next.
- **Cause.** The contract changed on 2026-10-21 ([decision 0031](../../architecture/decisions/0031-reusable-segments-with-entry-triggers.md), [decision 0032](../../architecture/decisions/0032-fan-out-business-events-to-interested-people.md), [decision 0033](../../architecture/decisions/0033-a-journey-instance-is-one-entry.md)). `CustomerDecisionJob` reads `segments` through CDC and answers `segment_membership` conditions from the segment's current row, but it keeps no flag per person and segment, reads no `business-event-matches` topic, and writes no `segment-membership-changes`. `RuleDecision` in `jobs/customerdecision/transforms/` builds setup triggers with no `entry_id`, although `VersionedTrigger` in `shared/models/` carries one.
- **Evidence.** Read from the code.
- **Fix direction.** Evaluate membership and matches in the keyed operator that makes every rule decision, as [decision 0030](../../architecture/decisions/0030-make-every-rule-decision-in-one-keyed-operator.md) describes.

- **Fixed by.** For the segment half, [DEC-FR-31, DEC-FR-32, and DEC-FR-34](../../architecture/components/customer-decision.md#functional-requirements), as the segment runtime builds them (studio v3, not built yet). It evaluates every segment at each event ([decision 0038](../../architecture/decisions/0038-store-segment-membership-and-evaluate-every-segment.md)). Business-event matches (DEC-FR-33), and the entry id of a `business_event` setup trigger, remain in this entry after the segment half lands.

Tracked in #220.

## DEC-KI-44. Rules cannot reach an entity key that contains dots

- **Symptom.** Event ingestion puts each entity attached to an event in `event_json` under its schema vendor and name, such as `com.acme/product` (ING-FR-18). A filter, a metric definition, or a catalog attribute that names `com.acme/product.sku` never finds the value, so a condition on it never passes (DEC-FR-08), and a schema gate cannot check it (CAT-FR-15). The [condition language](../../architecture/components/customer-decision.md#condition-language) promises "a dotted path into `event_json`", and the path has no way to say that a dot belongs to a key.
- **Cause.** Every path parser splits on each `.`, so `com.acme/product.sku` becomes `com`, `acme/product`, and `sku`. In Java: `JsonAttributeResolver.node` in `shared/utils/JsonAttributeResolver.java` (line 47), which `Event.propertyValue` uses for event conditions, metric filters, and `agg_field`, and `CatalogAttribute.normalize` in `shared/models/db/CatalogAttribute.java` (line 61), which feeds the schema gate. In TypeScript: `parseEventAttributePath` in `shared/lib/eventCatalog.ts` (line 66), and `isAtOrUnder` and the rename query in `shared/lib/db.ts`. `JsonAttributeResolver.node` tries the whole path as one key first, so `com.acme/product` alone resolves, but nothing below it does.
- **Evidence.** Read from the code at `7768d24c`. Not reproduced at runtime.
- **Fix direction.** The owner decides how rules address event fields: a path syntax that can quote a key, or replacing path-based field access altogether. A path syntax proposal lists every place that parses or builds a path, three syntax options, and the files each touches.
