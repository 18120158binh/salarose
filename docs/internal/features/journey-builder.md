---
title: Journey builder
slug: journey-builder
purpose: Let a marketer start a journey, draw it as a graph of triggers, checks, waits, splits, and messages, keep it as a draft on the server, and publish it in the form the runtime executes.
status: accepted
implementation: partial
area: studio
tags: [ui, journeys, canvas, conditions, drafts, templates]
created: 2026-10-14
updated: 2026-11-08
version: 3.1
known_issues: ../known-issues/features/journey-builder.md
---

# Journey builder

## Purpose

Marketers build journeys without writing code. They start one at `/journeys/new`, from a blank journey, a template, or a sentence, and build it at `/journeys/[id]`. They pick a trigger event, add checks, waits, and condition splits, and end each path with a message on a channel such as push or SMS. The builder saves the journey as a draft on the server while they work. When the journey is published, the builder's saved format becomes the rules that [customer decision](../architecture/components/customer-decision.md) evaluates and the graph that [journey execution](../architecture/components/journey-execution.md) runs.

Until the classic studio is removed, the classic builder at `/campaign/[id]` also stays live, as [The classic builder until it is removed](#the-classic-builder-until-it-is-removed) says.

## Scope

In scope:

- Starting a journey at `/journeys/new`: blank, from a template, or described in a sentence.
- The canvas, the node palette, the side-panel editors, and the publish checklist.
- The editors for triggers, filters, and conditions.
- Drafts on the server: autosave, version conflicts, and moving drafts out of the browser.
- The publish action's draft handling: which draft it reads, and how a retry or a collision ends.
- The runtime registry that decides which controls the builder offers.
- The saved format of a journey: the tree and the node rows.
- The journey list at `/journeys`, and a published journey's page at `/journeys/[id]`, with analytics and live node counts.

Paths in this contract are the final ones. Until the `/v2` prefix drops, each carries it, so `/journeys/new` is at `/v2/journeys/new`. The [studio shell](studio-shell.md) owns the route table, the stages, and the redirects from classic URLs.

Out of scope:

- The publish transaction itself, and pausing, resuming, deleting, and duplicating a campaign. [Campaign management](campaign-management.md) owns the lifecycle.
- Generating a journey from text. [AI journey generation](ai-journey-generation.md) owns the route that does it.
- The segment editor. [Segments](segments.md) owns it, and shares this contract's condition editor.
- The shell, time ranges, and page states of studio v2. The [studio shell](studio-shell.md) owns them.

## Terms

| Term | Meaning |
|---|---|
| Journey | The graph of one campaign. The UI uses "campaign" and "journey" for the same thing. |
| Draft | A journey that is not published yet. It is one row of `journey_drafts`, belongs to one staff user, and has the id the campaign will have. |
| Origin | How a draft started: `blank`, `template:<key>`, `ai`, `duplicate:<id>`, or `browser`. |
| Node | One step of the journey. Its type decides what it does. |
| Path type | A node's set of outgoing branches, such as `YesOrNoPath`. |
| Main path | The chain from the setup node through the first outgoing branch of each node. |
| Trigger | One event and filters on its attributes, on a setup, check, or watch node. The setup node's trigger starts the journey. |
| Filter | A test on an attribute of an event, of type `event_property`. |
| Condition | A test on the person: a profile field, of type `profile_property`, or behavior over a window, of type `behavior`. |
| Group | A list of filters or conditions. A group passes when any of them passes, and every group must pass. |
| Runtime registry | The one list of trigger kinds, condition types, and editor options that the runtime evaluates, and of the size views whose stored membership the runtime writes. The palette, the condition editor, the validator, and the segment pages read it. |
| Problem | A rule the journey breaks, with a severity, the node, the field, and a plain message. A blocking problem stops publish. A warning does not. |

## Behavior

A journey starts at one setup node and branches downward. Example:

1. Setup: trigger on `com.acme/view_product` where `product.price > 500000`.
2. Watch: wait up to 1 day for `com.acme/add_to_cart`.
   - On success, end.
   - On timeout, send a push: "Still thinking about it?"

### Node types

| Node | What the marketer configures | Path types |
|---|---|---|
| Setup | A trigger of one of the [trigger kinds](#trigger-kinds), and optional conditions | One path |
| Check | A trigger, and optional conditions | `YesPath`, `NoPath`, `YesOrNoPath`, `MultiBranchPath` |
| Watch | A trigger to wait for, and a time limit in seconds, minutes, hours, or days | `SuccessPath`, `TimeoutPath`, `SuccessOrTimeoutPath`, `DelayPath` |
| Condition split | Conditions with at least one behavior condition, and no trigger | `YesPath` |
| Engagement | Channel and content: title, body, subject, URL, template id, payload, and webhook method | One path |
| End | Nothing. Its editor says the journey ends there and has no fields. This was chosen during the fix and is pending owner review. | None |

The channels are push, web push, SMS, email, Facebook, WhatsApp, and webhook. The builder offers no Zalo for now. The owner decided this on 2026-11-08.

A `DelayPath` watch waits for its time limit and continues, with no event. A multi-branch check has named branches, each with its own filters and conditions. Every branch that matches fires.

A condition split is a check on the person only. Its `node_type` is `condition_split`. It has no trigger. It takes Yes when its conditions hold, and it never takes No. The owner decided this on 2026-10-17. Its conditions are checked when a person reaches it, and again each time one of its metrics changes, so a person who already meets them moves on at once. The owner decided this on 2026-10-18. See [customer decision](../architecture/components/customer-decision.md#segment-checks). A condition split is not a [segment](segments.md): a segment is a saved list of conditions that many campaigns can use.

The builder offers only the Yes path for a condition split. The owner decided this on 2026-10-18. Older builds also offered **No Only** and **Yes & No Branches**. A draft saved with a No path still loads, and the builder keeps the No path and its nodes, so that opening a journey loses nothing. The editor warns that users never take No and that the nodes on it never run. Picking **Yes Only** deletes the No path, as any path type change deletes the removed branch. A draft saved as **No Only** gets a Yes path when the marketer adds a node on Yes.

An engagement has no phone field. The owner decided this on 2026-10-18: the [notification request](../architecture/components/notification-outbox.md) reaches the person through their profile, never through a fixed number on the node. Older builds saved a phone on SMS and WhatsApp steps. A journey that still carries one loads, and the phone is dropped on load and on save.

### Conditions

A node that tests something has two parts, split by role. [Decision 0029](../architecture/decisions/0029-model-a-rule-as-a-trigger-and-person-conditions.md) explains the split.

- **The trigger** is one event and filters on that event's own attributes. The list offers the catalog's person events. A setup node can instead start on a segment entry or a business event, as [Trigger kinds](#trigger-kinds) describes. Setup, check, and watch nodes have a trigger. A condition split has none.
- **The conditions** test the person: profile fields, and behavior over a window. A watch has no conditions.

Filters and conditions come in groups. Every group must pass, and a group passes when any of its conditions passes. The editor shows each group as a card under the heading "All of these must hold", with its rows under "Any of". **Add group** and **Add alternative** add a card and a row. Each filter or condition has a type:

| Type | Used in | Tests | Fields |
|---|---|---|---|
| `event_property` | Filters | An attribute of the trigger's event, from the [event catalog](event-catalog.md) | `field`, `op`, `value` |
| `profile_property` | Conditions | A profile field: `gender`, `age`, `city`, or `user_time`, or an imported field such as `orders.spend_90d` | `field`, `op`, `value` |
| `behavior` | Conditions | What the person did over a window, such as "performed `com.acme/add_to_cart` at least 3 times in the last 7 days" | `event`, `measure`, `attribute`, `filters`, `window`, `op`, `value` |
| `segment_membership` | Conditions | Whether the person is in a saved [segment](segments.md) at that moment | `segment_id`, `op` (`in` or `not_in`) |

The builder offers a condition type only when the [runtime registry](#runtime-registry) holds it, so `segment_membership` appears once customer decision evaluates it.

The editor offers only the operators that fit the field's type, with a typed value input: a number field for numbers, a date picker with an optional time for datetimes, and chips for `IN`.

- **Contains.** For a text attribute, the editor offers "contains". It saves the comparison as `LIKE`, with the typed text between two `%`: "contains `iphone`" saves `LIKE %iphone%`, which matches `Apple iphone 15`. The editor shows the text without the `%`. The [condition language](../architecture/components/customer-decision.md#condition-language) has no escape, so a `%` or `_` in the typed text still matches any run of characters or any one character. The editor says so when the text has one. A blank "contains" would save `LIKE %%`, which matches every value, so publish refuses any `LIKE` whose pattern is only `%`, and the editor asks for text while the field is blank. Older builds saved "contains" as `LIKE` with the bare text, which matches only that exact value. The editor shows a saved `LIKE` that does not both start and end with `%` as "matches exactly", with the value as saved, and does not offer that operator for new conditions. The owner decided this on 2026-10-18.
- **Datetimes.** For a `datetime` attribute, the editor offers "is after", "is on or after", "is before", and "is on or before", saved as `>`, `>=`, `<`, and `<=`. The value is an ISO 8601 date or datetime, such as `2026-10-01` or `2026-10-01T09:00:00Z`. The [condition language](../architecture/components/customer-decision.md#condition-language) orders two such values in time. A date alone means the whole day in UTC, so "is on or before 2026-10-01" includes 2026-10-01T10:00:00Z. These datetime rules were chosen during the fix and are pending owner review. See [Open questions](#open-questions).
- **Imported fields.** The profile field picker also lists imported fields, grouped by source under the source's display name, such as **Orders > Spend, last 90 days**. A source is a profile record type, whose fields are its attribute columns, or an event record type, whose fields are its enabled imported metrics. Each field shows its display name and type from the record type's current version or from `import_metric_definitions`. The condition saves the field as `<source>.<name>`. See [data import](data-import.md#imported-metrics).
- **Relative dates.** For a `datetime` profile field, built-in or imported, the editor also offers "more than N days ago" and "within the last N days", saved as `more_than_days_ago` and `within_last_days` with N, a whole number of at least 1, as the value. They compare with the time of the event that the condition is checked at, not with today. They are not offered for filters.
- **Runtime support.** Following JBD-FR-31, the picker offers imported fields and the relative-date operators only once the runtime that evaluates the condition resolves them: customer decision for a journey, and the segment runtime for a segment.

 [Customer decision](../architecture/components/customer-decision.md#condition-language) defines the operators and the measures.

A behavior condition names a catalog event and a measure, which is one of the [metric functions](../architecture/components/customer-decision.md#metric-functions). `attribute` names the event attribute the measure reads, and is absent for `COUNT` and `INACTION`. `filters` narrow which of those events count, in the same group shape as a trigger's filters. `window` is a number above 0 and a unit. The marketer never picks a metric id. Publish derives one from the condition, as [campaign management](campaign-management.md#metric-definitions) describes. The editor reads a behavior condition as a sentence, such as "performed **Add to cart** **at least 3** times in the last **7 days**", with "+ filter" to narrow which events count.

The editor does not offer the measure `INACTION` for a new behavior condition, because no timer evaluates it and it never matches. A saved `INACTION` condition loads, and the checklist shows a warning on it.

The [segment editor](segments.md) uses the same condition editor in person mode. Its "+ filter" on behavior conditions follows the runtime registry too.

### Trigger kinds

A setup node's trigger has a `kind`. Check and watch nodes use only `event`.

| Kind | Starts the journey for a person when | Fields |
|---|---|---|
| `event` | The person does the event, and it passes the filters | `event`, `filters` |
| `segment_entry` | The person enters a [segment](segments.md) | `segment_id`, `reentry` |
| `business_event` | A business event that passes the filters concerns the person, through the audience | `event`, `filters`, `audience` |

The builder offers a kind only when the [runtime registry](#runtime-registry) holds it. `event` is there from the start. `segment_entry` comes online once customer decision starts journeys on segment entry. `business_event` stays out until customer decision reads business-event matches.

`reentry` says whether a person who entered before can start the journey again: `{ "mode": "never" }`, the default, `{ "mode": "always" }`, or `{ "mode": "after", "after": { "value": 30, "unit": "DAYS" } }`, which allows a new entry once the last one is at least that old.

A business event concerns an item, such as a product. The list offers the catalog's business events. The `audience` says which people a business event reaches:

- **Interest.** People who did a person event on the same item at least `min_count` times in a window. `match` names the person event's attribute that must equal the business event's item key. An optional exclusion removes people who did another event on the same item in the window.
- **Segment.** Every member of a saved segment.

```json
{
	"kind": "business_event",
	"event": "price_drop",
	"filters": { "groups": [
		{ "conditions": [ { "type": "event_property", "field": "drop_percent", "op": ">=", "value": 10 } ] }
	] },
	"audience": {
		"type": "interest",
		"event": "com.acme/view_product", "match": "product.id", "min_count": 2,
		"window": { "value": 7, "unit": "DAYS" },
		"exclude": { "event": "purchase", "match": "product.id" }
	}
}
```

```json
{ "kind": "business_event", "event": "back_in_stock", "audience": { "type": "segment", "segment_id": "SEG-4f1c9a0b2d3e5f67" } }
```

```json
{ "kind": "segment_entry", "segment_id": "SEG-4f1c9a0b2d3e5f67", "reentry": { "mode": "after", "after": { "value": 30, "unit": "DAYS" } } }
```

[Business event fan-out](../architecture/components/business-event-fan-out.md) finds the people a business event reaches. A person can enter a business-event journey once per business event ([decision 0033](../architecture/decisions/0033-a-journey-instance-is-one-entry.md)).

### Runtime registry

The builder must not offer a control that the runtime ignores. One runtime registry lists the trigger kinds, condition types, and editor options that the runtime evaluates. The palette, the condition editor in the builder and in the [segment editor](segments.md), and the validator all read it (JBD-FR-31).

At the start, the registry holds the trigger kind `event` and the condition types `event_property`, `profile_property`, and `behavior`. Six entries join it in this order, each once its runtime change runs on the cluster and its acceptance test passed there:

| Order | Entry | Turns on | Comes online when |
|---|---|---|---|
| 1 | Condition type `segment_membership` | The segment membership row in the condition editor (JBD-FR-17) | Customer decision evaluates a `segment_membership` condition ([DEC-FR-30](../architecture/components/customer-decision.md#functional-requirements)) |
| 2 | Trigger kind `segment_entry` | **Segment entry** in the palette's Start group, with its segment picker and re-entry setting (JBD-FR-15) | Customer decision detects segment entries and emits setup triggers on them (DEC-FR-31, DEC-FR-32, DEC-FR-34) |
| 3 | Event filters on behavior conditions in segment mode | "+ filter" in the segment editor ([SEG-FR-11](segments.md#functional-requirements)) | Customer decision applies filters to a segment's behavior conditions (DEC-FR-36) |
| 4 | Size from tracked members | The Size column on the segment list and the count on the Size card, with its basis ([SEG-FR-08](segments.md#functional-requirements), SEG-FR-12) | The profile writer stores tracked members in `segment_members` ([PRW-FR-08](../architecture/components/profile-writer.md#functional-requirements)) |
| 5 | Size with imported-only members | Size adds the rows of `segment_import_members`, and the card names last night's pass (SEG-FR-13) | The segment membership pass runs nightly and writes its run record ([SMP-FR-01](../architecture/components/segment-membership-pass.md#functional-requirements), SMP-FR-11) |
| 6 | **Also include current members** at publish | The publish option on a segment-entry journey (JBD-FR-32) | The segment membership pass sends current members and customer decision enters them ([SMP-FR-13](../architecture/components/segment-membership-pass.md#functional-requirements), [DEC-FR-39](../architecture/components/customer-decision.md#functional-requirements)) |

`business_event` stays out of the registry until customer decision reads business-event matches. [Decision 0038](../architecture/decisions/0038-store-segment-membership-and-evaluate-every-segment.md) records the segment runtime that brings entries 1 to 6 online. Entry 6 needs `segment_members`, so it follows entry 4 and does not wait for entry 5.

A draft or a published journey that uses a kind, type, or option the registry lacks still loads. The builder shows that part read-only, with a note that the runtime does not run it yet, and the checklist lists it as a blocking problem. So a draft cannot publish a control the runtime ignores.

### One journey, one id

A journey has one id from its first save to its analytics. A new draft takes a new random id in the campaign form, `CAMP-` and 16 hexadecimal digits. Publish writes the campaign under the draft's id, so `/journeys/[id]` names the same journey before and after publish ([decision 0036](../architecture/decisions/0036-store-journey-drafts-on-the-server-outside-cdc.md)). The only exception is a publish collision, where the marketer chooses to publish under a new id, as [Publish](#publish) says.

### Starting a journey

`/journeys/new` offers three starts. **Start blank** and **Describe it** sit side by side, and the template gallery fills the rest of the page. Each start creates a draft owned by the viewer and opens it in the builder.

| Start | The new draft | `origin` |
|---|---|---|
| **Start blank** | One setup node | `blank` |
| **Describe it** | The journey that [AI journey generation](ai-journey-generation.md) returns for the marketer's sentence | `ai` |
| A template | The template's tree, with its events mapped to catalog events | `template:<key>` |

**Describe it** is a text box with three example prompts. It is hidden when the deployment has no model configured. When generation fails or the marketer is over the rate limit, the page shows the message inline and creates no draft.

Two other paths create drafts. **Duplicate to edit** creates one with `origin` `duplicate:<id>`, as [Journey pages](#journey-pages) says. Moving a draft out of the browser creates one with `origin` `browser`, or `duplicate:<old id>` on a collision, as [Moving browser drafts to the server](#moving-browser-drafts-to-the-server) says.

### Templates

Built-in templates ship with the studio and change only through code review. Each has a key, a name, one line on its purpose, a journey tree, and the catalog events it needs. The first set is Welcome series, Abandoned cart, Browse abandonment, Win-back, and Post-purchase follow-up. Price drop and Back in stock wait, because they need business-event triggers.

Template message copy is in Vietnamese, and every message step uses SMS or push. The owner decided this on 2026-11-08. The copy is something a Vietnamese shop could send after editing names and links.

A template names each event by its system name in the [event catalog](event-catalog.md), such as `com.acme/add_to_cart`. Templates and the catalog use one naming, so a shop whose catalog holds the event gets the mapping prefilled. The owner decided this on 2026-11-08.

Abandoned cart starts on `com.acme/add_to_cart`, then waits up to 2 hours for `com.acme/order_completed`. On success it ends. On timeout it sends the push "Bạn quên giỏ hàng?", waits 1 day with a `DelayPath` watch, sends an SMS, and ends. A check does not fit here: a check waits for its event, so a person who never orders never reaches No. The owner decided this on 2026-11-08.

- **The gallery** shows each template as a card with its name, its purpose, a small rendering of its graph, and the events it needs, such as "Needs: Added to cart, Order completed" for Abandoned cart.
- **Choosing a template** opens a dialog that maps each event the template needs to a catalog event. A mapping is prefilled when the catalog has an event of that name, and the dialog flags an event the catalog has nothing for. The dialog asks for the journey's name, creates the draft, and opens the builder.
- **An unmapped event does not block the draft.** The draft keeps the template's event name where the marketer mapped nothing. The checklist lists each node that names it as a blocking problem, "Add this event to the catalog or pick another", and publish refuses the draft until the event is in the catalog or replaced. This is the lead's default, pending owner review.
- **Templates are tested.** In the test suite, every template must parse as a draft and, with its events mapped to fixture catalog events, pass the full publish validation (JBD-FR-30).

### Builder layout

The builder at `/journeys/[id]` has a header, a palette on the left, the canvas, and a side panel on the right. The studio sidebar collapses to its icon rail while the builder is open.

- **Header.** The name, editable in place, the status badge, the save state ("Saving", "Saved 10:42", or "Not saved. Retry"), undo and redo, the checklist button with its problem count, and **Publish** as the one primary action.
- **Palette.** A search box and five groups. Each group offers only what the [runtime registry](#runtime-registry) holds.
  - Start: Event trigger, and Segment entry once the registry holds it.
  - Logic: Check, Branch by event (a check preset to `MultiBranchPath`), and Condition split.
  - Wait: Wait for event, and Wait for time (a `DelayPath` watch).
  - Messages: Push, Web push, SMS, Email, WhatsApp, Facebook, and Webhook.
  - End.
- **Canvas.** The journey drawn as a top-down tree. Each node card shows an icon, the label from [Node labels](#node-labels), and a marker when the checklist has a problem on that node. On a published journey, it also shows the node's count. The layout is always automatic.
- **Side panel.** Opens when a node is selected, does not cover the canvas, and closes on Escape.

### Editing

Edits apply to the draft as they happen. No editor has an "Apply" button.

- Clicking a node in the palette appends it after the last node on the main path, in place of the End node on that branch. A branching node gets an End node on each new branch.
- Dragging a palette item onto an edge inserts it there. Each edge shows a drop target during the drag.
- The "+" button on an edge opens the palette at that spot and inserts the chosen node between the two others.
- Inserting under a branching node asks for the branch, and for a message, whether it runs in parallel with the existing children or in sequence after them.
- The builder offers no free edge. Every insert attaches the new node to a parent, so a node always has exactly one parent and no cycle can form. There is no drag from one node to another and no **Align** command.
- Changing a node's path type deletes the subtrees of the branches that no longer exist. When a removed branch has nodes, a dialog asks first and names the branch and the number of steps, such as "This removes the No branch and its 3 steps."
- Deleting a one-path step, such as Wait for time, a message, or End, removes only that step, with no dialog. Its children move up to its parent, on the branch the step hung from, so the step after it takes its place: "Removes this step. The SMS below it moves up." Deleting a branching step, such as Wait for event, a check, or a condition split, removes it and everything below it after a dialog that names how many steps go: "Removes this step and the 5 below it." The setup node has no delete control and says "The start step can't be removed." (JBD-FR-42)
- Either delete keeps the journey a tree (JBD-FR-11): a moved child keeps one parent. End node ids below a moved step are recomputed on save from their new parent, as JBD-FR-12 says for any change above an End.
- Undo and redo cover every edit in the open session, with Ctrl+Z and Ctrl+Shift+Z. The history lives in memory and does not survive a reload.
- The arrow keys move the selection along the tree. Enter opens the side panel. Delete removes the node, with the same confirmation. Every control has a visible focus ring ([SHL-NFR-02](studio-shell.md#non-functional-requirements)).

Every confirmation is a dialog in the page. The builder never uses the browser's alert or confirm dialog. The one native dialog is the browser's leave-page prompt, described in [Drafts on the server](#drafts-on-the-server).

### Side panels

Each panel reads and writes the same tree fields as the classic editor for its node, so every field round-trips (JBD-FR-02).

| Node | Panel sections |
|---|---|
| Setup | *Trigger:* a searchable picker over the catalog's person events, with display names and the system names below. Once the registry holds `segment_entry`, the trigger can instead be "enters a segment", with a segment picker, the re-entry setting, and the note "People already in this segment when you publish start only after they leave it and come back, unless you include current members when you publish." *Filters:* the condition editor over that event's attributes. *Who can enter:* the condition editor in person mode. |
| Check | *Trigger* and *Filters*, as for Setup. *Conditions.* *Branches:* Yes only, No only, Yes and No, or Named branches. Named branches is a list of keyed branches, each with its own filters and conditions, named `branch_0`, `branch_1`, and so on, with an editable display label. |
| Watch on an event | *Event* and *Filters*. *Time limit:* a number and a unit. *Branches:* On success, On timeout, or both. |
| Watch, `DelayPath` | *Duration:* a number and a unit. One path. |
| Condition split | *Conditions*, with at least one behavior condition. *Path:* Yes only, shown as a fact. A No branch saved by an older build shows "People never take this branch. Its 2 steps never run.", with **Remove branch**. |
| Engagement | *Channel* as a segmented control. Switching keeps the fields both channels share. *Content* per channel: push has title, body, and URL. Email has subject, body, and template id. SMS has body. Webhook has URL, method, and a JSON payload checked as the marketer types. *Preview:* for push, SMS, and email, a device frame that shows the text exactly as typed. |
| End | "The journey ends here for this path." No fields. |

A published journey opens the same panels read-only (JBD-FR-08). **Duplicate to edit** sits in the panel's footer and in the header.

### Publish checklist

The builder lists every publish problem at once (JBD-FR-25). A condition that can never match is a warning, not a blocking problem (JBD-FR-44).

- **Live checks.** A moment after the last edit, the browser runs the same validator that publish runs on the server. It returns every problem, not only the first. A message names the node and says what to do, such as "Wait for event: pick an event to wait for."
- **The checklist** lists problems in tree order, grouped by node. **Go to** selects the node, opens its panel, and focuses the field.
- **Blocking problems** are every rule that publish refuses: JBD-FR-05, JBD-FR-11, JBD-FR-13, JBD-FR-14, JBD-FR-31, [CMP-FR-02](campaign-management.md#functional-requirements), and CMP-FR-18, plus a node that names an event the catalog lacks.
- **Warnings** do not block. They include a No branch on a condition split that never runs, a journey with no message step, a message with an empty title on a channel that allows one, and a saved `INACTION` condition.
- **Review and publish.** **Publish** opens a dialog that describes the journey in words, such as "Starts when someone views a product over 500,000. 4 steps. Sends 1 push.", and lists the metric definitions this publish turns `LIVE`. The dialog runs the server-only checks, which write nothing: the catalog has every event the journey names, and every metric derives against its catalog types ([CMP-FR-12](campaign-management.md#functional-requirements)). Its confirm button stays disabled while any blocking problem remains.
- **Publish options.** When the setup node starts on entering a segment and the [runtime registry](#runtime-registry) holds entry 6, the dialog offers **Also include current members**, off by default and chosen for this publish. Next to it, the dialog says "About 1,240 people in Hanoi cart builders will enter once, at most 1,000 a second. Customers known only from imports are not included." The count is the segment's rows in `segment_members`. With the option off, the dialog says "Only people who enter Hanoi cart builders after you publish start this journey." The option is not part of the draft. The publish action carries it, and **Publish as a new journey** keeps it. When it is on, every tracked member at publish time enters once, subject to the re-entry setting, as [customer decision](../architecture/components/customer-decision.md#current-members-at-publish) says. The owner decided this on 2026-11-08.

### Publish

The publish action names the draft id and the version the builder last saw. The server reads the draft from `journey_drafts` and trusts that row, not a tree from the browser. It validates the stored tree and runs the [publish transaction](campaign-management.md#publish), which writes the campaign under the draft's id, records the draft id and a hash of the stored root in `journey_publishes`, and deletes the draft row (JBD-FR-27).

Publish decides from what it finds, so a retry converges and a clash with another publisher writes nothing. It first looks for a `journey_publishes` row that names the draft id under another campaign id. Such a row means that the draft was published as a new journey, so the result is "Already published". Publish writes nothing and opens that journey. Otherwise this table decides:

| Draft row | Campaign with the draft's id | Result |
|---|---|---|
| Present | None | Publish. |
| Absent | Present, with a `journey_publishes` row for this draft id | Already published. Write nothing, and open the journey. |
| Present | Present, with a `journey_publishes` row for this draft id and the same root hash | Already published. Delete the leftover draft, and open the journey. |
| Present | Present in any other way, such as published by the classic builder or from a different root | Collision. Write nothing. The dialog says "A journey with this id was published somewhere else" and offers **Publish as a new journey**. |
| Absent | Present, with no `journey_publishes` row for this draft id | Write nothing. The dialog says "This draft no longer exists". This happens when the draft was deleted in another tab and the classic builder published the same id. |
| Absent | None | Write nothing. The dialog says "This draft no longer exists". |

**Publish as a new journey** is one transaction. It takes a fresh campaign id, publishes the stored draft under it, writes a `journey_publishes` row with the new campaign id and the old draft id, and deletes the draft. The reply carries the new id, and the builder opens that journey. If the transaction fails, nothing changes, and the draft keeps its old id. A retry after a lost reply finds the `journey_publishes` row for the old draft id and opens the new journey.

Before this table applies, publish compares versions. If the version the action names is older than the stored draft's, another tab or machine saved after the builder last read the draft. Publish writes nothing and shows "This draft changed somewhere else" with **Load latest**, as a version conflict on autosave does. The marketer reviews the stored draft and publishes again. This is the lead's default, pending owner review.

The classic publish path stays as it is and does not read `journey_publishes`. This table and the [browser-draft move](#moving-browser-drafts-to-the-server) cover every way a classic edit can meet a v2 draft.

After a publish succeeds, the builder opens the published journey. When the draft's origin is `duplicate:<id>`, that journey is active, and the viewer may pause it under [CMP-FR-07](campaign-management.md#functional-requirements), the success dialog asks "Pause '<original name>' now?", because two live copies of one journey message people twice. Confirming pauses the original through campaign management's pause.

### Drafts on the server

A draft lives in `journey_drafts` until it is published or deleted (JBD-NFR-02). [The data model](../architecture/data-model.md) lists its columns.

- **Autosave.** The builder saves one second after the last edit, and the draft must be on the server within 2 seconds of the last edit (JBD-FR-26). Each save names the version it read and raises the version by one.
- **Version conflict.** A save against a newer version is refused. Another tab or machine saved first. The builder shows "This draft changed somewhere else", with **Load latest** and **Keep mine**. **Load latest** replaces the open journey with the stored one. **Keep mine** overwrites the stored draft with a new version. The server never merges two versions.
- **Owner only.** A draft is visible to its owner only. Anyone else, an admin included, who opens its id sees "This journey does not exist.", the message for an id that names nothing.
- **Delete.** Deleting a draft asks for confirmation and is final.
- **Failed save.** The header shows "Not saved. Retry", and the edit stays in memory. Leaving the page with unsaved edits shows the browser's leave-page prompt.
- **Stale deployment.** A rolling restart can leave an open builder calling a server action that the new deployment no longer has. The builder shows "Studio was updated. Reload to keep editing". Saved edits survive the reload. For unsaved edits, the message offers a copy of the tree to the clipboard.

### Moving browser drafts to the server

The classic builder keeps drafts in browser storage under the key `auroracy_campaigns:<userId>`. Both builders stay live until cutover, so the move must be safe to run twice and must lose nothing (JBD-FR-28).

1. When `/journeys` or the [home overview](home-overview.md) finds drafts for the signed-in user under that key, a banner says "3 drafts are saved only in this browser. Move them to your account so they are safe and open anywhere." and offers **Move drafts**.
2. The move parses each draft with the classic draft shape and inserts it into `journey_drafts`, owned by the viewer:

   | The draft | Result |
   |---|---|
   | Its id is free | Inserted under its own id, with `origin` `browser` |
   | The viewer already has a draft with that id, `origin` `browser`, and the same root | Counted as already moved. Nothing is written. |
   | Its id is taken by any other draft or by a campaign | Inserted under a new id, with `origin` `duplicate:<old id>`. The report names the new id. |
   | It does not parse | Left in the browser. The report gives the parse error. |

3. The browser then moves every entry that was inserted or counted as already moved to the backup key `auroracy_campaigns_moved:<userId>`. The classic builder does not read that key, so it stops listing those drafts and cannot fork them.

A run that stops halfway leaves entries under the first key, and the next run counts the inserted ones as already moved. A classic URL for a draft that lives only in the browser redirects to `/journeys/[id]`, which finds no server row and shows the banner with "This draft is still in your browser", not "does not exist". The banner and the move are removed one release after the classic studio is removed ([decision 0037](../architecture/decisions/0037-one-studio-retire-the-classic-studio.md)).

### Saved format

The builder saves a journey in two forms.

The **tree** is the whole journey as nested JSON, with an array where a node has parallel children. It stores everything the editors show, so that the canvas can be rebuilt from it. Drafts keep it in `journey_drafts.root`. Published campaigns keep it in `campaigns.root`. Until the classic studio is removed, classic drafts keep it in the browser.

The **node rows** are what the runtime reads. On publish, each node becomes one `campaign_nodes` row:

| Column | Content |
|---|---|
| `node_id`, `node_type` | The node |
| `parent_node_id`, `parent_branch` | Where the node hangs. See the branch table below. |
| `trigger_json` | The trigger: `kind` and the fields of its kind. Null for a condition split, an engagement, and an end node. |
| `conditions_json` | The conditions, as `groups`. Null when the node has none. |
| `paths_json` | How the node branches: `path_type`, a watch's `limit`, and a multi-branch check's `branches`. Null for a node with one path. |
| `action_json` | The engagement's channel and content |
| `goal_id` | The End node's goal |
| `campaign_node_count` | The number of node rows in this publish, the same on every row. The state machine applies a publish once all of its rows have arrived. |
| `graph_version` | The version of the graph, the same on every row. Activate takes a new one, above every version before it, and resume keeps the one the rows had. The runtime drops a trigger decided against an older version. |

A check on `com.acme/add_to_cart` for items over 500,000, for people in Hanoi or Ho Chi Minh City who added to cart at least 3 times in 7 days, saves this `trigger_json`:

```json
{
	"kind": "event",
	"event": "com.acme/add_to_cart",
	"filters": { "groups": [
		{ "conditions": [ { "type": "event_property", "field": "product.price", "op": ">", "value": 500000 } ] }
	] }
}
```

and this `conditions_json`, with the `metric_id` that publish adds:

```json
{
	"groups": [
		{ "conditions": [ { "type": "profile_property", "field": "city", "op": "IN", "value": ["Hanoi", "Ho Chi Minh City"] } ] },
		{ "conditions": [ { "type": "behavior", "event": "com.acme/add_to_cart", "measure": "COUNT",
			"window": { "value": 7, "unit": "DAYS" }, "op": ">=", "value": 3, "metric_id": "m_7c41d0a2e5f61b93" } ] }
	]
}
```

A watch saves its limit, and a multi-branch check saves its branches, in `paths_json`:

```json
{ "path_type": "SuccessOrTimeoutPath", "limit": { "value": 1, "unit": "DAYS" } }
```

```json
{
	"path_type": "MultiBranchPath",
	"branches": [
		{ "key": "vip", "filters": { "groups": [
			{ "conditions": [ { "type": "event_property", "field": "order.total", "op": ">", "value": 1000 } ] }
		] } },
		{ "key": "regular" }
	]
}
```

An absent `filters` or `conditions` passes. A group must hold at least one condition. A branch with neither filters nor conditions matches every event that passes the node's trigger and conditions. The runtime reads no older format.

A child's `parent_branch` is the branch of its parent that it hangs off:

| Parent | Branch | `parent_branch` |
|---|---|---|
| Setup, Engagement | The one path | `next` |
| Check | Yes, No | `yes`, `no` |
| Check, multi-branch | A named branch | The branch key |
| Watch | Success, Timeout | `success`, `timeout` |
| Watch, `DelayPath` | After the delay | `next` |
| Condition split | Yes | `yes` |
| Condition split saved by an older build | No | `no`, which customer decision never emits |

These names are a contract with customer decision, which emits them, and with journey execution, which matches them. Change all three together.

A multi-branch key uses only letters, digits, and underscores, is unique within its check, and is none of the fixed names in the table: `next`, `yes`, `no`, `success`, or `timeout`. The builder names branches `branch_0`, `branch_1`, and so on. The tree has one setup node, at its root, and no two nodes in it share an id.

Saving the same tree again writes the same `node_id` for every node, so that `campaign_node_stats` keeps counting under it. An End node's `node_id` is its parent's `node_id`, its branch, and `end`, joined with `-`, for example `check_1-yes-end`. When the branch has parallel children, the child's position comes before `end`, for example `check_1-yes-0-end`.

### Journey pages

**Journey list, `/journeys`.** One row per journey the viewer may see:

| Column | Value |
|---|---|
| Name | The campaign's or the draft's name |
| Status | Draft, Active, or Paused |
| Owner | The owner's email, or "No owner" |
| Entries, last 7 days | Setup transitions of the campaign with event time in the [studio shell](studio-shell.md#time-ranges)'s Last 7 days range, as the [home overview](home-overview.md#kpi-row) counts entries |
| Updated | `updated_at` |

The list holds the `active` and `paused` rows of `campaigns`, and the viewer's own rows of `journey_drafts`. A search box matches the typed text anywhere in the name, ignoring case. Filters narrow by status and by owner. The owner filter is **Mine** by default and **All** one click away. A draft shows under **Mine** only, and only to its owner. An admin's **Mine** also holds the journeys whose owner was deleted. **All** shows every published journey to every staff user, so that an editor can watch a colleague's journey. Rows sort by `updated_at`, newest first, and can sort by name or by entries. A draft's entries read "Not published".

The list's loading, empty, and load-error states, the origin note under a draft's name, and the note under the list on what **Mine** and **All** show are layout. The design fixes their text, and no requirement here does. The same holds for the details card in the publish dialog.

The page header's action, **Create journey**, opens `/journeys/new`. When the browser holds classic drafts for the viewer, the page shows the [move banner](#moving-browser-drafts-to-the-server).

Each published row has an action menu with Open, Duplicate, Pause or Resume, and Delete. Each obeys [CMP-FR-07](campaign-management.md#functional-requirements), and an action the viewer may not take is absent, not disabled. Duplicate is open to every staff user. A draft row's menu offers Open and Delete. Each action ends in a toast, and pause and resume update the row in place. Clicking a published journey opens its page. Clicking a draft opens it in the builder.

**A journey's page, `/journeys/[id]`.** A draft opens the builder for its owner. A published journey opens with two tabs, Analytics, the default, and Journey. The header shows the name, the status, the owner, and the last change.

- **Header actions.** The owner or an admin sees **Pause** or **Resume**, **Duplicate to edit**, and **Delete**. Every other staff user sees **Duplicate to edit** only. No page links to the classic builder.
- **Duplicate to edit** creates a draft named "Copy of" and the journey's name, with `origin` `duplicate:<id>`, owned by the viewer, and opens it in the builder. Any staff user may duplicate any published journey, because every staff user can already see every published journey under **All**.
- **Delete** opens a dialog that names the journey and says how many people are waiting in it, as [CMP-FR-19](campaign-management.md#functional-requirements) says.
- **Journey tab.** The read-only canvas, with each node's all-time Completed count from `campaign_node_stats`. It refreshes every 5 seconds, skips a refresh while the browser tab is hidden, and starts the next refresh only after the last one has finished. When a refresh fails, it keeps the last counts and says that they could not refresh (JBD-FR-09). The analytics graph and the builder canvas use the same node cards.

The Analytics tab has:

- A range picker with Today, Last 7 days, Last 30 days, and All time. The first three follow the [studio shell](studio-shell.md#time-ranges). All time has no start.
- A read-only graph of the journey's current nodes. Each node shows its Entered, Waiting, and Completed counts. Hover or keyboard focus on a node shows its branch split.
- A table with one row per node in tree order, depth first, branches in the order of the [branch table](#saved-format): the node's label, Entered, Waiting, Completed, Completed as a percent of Entered, and the branch split.
- Under the graph, the note "Not available: messages delivered, opened or clicked, revenue, and goal conversion." No sender reports delivery, opens, or clicks, and no journey has a goal or a revenue source, so the page shows none of these numbers (JBD-FR-43).
- Under the table, a collapsed list of removed steps. A removed step is a node id with transitions that is not in the current nodes. It has no parent in the current graph, so its count is its own transitions with event time in the range, not an Entered count.

An id that names no published campaign and no draft of the viewer shows "This journey does not exist.", unless the viewer's browser still holds a classic draft with that id, as [Moving browser drafts to the server](#moving-browser-drafts-to-the-server) says. Every staff user may open the analytics of every published journey. In the classic builder, users per node stay limited to the owner or an admin, as [campaign management](campaign-management.md#publish) says.

In the example from [Behavior](#behavior), with Last 7 days: 100 people triggered the setup node in the range. The watch shows Entered 100, Completed 70, and Waiting 30, with the split 40 on `success` and 30 on `timeout`. The End node on `success` shows Entered 40 and Completed 40. The push on `timeout` shows Entered 30 and Completed 30.

### Node labels

v2 names a node by its type and its main setting, read from its `campaign_nodes` row:

| `node_type` | Setting | Label |
|---|---|---|
| `setup` | Kind `event` | "Start:" and the event's display name |
| `setup` | Kind `segment_entry` | "Start: enters" and the segment's name |
| `setup` | Kind `business_event` | "Start:" and the business event's display name |
| `check` | | "Check:" and the event's display name |
| `watch` | | "Wait for" the event's display name, and the limit, such as "Wait for Add to cart, 1 day" |
| `watch` | `DelayPath` | "Wait" and the limit, such as "Wait 2 hours" |
| `segment` | | "Condition split" |
| `engagement` | | The channel, and the title or subject when the node has one, such as `Push "Still thinking about it?"` |
| `end` | | "End" |

An event or segment that no longer exists shows its saved name. A node id that is not in the current nodes shows "Removed step" and its node type. The builder's node cards use the same labels, read from the draft's tree.

### The classic builder until it is removed

Until cutover, the classic builder at `/campaign/[id]` keeps its behavior, and changes only where a module it shares with v2 moved, with its tests unchanged (JBD-FR-24). After cutover its URLs redirect to v2 pages, as the [studio shell](studio-shell.md) says. This section goes when the classic studio is removed ([decision 0037](../architecture/decisions/0037-one-studio-retire-the-classic-studio.md)).

- Drafts live in browser storage, one list for each signed-in user. **Save Draft** saves there. The editable builder shows the status as Draft and offers no status choice.
- Dragging from a node's handle to another node adds an edge. The canvas refuses an edge into the setup node, into a node that already has a parent, or one that would close a cycle. **Align** lays the graph out as a tree.
- Active and paused campaigns open read-only. **Clone to Edit** makes an editable draft copy, for the owner or an admin.
- `/campaign/[id]` opens a published campaign for its owner or an admin, and a draft from this browser. Any other id shows one message for "not found" and "another user owns it", so that it does not reveal that another user's campaign exists.
- **AI Generate** opens a modal that replaces the canvas with a generated journey.
- While a campaign is open, the builder shows the number of users at each node to its owner or an admin, refreshed every 5 seconds, with the same refresh rules as the Journey tab.

## Algorithm

### Node analytics

The input is one campaign `C`, its current `campaign_nodes` rows, and a range `[start, end)` of event time, or all time. An entry is a (`canon_id`, `entry_id`) pair of `C`. A transition of a node on a branch is a row of `user_campaign_state_transitions` with that `campaign_id`, `node_id`, and `branch`.

For each node `N`:

1. The reach set `R(N)`: if `N` is the setup node, the entries with a transition of `N` whose event time is in the range. Otherwise, with `P` the parent of `N` and `b` its `parent_branch`, the entries with a transition of `P` on `b` whose event time is in the range.
2. Entered is the size of `R(N)`.
3. Completed is the number of entries in `R(N)` with a transition of `N` on any branch, at any time up to now.
4. The branch split gives, for each branch of `N`, the number of entries in `R(N)` with a transition of `N` on that branch. A multi-branch check fires every branch that matches, so the split can add up to more than Completed.
5. Waiting is Entered minus Completed.

So Entered counts the entries that reached the step during the range. Completed and Waiting split those same entries by whether they have completed the step by now. The two always add up to Entered. These are the numbers the design calls entered, current, and exited.

A node `N` is a **waiting step** of one entry when the entry has a transition of `N`'s parent on `N`'s `parent_branch` and no transition of `N`. The setup node is never a waiting step. An engagement or End node completes with its parent, so it is waiting only if the engine failed. A person stays at a watch until the deadline, at a check until its trigger arrives, and at a condition split until its conditions hold. A check that never gets its trigger keeps the person waiting there. Only a draft can change its tree (JBD-FR-08), so a published campaign keeps its node ids. Two cases still leave transitions under ids that are not current nodes. End nodes saved before stable End ids got a new id on every save (JBD-FR-12), and rows can predate a manual repair. Those ids show as removed steps. They are never waiting steps, because a waiting step must be a current node.

`campaign_node_stats` counts every entry with a transition of the node. That is Completed over all time, which is why the Journey tab's counts and the analytics' All time Completed agree. [Decision 0035](../architecture/decisions/0035-compute-journey-analytics-from-transitions-on-read.md) explains why v2 computes these numbers from the transitions on read.

Worked example. A journey has setup `S`, a watch `W` under `S` on `next`, and End `E1` under `W` on `success`. In the range, 3 entries complete `S`. Entry 1 completes `W` on `success` and then `E1`. Entry 2 completes `W` on `timeout`. Entry 3 has no transition of `W`. Then `S` shows Entered 3 and Completed 3. `W` shows Entered 3, Completed 2, Waiting 1, and the split 1 `success` and 1 `timeout`. `E1` shows Entered 1 and Completed 1. Entry 3's waiting step is `W`.

## Functional requirements

| Id | Requirement |
|---|---|
| JBD-FR-01 | The builder must offer the node types, path types, and channels listed in [Node types](#node-types). |
| JBD-FR-02 | Every field that an editor shows must be saved in the tree and restored when the journey is loaded. Loading a saved journey must give back the same canvas. |
| JBD-FR-03 | Every field the runtime needs must be written to the node rows: the trigger, the conditions, the path type with a watch's limit and a multi-branch check's branches, and actions. |
| JBD-FR-04 | `parent_branch` must follow the table in [Saved format](#saved-format). |
| JBD-FR-05 | Setup, check, and watch nodes must have a trigger. Only a setup node may use the kinds `segment_entry` and `business_event`. Filters must test only attributes of the trigger's event, or of the behavior condition's event that they narrow. |
| JBD-FR-06 | The condition editor must offer only operators that fit the attribute's type. |
| JBD-FR-07 | Changing a path type must delete the subtrees of the removed branches. Deleting a node must follow JBD-FR-42. The setup node must not be deletable. |
| JBD-FR-08 | Active and paused campaigns must open read-only. |
| JBD-FR-09 | The Journey tab of a published journey must show each node's all-time Completed count from `campaign_node_stats`, refreshed every 5 seconds, skipping a refresh while the browser tab is hidden, and keeping the last counts when a refresh fails. |
| JBD-FR-10 | Each node type must open its own editor. |
| JBD-FR-11 | The journey must stay a tree under the setup node: one parent for every other node, and no cycle. The builder must offer no free edge, and every insert must attach the new node to a parent. Saving or publishing a tree that breaks this must fail with a message that names the node. |
| JBD-FR-13 | Filters and conditions must be saved as groups. Every group must pass, and a group passes when any of its conditions passes. A group must not be empty. |
| JBD-FR-14 | A behavior condition must state its event, measure, window, operator, and value, and the attribute when the measure reads one. The builder must not ask the marketer for a metric id. |
| JBD-FR-15 | A `segment_entry` trigger must name an existing segment and carry a re-entry setting, `never` unless the marketer picks another. The builder offers it once customer decision starts journeys on segment entry, through the runtime registry (JBD-FR-31). |
| JBD-FR-16 | A `business_event` trigger must name a catalog business event and one audience. An interest must name a catalog person event, a `match` attribute of it, a `min_count` of at least 1, and a window. An exclusion must name a catalog person event and its `match` attribute. A segment audience must name an existing segment. |
| JBD-FR-17 | A `segment_membership` condition must name an existing segment and the operator `in` or `not_in`. The builder offers it once customer decision evaluates segment membership, through the runtime registry (JBD-FR-31). |
| JBD-FR-12 | Saving the same tree again must write the same `node_id` for every node. An End node's `node_id` depends on the nodes above it, so it changes when the tree above it changes: a parallel sibling added to its branch renames `check_1-yes-end` to `check_1-yes-0-end`, and a node inserted above it renames it after the new parent. Only a draft can change the tree (JBD-FR-08), so a running journey keeps its End ids. |
| JBD-FR-18 | `/journeys` must list the published journeys and the viewer's own drafts from `journey_drafts`, with the columns, search, filters, and sorts of [Journey pages](#journey-pages). The owner filter must default to **Mine**, and **All** must show every published journey to every staff user. A draft must show only to its owner, and only under **Mine**. |
| JBD-FR-19 | `/journeys/[id]` must show, for every staff user, each current node's Entered, Waiting, Completed, and branch split, computed as [Node analytics](#node-analytics) says, in a graph and in a table. |
| JBD-FR-20 | Journey analytics must offer Today, Last 7 days, Last 30 days, and All time, and Today to Last 30 days must follow the [studio shell](studio-shell.md#time-ranges) rules. |
| JBD-FR-21 | Journey analytics must list removed steps, with their completed counts in the range, apart from the current nodes. |
| JBD-FR-22 | v2 must label nodes as [Node labels](#node-labels) says, and must not show a node id as a node's main label. |
| JBD-FR-23 | Pause, resume, and delete on the journey pages must follow [CMP-FR-07](campaign-management.md#functional-requirements), and a control the viewer may not use must be absent. **Duplicate to edit** must show to every staff user on every published journey. **Create journey** must open `/journeys/new`. No journey page may link to the classic builder. |
| JBD-FR-24 | The journey pages of studio v2 must write only through this contract's draft actions, which write `journey_drafts`, and through campaign management's actions. Until cutover, the classic builder must change only where a module it shares with v2 moved, with its tests unchanged. |
| JBD-FR-25 | The builder must list every publish problem at once, in tree order, each with its node and field, and must refuse to publish while a blocking one remains. The browser and the server must run the same validator. |
| JBD-FR-26 | A draft must be saved on the server within 2 seconds of the last edit. A save against a newer version must not overwrite it without the marketer's choice. |
| JBD-FR-27 | Publish must read the draft from `journey_drafts` and, in one transaction, write the campaign under the draft's id, record the draft id and the hash of the stored root in `journey_publishes`, and delete the draft. A publish that names a version older than the stored draft's must write nothing and offer **Load latest**, which is the lead's default, pending owner review. A repeated publish of the same draft must succeed without writing the campaign again. A campaign with that id from any other source must be refused as a collision, with an offer to publish under a new id. Publishing under a new id must write the campaign, record the old draft id with the new campaign id in `journey_publishes`, and delete the draft in one transaction, and its reply must carry the new id. |
| JBD-FR-28 | Drafts found in this browser must be offered for a move to the server. The move must be safe to repeat, must import a colliding id under a new id, must strand no draft that parses, and must keep a browser copy that the classic builder does not read. |
| JBD-FR-29 | `/journeys/new` must offer a blank start, a template start, and, when a model is configured, a describe-it start. Each must create a draft owned by the viewer, with the matching origin. A template start must create the draft even when an event it needs has no catalog match, and the checklist must block publish until it has one. That rule is the lead's default, pending owner review. |
| JBD-FR-30 | Every built-in template must pass publish validation, with its events mapped, in the test suite. Template message content must be in Vietnamese and use SMS or push. Template events must use the catalog's system names. Abandoned cart must wait for `com.acme/order_completed` for 2 hours, end on success, and on timeout send the push "Bạn quên giỏ hàng?", wait 1 day, send an SMS, and end. |
| JBD-FR-31 | The builder must not offer a trigger kind, condition type, or editor option that the runtime does not evaluate. A saved one must load read-only with a note, and must block publish. The runtime registry must add `segment_membership`, then `segment_entry`, then event filters in segment mode, then size from tracked members, then **Also include current members** and size with imported-only members in either order, each once its runtime change runs on the cluster. |
| JBD-FR-32 | Publishing a journey whose setup node starts on entering a segment must offer **Also include current members**, off by default. With it on, publish must request that every tracked member of the segment at publish time enter once. With it off, only people who enter after publish may start the journey. The dialog must name the segment and its tracked member count. The owner decided this on 2026-11-08. |
| JBD-FR-40 | The profile field picker must list imported fields grouped by source, with the display names and types in [Conditions](#conditions), and must save each as `<source>.<name>`. Publish must reject a condition whose imported field names no attribute column of a profile record type's current version and no enabled imported metric, and must name the node. |
| JBD-FR-41 | For a `datetime` profile field, the condition editor must offer `more_than_days_ago` and `within_last_days` with a whole number of days of at least 1, and must not offer them for filters. |
| JBD-FR-42 | Deleting a one-path step (setup excepted) must remove only that step, with no dialog, and attach its children to its parent on the branch it hung from. Deleting a branching step (a check, a watch with an event, or a condition split) must remove its subtree after a dialog that names how many steps go. |
| JBD-FR-43 | The Analytics tab must say "Not available: messages delivered, opened or clicked, revenue, and goal conversion." and must show no number for any of them. |
| JBD-FR-44 | The publish checklist must show, as a warning that does not block publish, each behavior condition that can never match, such as "did `com.acme/order_completed` 0 times in the last 30 days". The warning names the step and says "Replace or remove it." |

## Non-functional requirements

| Id | Requirement |
|---|---|
| JBD-NFR-01 | Only a signed-in user can open the builder. See [admin authentication](admin-authentication.md). |
| JBD-NFR-02 | A draft lives on the server, in `journey_drafts`, until it is published or deleted. Clearing browser data does not touch it. |
| JBD-NFR-03 | Journey analytics must load within 2 seconds at the 95th percentile for Last 30 days on the deployed database. [Decision 0035](../architecture/decisions/0035-compute-journey-analytics-from-transitions-on-read.md) says what happens when it does not. |

## Interfaces

| Direction | Interface | Contract |
|---|---|---|
| UI | `/journeys/new` | Start a journey: blank, template, or describe it |
| UI | `/journeys` | The journey list, with lifecycle actions and the browser-draft banner |
| UI | `/journeys/[id]` | A draft opens the builder. A published journey opens Analytics and Journey tabs. |
| UI | `/journeys/[id]?range=today`, `7d`, `30d`, or `all` | Journey analytics |
| UI | `/campaign/[id]` | The classic canvas, until cutover |
| In | `POST /api/generate-journey` | The describe-it start. [AI journey generation](ai-journey-generation.md#interfaces) defines it. |
| Read | `journey_drafts` | The viewer's drafts |
| Read | `user_campaign_state_transitions` | Node analytics: `campaign_id`, `canon_id`, `entry_id`, `node_id`, `branch`, `event_timestamp` |
| Read | `campaign_nodes` | The current nodes, their parents and branches, and their labels |
| Read | `campaigns` | The tree of a published campaign, for the Journey tab and for duplicates |
| Read | `campaign_node_stats` | Completed counts on the Journey tab |
| Read | `user_events`, `user_event_fields` | Event and attribute pickers, and the template event mapping. The event's kind decides which trigger list offers it. |
| Read | `segments` | Segment pickers for entry triggers, segment audiences, and `segment_membership` conditions |
| Read | `import_record_types`, `import_record_type_versions`, `import_metric_definitions` | Imported fields for the profile field picker |
| Write | `journey_drafts` | Create, autosave with a version check, and delete. Publish deletes the row. |
| Read and write | Browser storage `auroracy_campaigns:<userId>` and `auroracy_campaigns_moved:<userId>` | The move reads the first key and moves entries to the second. The classic builder writes the first key until cutover. |

[Campaign management](campaign-management.md) writes `campaigns`, `campaign_nodes`, and `journey_publishes` when the marketer publishes. [The data model](../architecture/data-model.md) lists the columns of `journey_drafts` and `journey_publishes`.

## Failure handling

| Case | Behavior |
|---|---|
| The catalog has no events | The trigger list is empty and the checklist says the journey needs a trigger event. |
| The id names no journey the viewer may open | The page says "This journey does not exist." It does not open a blank canvas. |
| Node counts fail to load | The canvas shows the last counts, says that they could not refresh, and keeps working. |
| An autosave fails | The header shows "Not saved. Retry". The edit stays in memory. Leaving the page shows the browser's leave-page prompt. |
| An autosave meets a newer version | Nothing is overwritten. The builder offers **Load latest** and **Keep mine**. |
| The server action no longer exists after a rolling restart | The builder shows "Studio was updated. Reload to keep editing", with a copy of the unsaved tree to the clipboard. |
| Publish finds a campaign with the draft's id from another source | Nothing is written. The dialog offers **Publish as a new journey**. |
| Publish finds no draft and no campaign | Nothing is written. The dialog says "This draft no longer exists". |
| Publish finds no draft, and a campaign with the draft's id that no `journey_publishes` row links to this draft | Nothing is written. The dialog says "This draft no longer exists". |
| Publish finds a `journey_publishes` row that names the draft id under another campaign | Nothing is written. The builder opens that campaign. |
| Describe it fails or is over the rate limit | `/journeys/new` shows the message inline. No draft is created. |
| A template needs an event the catalog lacks | The mapping dialog flags that event, and still creates the draft. The checklist blocks publish until the event is in the catalog or replaced. |
| Publish names a version older than the stored draft's | Nothing is written. The dialog says "This draft changed somewhere else" and offers **Load latest**. |
| A browser draft does not parse | It stays in the browser, and the move's report gives the parse error. |

## Acceptance criteria

- Given a condition split with the behavior condition "`purchase` `COUNT` >= 2 in the last 30 days", when the journey is saved and reloaded, then its editor shows the same event, measure, window, operator, and value. (JBD-FR-02, JBD-FR-14)
- Given the same condition split, when it is published, then its `campaign_nodes` row holds that condition in `conditions_json` with a `metric_id` added, and its `trigger_json` is null. (JBD-FR-03, JBD-FR-14)
- Given a condition split with no behavior condition, when the journey is published, then publish fails and names its place in the tree. (JBD-FR-03)
- Given the runtime registry holds `segment_entry`, and a setup node that starts on entering "Hanoi cart builders" with re-entry after 30 days, when it is published, then its `trigger_json` holds `kind` `segment_entry`, the segment id, and that re-entry setting. (JBD-FR-15)
- Given the runtime registry holds `business_event`, and the `price_drop` trigger in [Trigger kinds](#trigger-kinds), when it is published, then its `trigger_json` holds the interest unchanged. (JBD-FR-16)
- Given a check whose trigger is a `business_event`, when the journey is published, then publish fails and names the check. (JBD-FR-05)
- Given the runtime registry holds `business_event`, and an interest with `min_count` 0, or a segment audience that names no existing segment, when the journey is published, then publish fails and names the field. (JBD-FR-16)
- Given the runtime registry holds `segment_membership`, and a check with the condition "is not in Hanoi cart builders", when it is published, then its `conditions_json` holds a `segment_membership` condition with `op` `not_in`. (JBD-FR-17)
- Given a multi-branch check with branches `vip` and `regular`, when it is published, then its `paths_json` holds both branches, and `vip` holds its filters. (JBD-FR-03)
- Given a watch with `SuccessOrTimeoutPath`, then its children are saved with `parent_branch` `success` and `timeout`. (JBD-FR-04)
- Given a setup node on `com.acme/view_product` with the filters `product.price > 500000` or `product.brand = Auroracy` in one group, when it is published, then its `trigger_json` holds the event `com.acme/view_product` and one group with both filters. (JBD-FR-05, JBD-FR-13)
- Given a check whose conditions are `city IN [Hanoi, Ho Chi Minh City]` and "`com.acme/add_to_cart` `COUNT` >= 3 in 7 days" in separate groups, when it is published, then its `conditions_json` holds two groups. (JBD-FR-13)
- Given a condition group with no conditions, when the journey is published, then publish fails and names the node. (JBD-FR-13)
- Given a check without a trigger event, when the journey is published, then publish fails and names the node. (JBD-FR-05)
- Given a filter "`product.name` contains `iphone`", when it is published, then the filter holds `LIKE` with `%iphone%`, and reloading shows "contains" with `iphone`. (JBD-FR-02, JBD-FR-03)
- Given a filter "`product.name` contains" with no text, when it is published, then publish fails and names the filter's place in the tree. (JBD-FR-03)
- Given a filter saved by an older build as `LIKE` with `iphone`, when it is loaded, then the editor shows "matches exactly" with `iphone`, and saving keeps `LIKE iphone`. (JBD-FR-02)
- Given a condition split, then its editor offers only the Yes path. (JBD-FR-01)
- Given a condition split saved by an older build with `YesOrNoPath` and a node on No, when it is loaded, then the No node is still there and the editor warns that it never runs. When the marketer picks **Yes Only**, the No node is deleted. (JBD-FR-02, JBD-FR-07)
- Given an SMS step saved by an older build with a phone, when the journey is loaded or published, then it loads and its `action_json` has no phone. (JBD-FR-02)
- Given a check with `YesOrNoPath` and two steps on No, when the marketer switches it to `YesPath`, then a dialog says "This removes the No branch and its 2 steps", and confirming deletes the `no` subtree. (JBD-FR-07)
- Given an active journey, when any staff user opens its Journey tab and selects a node, then the side panel is read-only, and the only edit control is **Duplicate to edit**. (JBD-FR-08, JBD-FR-23)
- Given a `datetime` attribute, then the condition editor offers "equals", "does not equal", "is on or after", "is after", "is on or before", and "is before", and no other operator. (JBD-FR-06)
- Given a check on "`order.created_at` is on or before 2026-10-01", when it is published, then the filter in its `trigger_json` holds `<=` with `2026-10-01`, and an event at 2026-10-01T10:00:00Z passes it. (JBD-FR-03, JBD-FR-06)
- Given an enabled imported metric `spend_90d` on `orders`, when the marketer opens a check's profile field picker, then it lists **Orders > Spend, last 90 days**, and choosing it saves `orders.spend_90d`. (JBD-FR-40)
- Given a draft check on `orders.spend_90d`, when `spend_90d` is deleted and the journey is published, then publish fails and names the node. (JBD-FR-40)
- Given a check with "`orders.last_order_at` more than 60 days ago", when it is published, then its `conditions_json` holds `op` `more_than_days_ago` and `value` 60. Given a filter on a `datetime` event attribute, then the editor does not offer the relative-date operators. (JBD-FR-41)
- Given a draft with setup, check, and push, then the builder offers no way to draw an edge between two existing nodes, and a node inserted from the palette, by a drop on an edge, or from "+" has exactly one parent. (JBD-FR-11)
- Given a stored draft whose tree gives a node two parents, when it is published, then publish fails and names the node. (JBD-FR-11)
- Given a published campaign with a check whose Yes branch ends, when it is paused and resumed, then the End node keeps its `node_id` and its count in `campaign_node_stats`. (JBD-FR-12)
- Given an editor who owns one journey, when she opens `/journeys`, then **Mine** lists it. When she picks **All**, the list also shows the journeys of other users. (JBD-FR-18)
- Given a draft in `journey_drafts` that the viewer owns, then it shows under **Mine** and not under **All**. Given a draft another user owns, then no list of the viewer shows it, and opening its id says "This journey does not exist." (JBD-FR-18)
- Given the transitions of the [node analytics worked example](#node-analytics), then the analytics show `W` with Entered 3, Completed 2, Waiting 1, and 1 `success` and 1 `timeout`. (JBD-FR-19)
- Given a multi-branch check where one entry fired `vip` and `regular`, then the check's Completed is 1 and its split shows 1 on each branch. (JBD-FR-19)
- Given an entry whose parent transition has an event time before the range and whose node transition falls in the range, then that node's Entered does not count it. (JBD-FR-19, JBD-FR-20)
- Given All time, then each node's Completed equals its `user_count` in `campaign_node_stats`. (JBD-FR-19, JBD-FR-20)
- Given transitions of an End node id that is not in the current nodes, then it shows under removed steps with its count. (JBD-FR-21)
- Given a watch on `com.acme/add_to_cart` limited to 1 day, then its label is "Wait for" the event's display name and "1 day". (JBD-FR-22)
- Given an editor on another user's active journey, then the analytics load, **Duplicate to edit** shows, and **Pause**, **Resume**, and **Delete** are absent from the header and from the row menu. No link on the page opens `/campaign`. (JBD-FR-19, JBD-FR-23)
- Given an id that names no published campaign and no draft of the viewer, and no browser draft with that id, then the page says "This journey does not exist." (JBD-FR-19)
- Given **Create journey** on `/journeys`, then it opens `/journeys/new`. (JBD-FR-23)
- Given a viewer who uses every control on the v2 journey pages, then rows change only in `journey_drafts` and in the tables campaign management's actions write. Until cutover, every classic builder test passes unchanged. (JBD-FR-24)
- Given a deployed database with 30 days of transitions, then journey analytics for Last 30 days load within 2 seconds at the 95th percentile, or the result of decision 0035's check is recorded. (JBD-NFR-03)
- Given a published journey open on its Journey tab, when `campaign_node_stats` changes, then the node counts update within 5 seconds. While the browser tab is hidden, no refresh runs. When a refresh fails, the last counts stay and the page says they could not refresh. (JBD-FR-09)
- Given a draft with a watch that has no event and a check with an empty group, then the checklist lists both problems in tree order, each with its node and field, and the publish dialog's confirm button is disabled. **Go to** on the watch's problem opens its panel with the event field focused. (JBD-FR-25)
- Given a draft whose only problem is a condition split's No branch saved by an older build, then the checklist shows a warning and publish is allowed. (JBD-FR-25)
- Given the browser's validator and the server's validator on the same fixture trees, then both return the same problems. (JBD-FR-25)
- Given an edit in the builder, then the draft row in `journey_drafts` holds it within 2 seconds, and its `version` is one higher. (JBD-FR-26)
- Given a draft open in two tabs, when tab A saves and then tab B saves, then tab B's save is refused, the stored draft keeps tab A's edit, and tab B shows "This draft changed somewhere else" with **Load latest** and **Keep mine**. **Keep mine** stores tab B's tree with a new version. **Load latest** shows tab A's tree. (JBD-FR-26)
- Given a save that fails, then the header shows "Not saved. Retry" and the edit is still on the canvas. (JBD-FR-26)
- Given an open builder whose server action no longer exists after a rolling restart, when it saves, then it shows "Studio was updated. Reload to keep editing" and offers to copy the unsaved tree. (JBD-FR-26)
- Given a draft `CAMP-1111111111111111` with no campaign of that id, when it is published, then `campaigns` has a row with that id, `journey_publishes` has a row with that campaign id, that draft id, and the hash of the stored root, the draft row is gone, and `/journeys/CAMP-1111111111111111` opens the published journey. (JBD-FR-27)
- Given a publish that committed but whose reply was lost, when the builder retries it, then it reports "Already published", writes nothing, and opens the journey. (JBD-FR-27)
- Given a draft and a campaign of the same id with a `journey_publishes` row for that draft id and the same root hash, when publish runs, then it deletes the draft and writes nothing else. (JBD-FR-27)
- Given a draft whose id the classic builder has since published, when publish runs, then nothing is written, and the dialog says "A journey with this id was published somewhere else" and offers **Publish as a new journey**. Choosing it publishes the draft under a fresh id and leaves the classic campaign unchanged. (JBD-FR-27)
- Given draft `CAMP-2222222222222222` that **Publish as a new journey** published as `CAMP-3333333333333333`, and whose reply was lost, when the builder retries either publish of `CAMP-2222222222222222`, then nothing is written, and the builder opens `CAMP-3333333333333333`. (JBD-FR-27)
- Given **Publish as a new journey** whose transaction fails after it wrote the new campaign row, then no campaign with the new id exists, no `journey_publishes` row was added, and the draft still has its old id. (JBD-FR-27)
- Given no draft `CAMP-4444444444444444`, a classic campaign with that id, and no `journey_publishes` row that names draft `CAMP-4444444444444444`, when publish of that draft runs, then nothing is written, and the dialog says "This draft no longer exists". (JBD-FR-27)
- Given a publish request whose browser tree differs from the stored draft, then the published `campaigns.root` equals the stored draft's root. (JBD-FR-27)
- Given the runtime registry holds entry 6 and a draft that starts on entering "Hanoi cart builders", which has 1,240 `segment_members` rows, when the marketer opens the publish dialog, then **Also include current members** is off and the dialog names the segment and 1,240. Publishing with it off writes no `current_member_entries` row. Publishing with it on writes one, for the new campaign, its graph version, and the segment. (JBD-FR-32, CMP-FR-20)
- Given a draft that starts on an event, then the publish dialog offers no **Also include current members**. Given a registry without entry 6, then no draft is offered it. (JBD-FR-32, JBD-FR-31)
- Given a publish with **Also include current members** on, whose reply was lost, when the builder retries it, then no second `current_member_entries` row is written. (JBD-FR-32, JBD-FR-27)
- Given a draft at version 7 and a publish that names version 6, when publish runs, then nothing is written, the draft stays at version 7, and the dialog says "This draft changed somewhere else" with **Load latest**. (JBD-FR-27)
- Given a draft with `origin` `duplicate:<id>` of an active journey that the viewer owns, when it is published, then the success dialog asks to pause the original. Confirming sets the original to `paused`. (JBD-FR-27, CMP-FR-09)
- Given an editor with three classic drafts in this browser, when she opens `/journeys`, then the banner says 3 drafts are saved only in this browser. When she chooses **Move drafts**, then `journey_drafts` holds all three with `origin` `browser` and her as owner, and the browser moves them to `auroracy_campaigns_moved:<userId>`. (JBD-FR-28)
- Given a move that inserted two drafts and stopped before the browser moved them, when the move runs again, then it writes nothing for those two and moves them to the backup key. (JBD-FR-28)
- Given a browser draft whose id is taken by a campaign or by another user's draft, when it is moved, then it is inserted under a new id with `origin` `duplicate:<old id>`, and the report names the new id. (JBD-FR-28)
- Given a browser draft that does not parse, when the move runs, then it stays under `auroracy_campaigns:<userId>` and the report gives the parse error. (JBD-FR-28)
- Given the classic builder after a move, then its list does not show the moved drafts. (JBD-FR-28)
- Given a deployment with a model configured, then `/journeys/new` offers **Start blank**, **Describe it**, and the template gallery. **Start blank** creates a draft with one setup node and `origin` `blank`, owned by the viewer, and opens it. Given no model configured, then **Describe it** is absent. (JBD-FR-29)
- Given a describe-it request that the route answers with a journey, then a draft with `origin` `ai` holds that journey and opens. Given a request refused with `429`, then the page shows the message inline and `journey_drafts` gains no row. (JBD-FR-29)
- Given the Abandoned cart template, then its setup node triggers on `com.acme/add_to_cart`, its next node is a watch for `com.acme/order_completed` limited to 2 hours, the `success` branch ends, and the `timeout` branch holds, in order, a push titled "Bạn quên giỏ hàng?", a `DelayPath` watch of 1 day, an SMS, and an End node. The gallery card reads "Needs: Added to cart, Order completed". (JBD-FR-30)
- Given a draft setup, check, Yes: Wait for time 1 day, SMS, End, when the marketer deletes the wait, then no dialog shows, the SMS hangs from the check on `yes`, and the tree has one parent per node. When she deletes the check, then a dialog says it removes the check and 3 steps below, and confirming leaves only the setup node. (JBD-FR-42, JBD-FR-11)
- Given a published journey, when any staff user opens its Analytics tab, then it shows the "Not available" note and no delivered, opened, clicked, revenue, or goal number. (JBD-FR-43)
- Given a draft whose Check step tests "did `com.acme/order_completed` 0 times in the last 30 days", when the editor opens the publish checklist, then it shows a warning on that step that ends "Replace or remove it.", and publish stays allowed. (JBD-FR-44)
- Given the Abandoned cart template and a catalog with `com.acme/add_to_cart` and `com.acme/order_completed`, when the marketer chooses it, then the dialog prefills both mappings and, after a name, creates a draft with `origin` `template:<key>`. (JBD-FR-29)
- Given the Abandoned cart template and a catalog with `com.acme/add_to_cart` and no `com.acme/order_completed`, when the marketer leaves `com.acme/order_completed` unmapped, then the draft is created, the checklist lists a blocking problem on each node that names `com.acme/order_completed`, and publish is refused. (JBD-FR-29, JBD-FR-25)
- Given the test suite, then every built-in template parses as a draft and, with its events mapped to fixture catalog events, passes the full publish validation, every message step uses SMS or push, and the text of every message step holds at least one Vietnamese letter with a diacritic, such as `ă`, `ê`, `ơ`, or `ư`. (JBD-FR-30)
- Given the runtime registry holds `segment_entry`, when the marketer picks "enters a segment", then the Setup panel shows the note "People already in this segment when you publish start only after they leave it and come back, unless you include current members when you publish." (JBD-FR-15)
- Given a runtime registry without `segment_entry`, then the palette's Start group offers no Segment entry. Given a draft that already uses a `segment_entry` trigger, then it loads, the trigger shows read-only with a note, and the checklist lists a blocking problem on the setup node. (JBD-FR-31, JBD-FR-15)
- Given a runtime registry without `segment_membership`, then the condition editor's field picker offers no segment membership. (JBD-FR-31, JBD-FR-17)
- Given any registry state, then neither the palette nor the trigger picker offers `business_event`, and no new behavior condition offers the measure `INACTION`. A saved `INACTION` condition loads and the checklist shows a warning on it. (JBD-FR-31, JBD-FR-25)
- Given an editor who does not own a published journey, when she chooses **Duplicate to edit**, then a draft "Copy of" the journey's name, with `origin` `duplicate:<id>` and her as owner, opens in the builder. (JBD-FR-23, CMP-FR-09)
- Given a draft, then its id stays the same from its first save until it is published, and the campaign has that id. (JBD-FR-27)

## Open questions

- Which day does a date in a datetime condition mean? Today it is the whole day in UTC. The alternative is a tenant time zone. Pending owner review. See the same question in [customer decision](../architecture/components/customer-decision.md#open-questions).
- Should an unknown id and another user's journey or draft share one "not found" message? Today they do, so the page does not reveal that the journey exists. The alternative is a separate "you do not have access" message. Pending owner review.
- Should the editable builder offer a status choice? Today it shows Draft only, and Publish activates. The alternative is a status choice that publishes or pauses on save, which would duplicate the journey list. Pending owner review.
- Should an End node have settings, such as a goal? Today its editor has none, and every End saves `goal_default` unless the stored tree names another goal. The alternative is a goal field. Pending owner review.
- Can a running journey be edited in place? Today the marketer duplicates it, publishes the copy, and pauses the original. Editing in place needs a runtime decision about people already waiting in steps that change. The default, which the builder follows, is duplicate to edit with the prompt to pause the original. Pending owner review.
- May admins open other people's drafts? The default, which the builder follows, is no. A draft is private to its owner, and admins see published journeys only. Pending owner review.

The question "should drafts be stored on the server" is answered. They are, in `journey_drafts` ([decision 0036](../architecture/decisions/0036-store-journey-drafts-on-the-server-outside-cdc.md)).

## Related

- [Campaign management](campaign-management.md)
- [Studio shell](studio-shell.md)
- [Home overview](home-overview.md)
- [Segments](segments.md)
- [AI journey generation](ai-journey-generation.md)
- [Business event fan-out](../architecture/components/business-event-fan-out.md)
- [Customer decision](../architecture/components/customer-decision.md)
- [Journey execution](../architecture/components/journey-execution.md)
- [Data model](../architecture/data-model.md)
- [0009. Compute node stats as a view](../architecture/decisions/0009-compute-node-stats-as-a-view.md)
- [0029. Model a rule as a trigger and person conditions](../architecture/decisions/0029-model-a-rule-as-a-trigger-and-person-conditions.md)
- [0035. Compute journey analytics from the transitions on read](../architecture/decisions/0035-compute-journey-analytics-from-transitions-on-read.md)
- [0036. Store journey drafts on the server, outside CDC](../architecture/decisions/0036-store-journey-drafts-on-the-server-outside-cdc.md)
- [0037. One studio: retire the classic studio](../architecture/decisions/0037-one-studio-retire-the-classic-studio.md)
- [0038. Store segment membership and evaluate every segment](../architecture/decisions/0038-store-segment-membership-and-evaluate-every-segment.md)
- [Data import](data-import.md)
- [0041. Imported data reaches conditions as profile attributes](../architecture/decisions/0041-imported-data-reaches-conditions-as-profile-attributes.md)
- [Known issues](../known-issues/features/journey-builder.md)
