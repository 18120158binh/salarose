---
title: Classify event field changes as Safe, Asks first, or Breaking
id: "0044"
status: accepted
date: 2026-11-08
tags: [studio, catalog, schema, data-quality]
supersedes: []
superseded_by: []
---

# 0044. Classify event field changes as Safe, Asks first, or Breaking

## Context

An event's fields in the catalog are a contract with two sides. Trackers send the fields, and with the schema gate on, ingestion drops each event that does not match them ([decision 0014](0014-gate-events-on-their-catalog-schema-at-ingestion.md)). Metric definitions and published journeys read the fields by path.

Before this decision the catalog guarded only two changes. A rename or a delete of a field in use was refused (CAT-FR-11, CAT-FR-12). Every other change saved at once. An admin could change `product.price` from number to text while a journey compared it to 1,000,000, or make a field required while the gate was on, and nothing warned that trackers would start losing events. The redesign also lets a field get sub-fields with **+ Add field inside**, which turns a field with a value into a group and changes its type.

The owner decided on 2026-11-08 that field changes follow three rules, Safe, Asks first, and Breaking, that a breaking change is refused while the field is in use, and that the refusal offers a safe path in three steps.

## Decision

Every field change is one of three kinds, and the studio shows the kind before the admin saves:

| Kind | Changes | Rule |
|---|---|---|
| Safe | The label, the example, the default value, a new optional field, and Must be sent to optional | Saves at once. No tracker or reader can break. |
| Asks first | Optional to Must be sent, and turning the schema gate on | Saves after a confirmation that names the senders and says which events would be dropped. Readers do not break, but trackers can start losing events. |
| Breaking | Renaming or moving a field, deleting it, changing its type, and turning it into a group | Refused while the field or a descendant is in use. Otherwise saves after a confirmation. |

A use is what CAT-FR-11 defines: a metric definition of the same event that reads the field, or a node of a published campaign that reads it. The check and the change run in one transaction, as before.

A refusal changes nothing, names each use, and offers the safe way:

1. Add the new field next to the old one.
2. Update the journeys and metrics that use the old one. A live journey is duplicated, pointed at the new field, and swapped.
3. Remove the old field once nothing uses it.

Adding a field inside a field that is not a group turns it into a group. That is a type change, so it is Breaking, and the form warns before it saves.

## Why

A field change can hurt two parties, and each kind names who is at risk. A Safe change hurts nobody. An Asks first change cannot break a reader, but it can make ingestion drop events a tracker already sends, so the admin must see that before saving. A Breaking change can make a metric or a journey read a missing or mistyped value, which the owner wants out (decision 0014's reason for the gate), so it waits until nothing reads the field.

The safe way is the expand-and-contract pattern: add the new shape beside the old one, move every reader, then remove the old shape. It never leaves a reader pointing at a field that is gone. Tracking plans in other products work the same way. Snowplow treats a schema change that breaks old events as a new major version, so old and new versions live side by side ([Snowplow schema versioning](https://docs.snowplow.io/docs/fundamentals/schemas/versioning/)).

Type change and turning a field into a group join rename and delete under one rule, because to a reader they are the same failure: the path it reads no longer holds the value it expects.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Keep guarding only rename and delete | A type change in use breaks a journey the same way, with no warning. |
| Refuse every breaking change, in use or not | An unused field has no reader to break. Refusing it would force the three steps for nothing. |
| Let a breaking change through and rewrite the uses | Rewriting a published journey's condition changes what a live journey does without its owner. Campaign management requires a duplicate to change a live journey. |
| A "Being replaced" state for an old field during the safe way | Adds a field state the gate and the builder would have to honor. The owner decided on 2026-11-08 to leave it out for now. |

## Consequences

- The catalog's server action must classify each change and run the use check for every Breaking change, not only for a rename or a delete. [CAT-KI-02](../../known-issues/features/event-catalog.md) tracks the gap.
- This record extends the field rules of CAT-FR-11 and CAT-FR-12. It supersedes no part of decision 0014 or decision 0017. It relies on decision 0017 for what a drop means: dropped events are kept 7 days in the dead-letter topic, which admins read in Monitoring > Dropped data. Decision 0014's consequence "Events dropped by the gate are lost" was already outdated by decision 0017.
- A confirmation can say how many events of the name arrived recently, from `event_volume`. It cannot say how many of them would fail the new rule, because `event_volume` counts names, not field values.
- Whether a segment counts as a use is open. The event detail page lists segments, but the refusal does not count them yet.

## Related

- [Event catalog](../../features/event-catalog.md)
- [Data health](../../features/data-health.md)
- [0014. Gate events on their catalog schema at ingestion](0014-gate-events-on-their-catalog-schema-at-ingestion.md)
- [0017. Keep dropped ingestion input in a dead-letter topic](0017-keep-dropped-ingestion-input-in-a-dead-letter-topic.md)
