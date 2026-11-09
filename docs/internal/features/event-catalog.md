---
title: Event catalog
slug: event-catalog
purpose: Keep the list of tracked events and their typed attributes, so that marketers pick real events and fields when they build conditions.
status: accepted
implementation: partial
area: studio
tags: [ui, admin, events, schema]
created: 2026-10-14
updated: 2026-11-08
version: 2.0
known_issues: ../known-issues/features/event-catalog.md
---

# Event catalog

## Purpose

Marketers cannot guess event names or attribute paths. The event catalog lists every tracked event with its attributes and their types. Admins manage it in the studio at `/data/events` and `/data/events/[id]`, and on the classic page `/admin/events` until cutover. The [journey builder](journey-builder.md) fills its event pickers and attribute fields from it, and metric definitions name their event by its catalog id, `user_event_id`.

The owner approved the Salarose redesign of these pages on 2026-11-08. Its rules for changing a field, Safe, Asks first, and Breaking, are recorded in [decision 0044](../architecture/decisions/0044-classify-event-field-changes-as-safe-asks-first-or-breaking.md).

## Scope

In scope:

- Creating, listing, editing, hiding, and deleting events, and adding, changing, and deleting their attributes, sub-fields included.
- Inferring attributes from a sample payload.
- Turning an event's schema gate on or off, and marking attributes required. [Event ingestion](../architecture/components/event-ingestion.md) applies the gate.
- Showing where an event and each attribute are used.

Out of scope:

- Events whose name is not in the catalog. Ingestion accepts them unchecked.
- Attributes that an event sends and the catalog does not list. Ingestion accepts them.
- Per-event volume, last-seen time, and drop counts. [Data health](data-health.md) shows them from `event_volume` (DHL-FR-14).
- Archiving metric definitions. The Data > Metrics page owns that.

## Terms

The studio shows marketers a plainer word for some terms. The contract uses the term, and the table names the label.

| Term | Label in the studio | Meaning |
|---|---|---|
| Event | Event | A tracked action, with a system name such as `com.acme/add_to_cart`, a display name, a description, and a kind. |
| Kind | "Happens to one shopper" or "About a product" | `person` for an event a person does, sent with a person id. `business` for an event about an item, such as `com.acme/price_drop`, sent with no person. |
| Item key | Item key | The attribute path of a business event that names its item, such as `product.id`. |
| System name | Tracking name | The name that tracking sends as `event_name`. Lowercase, with underscores for spaces. The platform uses one form of name, `<vendor>/<name>`, such as `com.acme/add_to_cart`, in the catalog, in journey templates, in tracking, and in the [data ingestion API](data-ingestion-api.md). A tracker's self-describing event takes this name from its schema. An API sender sends it as `event_name`. It cannot change after the event is created. |
| Status | "Show in the journey builder" switch | `active` or `inactive`. A new event is active. The studio shows an inactive event as "Hidden from builder". Hiding an event is how an admin retires it. |
| Attribute | Field | A field of an event, with a key, a label, a type, an example value, and a default value. |
| Path | Field name | An attribute's dotted key from the root, such as `product.price`. |
| Type | Text, Number, Yes or no, Date and time, Group of fields | One of `string`, `number`, `boolean`, `datetime`, and `json`, in that order. A `json` attribute can have children, its sub-fields. |
| Required | Must be sent | An attribute that every event of its name must send with a value, whenever its parent object is present. Off by default. |
| Schema gate | Strict | A per-event switch, off by default. While it is on, ingestion drops each event of that name that does not match its attributes. The owner decided this on 2026-10-18. |
| Use | In use | A metric definition or a published campaign node that reads an attribute or names an event, as CAT-FR-11 defines it. |
| Dropped data | Dropped data | The records that ingestion drops, the gate's drops included. They are kept for 7 days and admins read them at Data > Monitoring > Dropped data, as [data health](data-health.md#dropped-data) says. |
| Field change | Field change | Any change to an attribute. Each is Safe, Asks first, or Breaking, by CAT-FR-11. |

## Behavior

Example. An admin adds `com.acme/add_to_cart` with attributes `product.id` (string), `product.price` (number), and `quantity` (number). A marketer can then build the condition `product.price > 500000` on a check node, and the editor offers numeric operators for it.

- **Create an event.** The admin enters a system name, a display name, and a description. The form lowercases the name, turns spaces into underscores, and shows the stored form as the admin types. The admin adds attributes in a tree editor, or pastes a sample JSON payload and the catalog infers each attribute's type from its value. The two modes stay in sync. A paste that is not JSON shows the line of the error and keeps the fields of the last valid sample. In the studio, **Add event** creates person events only, until customer decision reads business-event matches (CAT-FR-18). The classic page, until cutover, also offers the kind `business`, which then names its item key, one of its attributes. Every new attribute is optional, and the gate starts off. After a save, the event's detail page opens.
- **List events.** The list shows events of every status. [Data health](data-health.md#event-catalog-view) owns its columns, search, and paging.
- **Edit an event.** The admin can change its display name and description, and switch its status between active and inactive. The system name stays as it was created, because tracking sends it.
- **Hide an event.** An inactive event is hidden from the builder. The journey builder and the segment editor offer only active events. A campaign, segment, or metric definition that already uses a hidden event keeps working, and ingestion, the schema gate included, treats the event as before. Hiding is how an admin retires an event, and the page recommends it over deleting. The owner decided this on 2026-11-08.
- **Change a field.** Each field change is one of three kinds, and the edit form shows the kind before the admin saves (CAT-FR-11):

  | Kind | Changes | What happens |
  |---|---|---|
  | Safe | The label, the example, the default value, a new optional field, and Must be sent to optional | Saves at once. |
  | Asks first | Optional to Must be sent, and turning the schema gate on | Asks for confirmation, and says which events would be dropped. |
  | Breaking | Renaming or moving a field, deleting it, changing its type, and turning it into a group | Refused while the field or a descendant is in use. Otherwise asks for confirmation. |

  Renaming or moving a field rewrites the path of every descendant. Deleting a field deletes its subtree.
- **Refuse a breaking change.** The refusal changes nothing. It names each use, a metric definition or a campaign with its nodes, and offers the safe way in three steps: add the new field next to the old one, update the journeys and metrics that use the old one, and remove the old field once nothing uses it. A live journey is updated by duplicating it, as the [campaign management](campaign-management.md) contract allows. The owner decided this on 2026-11-08.
- **Add a field inside a field.** Every field row offers **+ Add field inside**, in the detail page and in the **Add event** dialog. A sub-field can also be inferred from a pasted sample of the parent. Adding inside a field that is not a group turns it into a group, of type `json`. That is a breaking change: the form warns first and says that events that send the old value type will no longer match, and are dropped while the gate is on. It is refused while the field is in use. The owner decided this on 2026-11-08.
- **Delete an event.** An event can be deleted only when it has no metric definition, archived ones included, and no other use. Otherwise the delete is refused. The refusal names its metric definitions and its other uses, says that metric definitions are kept for history and never deleted, and offers to hide the event. A delete that is allowed asks for confirmation and deletes the event and its attributes. The owner decided this on 2026-11-08.
- **Mark an attribute required.** Making an attribute Must be sent asks first. The confirmation names who sends the event, the website tracker, the app, and any API source with a key, and says that while the gate is on, every event that misses the attribute is dropped. Clearing Must be sent is safe and applies at once.
- **Turn the schema gate on or off.** Turning it on asks first. The confirmation names the required attributes, and says that ingestion then drops every event of that name that misses one or sends a value of the wrong type, that journeys, segments, and metrics never see a dropped event and the studio does not put it back, and that admins can read dropped events in Monitoring > Dropped data for 7 days. Turning it off applies at once. Both changes reach ingestion within seconds, and apply to the events it reads after that.

### Event detail page

`/data/events/[id]` shows one event. An admin opens it from a row of `/data/events`, or lands on it after **Add event** succeeds. It has these parts:

- **Header.** The display name, the system name, a kind badge, the creation date, a "Hidden from builder" badge when the event is inactive, and a Strict badge when the gate is on. An admin edits the display name and the description here. The page offers no kind change. An existing business event shows its kind and its item key read-only, to every viewer.
- **Fields.** A tree table with each attribute's path, label, type, Must be sent flag, example, and default value, and an "In use" badge with the number of uses. Row actions edit, add a field inside, change Must be sent, and delete. **Add field** adds one field at the top level, or infers fields from a pasted sample payload. Below the table, a sample event built from the examples.
- **Where it's used.** The campaigns that use the event, with their status, its metric definitions, archived ones marked, linking to Data > Metrics, and the segments that use it.
- **Strict checking.** The gate's switch, and an example of an event it accepts and one it drops.
- **Field change rules.** The three kinds of CAT-FR-11, each with its changes.
- **Show in the journey builder.** The status switch, which says that hiding stops nothing that already uses the event.
- **Retire or delete.** **Retire this event**, which hides it, and **Delete event**, which CAT-FR-08 governs.

An editor sees the same page read-only, with no switch, row action, or delete. A confirmation is a dialog of the page, never a native confirm.

Example of the schema gate. `com.acme/add_to_cart` has `product` (json, required), `product.price` (number, required), and `quantity` (number). With the gate on, `{"product": {"price": 12990000}}` passes, and so does `{"product": {"price": 12990000}, "quantity": null, "note": "x"}`. `{"product": {"price": "12990000"}}` and `{"quantity": 1}` are dropped. With the gate off, all four pass.

An event matches its attributes when both rules hold:

- Each listed attribute that has a value has the attribute's type: a JSON string for `string`, a JSON number for `number`, `true` or `false` for `boolean`, a JSON object or array for `json`, and for `datetime` a string with a date, a time, and an offset, as in RFC 3339, such as `2026-10-18T09:30:00+07:00` or `2026-10-18T02:30:00Z`. A null counts as no value.
- Each required attribute has a value, unless its parent object is absent or null. So an optional parent can be left out together with its required children.

An attribute whose stored type is not one of the five has no type rule. Only its Required flag applies.

## Functional requirements

| Id | Requirement |
|---|---|
| CAT-FR-01 | An admin must be able to create an event with a system name, display name, description, and attribute tree. |
| CAT-FR-02 | The system name must be stored lowercase with underscores for spaces, and must be unique. It has the form `<vendor>/<name>`, as in `com.acme/add_to_cart`, so it may contain `/` and `.`. |
| CAT-FR-21 | Every event in a workspace must use the workspace's one vendor prefix, such as `com.acme/`. **Add event** shows the prefix as fixed text, and the admin types only the name after it. The server adds the prefix, normalizes the rest by CAT-FR-02, and refuses a name that holds its own `/`. |
| CAT-FR-03 | Pasting a sample payload must infer one attribute per field, with its type from the value. Nested objects become `json` attributes with children. |
| CAT-FR-04 | Renaming or moving an attribute must rewrite the paths of all its descendants. |
| CAT-FR-05 | An admin must be able to edit an event's display name, description, and status after creation. The studio must show an inactive event as hidden from the builder. |
| CAT-FR-06 | An admin must be able to edit an attribute's default value. |
| CAT-FR-07 | The status badge must show the event's real status. |
| CAT-FR-08 | Deleting an event must be refused while a metric definition of the event exists, archived or not, or while a published campaign uses the event. The refusal must name each metric definition and each campaign with its nodes, and must offer to hide the event. Deleting an event must never delete a metric definition. The check and the delete must run in one transaction, and no publish or metric definition write may add a use between them. |
| CAT-FR-09 | A failed create must keep what the admin typed. |
| CAT-FR-10 | Only admins may change the catalog. The studio must offer every change at `/data/events`, which creates events, and `/data/events/[id]`, which does the rest of [Behavior](#behavior). Each page must show an editor the same content read-only, the event's uses included. Until cutover, `/admin/events` offers the changes too. Editors may also read the catalog through the builder. |
| CAT-FR-11 | Every attribute change must be classified as Safe, Asks first, or Breaking by the table in [Behavior](#behavior), and the edit form must show the kind before the save. A Safe change must save at once. An Asks first change must save only after a confirmation that says which events would be dropped. A Breaking change must be refused while the attribute or a descendant is in use, and otherwise must save only after a confirmation. A use is a metric definition of the same event that aggregates the attribute or names it in its default properties or filter conditions, or a node of a published campaign, active or paused, whose event condition on the same event or whose metric condition on the same event reads it. The refusal must change nothing, name each metric definition and each campaign with its nodes, and offer the three steps of the safe way. The check and the change must run in one transaction, and no publish or metric definition write may add a use between them. |
| CAT-FR-12 | Deleting an attribute is a Breaking change under CAT-FR-11, and must delete its subtree. |
| CAT-FR-13 | An admin must be able to turn each event's schema gate on and off. A new event has it off. Turning it on is an Asks first change: its confirmation must name the required attributes, say that failing events are dropped and never reach journeys, segments, or metrics, and say that admins can read them in Monitoring > Dropped data for 7 days. |
| CAT-FR-14 | An admin must be able to mark each attribute required or optional. A new attribute is optional. Making an attribute required is an Asks first change, and its confirmation must name the senders it affects. |
| CAT-FR-15 | While an event's schema gate is on, every event of that name that reaches customer decision must match the event's attributes by the rules in [Behavior](#behavior). [Event ingestion](../architecture/components/event-ingestion.md#functional-requirements) enforces it (ING-FR-12), from the moment the change reaches it (ING-NFR-07). |
| CAT-FR-16 | Every event must have a kind, `person` or `business`, and the kind must not change while a published campaign or a segment uses the event. |
| CAT-FR-17 | A business event must name its item key, an attribute of its own. The item key must not be renamed or deleted while the event exists. |
| CAT-FR-18 | The studio must not offer the kind `business` when it creates an event, until customer decision reads business-event matches. It must create every new event with the kind `person`. |
| CAT-FR-19 | An admin must be able to add an attribute inside any attribute, by hand or from a pasted sample of that attribute. Adding inside an attribute that is not `json` turns it into a `json` group, which is a Breaking change under CAT-FR-11: the form must warn before the save that events sending the old value type will no longer match. |
| CAT-FR-20 | The detail page must show, for each attribute, the number of its uses, and for the event, the campaigns, the metric definitions, archived ones marked, and the segments that use it. |

## Non-functional requirements

| Id | Requirement |
|---|---|
| CAT-NFR-01 | The list pages with a keyset, so that a large catalog loads in constant time per page. |

## Interfaces

| Direction | Interface | Contract |
|---|---|---|
| UI | `/data/events` | The catalog list, for every staff user, with **Add event** for admins. [Data health](data-health.md#event-catalog-view) owns the list. Under `/v2` until the prefix drops ([studio shell](studio-shell.md#routes)). |
| UI | `/data/events/[id]` | The [event detail page](#event-detail-page). Changes for admins, read-only for editors. Under `/v2` until the prefix drops. |
| UI | `/admin/events` | The classic catalog page, admin only, until cutover. From cutover it redirects to `/data/events`, as the [studio shell](studio-shell.md#cutover-and-redirects) says. |
| Read and write | `user_events` | One row per event. `enforce_schema` holds the schema gate, `status` the status. |
| Read and write | `user_event_fields` | One row per attribute, keyed by path. `required` holds the Required flag. |
| Read by ingestion | `user_events_pub`, `user_event_fields_pub` | CDC publications of the two tables, which ingestion reads to apply the schema gate |
| Referenced by | `user_metric_definitions.user_event_id` | An event with a metric definition cannot be deleted (CAT-FR-08). |
| Read | `user_metric_definitions`: `agg_field`, `default_properties`, `filter_conditions` | Attribute uses, for a breaking change |
| Read | `campaign_nodes`: `trigger_json`, `conditions_json`, `paths_json` | Attribute uses in filters and behavior conditions, for a breaking change. Profile conditions read only profile fields. |
| Read | Segment definitions | The segments that use the event, for the detail page (CAT-FR-20) |

See [the data model](../architecture/data-model.md).

## Failure handling

| Case | Behavior |
|---|---|
| Duplicate system name | Reject it, keep the form, and link to the existing event. |
| Sample payload is not JSON | Show the parse error with its line, and keep the fields of the last valid sample. |
| Sample payload has a key that is empty or holds a dot | Show the error and keep the tree. |
| Blank system name, a path with an empty key, or a type that is not one of the five | Reject it and keep the form. Nothing is stored. |
| Two attributes with one path, or a rename onto a path that exists | Reject it and name the path. Nothing changes. |
| Delete fails | Show the error. Nothing is deleted. |
| Delete of an event with a metric definition or a use | Reject it, list them, and offer to hide the event. Nothing is deleted. |
| Breaking change of an attribute in use | Reject it, list the uses, and offer the safe way. Nothing changes. |
| Schema gate or Required change fails | Show the error. The switch or box keeps its stored state. |

## Acceptance criteria

- Given an admin on `/data/events`, when he opens **Add event**, then the dialog offers no kind, and the event it creates has the kind `person`. (CAT-FR-18)
- Given an editor, when she opens `/data/events/[id]`, then she sees the fields and the uses with no switch, row action, **Add event**, or delete, and a direct call to a catalog change with her session writes nothing. Given an admin, the same page offers the changes. (CAT-FR-10)
- Given an existing business event, when any viewer opens its detail page, then the kind and the item key show read-only. (CAT-FR-10, CAT-FR-18)
- Given a new event `com.acme/price_drop` of kind `business` without an item key, when it is saved, then the save is rejected and names the item key. (CAT-FR-17)
- Given `com.acme/price_drop` with the item key `product.id`, when the admin renames `product.id`, then the rename is refused. (CAT-FR-17)
- Given `com.acme/view_product`, which an active campaign uses as a trigger, when the admin changes its kind to `business`, then the change is refused. (CAT-FR-16)
- Given a workspace whose vendor prefix is `com.acme/`, when the admin types "Add To Cart" in **Add event**, then the event is stored as `com.acme/add_to_cart`. (CAT-FR-02, CAT-FR-21)
- Given the same workspace, when the admin types "acme/add_to_cart", then the save is refused and no event is created. (CAT-FR-21)
- Given the payload `{"product": {"id": "SKU-1", "price": 1}}`, then the attributes are `product` (json), `product.id` (string), and `product.price` (number). (CAT-FR-03)
- Given `product` renamed to `item`, then `product.price` becomes `item.price`. (CAT-FR-04)
- Given an admin who edits a field's label, then the form shows Safe and the change saves with no confirmation. (CAT-FR-11)
- Given an admin who makes `quantity` Must be sent, then the form shows Asks first, and cancelling the confirmation leaves it optional. (CAT-FR-11, CAT-FR-14)
- Given a metric definition of `com.acme/add_to_cart` that sums `product.price`, when the admin renames, deletes, or changes the type of `product.price` or `product`, then the change is refused, the message names that metric definition and offers the three steps of the safe way, and no attribute changes. (CAT-FR-11, CAT-FR-12)
- Given a paused campaign whose setup node on `com.acme/add_to_cart` compares `product.price`, when the admin renames `product.price`, then the message names that campaign and the node. (CAT-FR-11)
- Given `product.price` used only by `com.acme/view_item` conditions, or only `product.price_old` used on `com.acme/add_to_cart`, when the admin renames `com.acme/add_to_cart`'s `product.price`, then the form shows Breaking, asks for confirmation, and the rename succeeds. (CAT-FR-11)
- Given `product.price` used only by `com.acme/view_item` conditions, when the admin deletes `com.acme/add_to_cart`'s `product.price`, then it and its subtree are deleted after the confirmation. (CAT-FR-12)
- Given `quantity` (number) that nothing uses, when the admin adds a field inside it, then the form warns that `quantity` becomes a group and events that send it as a number will no longer match, and after the confirmation `quantity` is `json` with the new child. (CAT-FR-19)
- Given `product.price` in use, when the admin adds a field inside it, then the change is refused and names the uses. (CAT-FR-19, CAT-FR-11)
- Given an event with one archived metric definition and no other use, when the admin deletes it, then the delete is refused, the dialog names that metric definition and offers to hide the event, and the metric definition still exists. (CAT-FR-08)
- Given an event that an active campaign triggers on by name and that has no metric definition, when the admin deletes it, then the delete is refused and names that campaign. (CAT-FR-08)
- Given an event with no metric definition and no use, when the admin deletes it and confirms, then the event and its attributes are gone. (CAT-FR-08)
- Given a create that fails, then the form still holds the entered values. (CAT-FR-09)
- Given `com.acme/add_to_cart` switched to inactive, then the event list shows it as Hidden from builder, the builder does not offer it, and a published campaign that triggers on it keeps running. (CAT-FR-05)
- Given a new event, then its schema gate is off and its attributes are optional. (CAT-FR-13, CAT-FR-14)
- Given the admin turns on the schema gate of `com.acme/add_to_cart`, then the confirmation names the required attributes and says that dropped events are kept 7 days in Monitoring > Dropped data. When the admin cancels it, the gate stays off. (CAT-FR-13)
- Given `com.acme/add_to_cart` with `product.price` (number, required) and the gate on, when a `com.acme/add_to_cart` arrives with `product.price` `"12990000"` or without `product.price`, then customer decision does not see it. When the gate is off, it does. (CAT-FR-15)
- Given `product.price` used by one journey and one metric definition, then its row shows "In use · 2", and the page lists the journey, the metric definition, and the segments that use the event. (CAT-FR-20)

## Open questions

- Whether a segment that uses an event or an attribute counts as a use that refuses a breaking change or an event delete. The detail page lists segments (CAT-FR-20), but CAT-FR-08 and CAT-FR-11 do not count them yet.
- Where the workspace's vendor prefix is configured, and who may change it. CAT-FR-21 needs one prefix per workspace but does not say where it is set.

## Related

- [Journey builder](journey-builder.md)
- [Data health](data-health.md)
- [Customer decision](../architecture/components/customer-decision.md)
- [Event ingestion](../architecture/components/event-ingestion.md)
- [0014. Gate events on their catalog schema at ingestion](../architecture/decisions/0014-gate-events-on-their-catalog-schema-at-ingestion.md)
- [0044. Classify event field changes as Safe, Asks first, or Breaking](../architecture/decisions/0044-classify-event-field-changes-as-safe-asks-first-or-breaking.md)
- [Known issues](../known-issues/features/event-catalog.md)
