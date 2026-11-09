---
title: Store journey drafts on the server, outside CDC
id: "0036"
status: accepted
date: 2026-11-08
tags: [studio, studio-v3, journeys, drafts, cdc]
supersedes: []
superseded_by: []
---

# 0036. Store journey drafts on the server, outside CDC

## Context

The classic builder keeps a journey's draft in the browser's `localStorage`, under `auroracy_campaigns:<userId>`. A draft is lost when the marketer clears the browser or switches machines, and two tabs overwrite each other without warning. A journey reaches the server only at publish, when the browser sends its whole tree.

Studio v3, a design the owner approved on 2026-11-08, moves every write into the v2 studio and adds a builder that autosaves ([decision 0037](0037-one-studio-retire-the-classic-studio.md)). Both builders stay live until cutover, so a draft can exist in a browser while the v2 builder edits drafts on the server, and the classic builder can publish an id the v2 builder also holds.

Published journeys live in `campaigns` and `campaign_nodes`. Each of those tables has its own CDC publication (`campaigns_pub`, `campaign_nodes_pub`), and customer decision and journey execution read them through those streams. In #320 the replication slots held 6 MB/s of WAL until disk ran low, so any new write to a published table, and any new kind of row that consumers must learn to skip, has a cost.

## Decision

Drafts get their own table, `journey_drafts`, and each publish leaves one row in a new table, `journey_publishes`. Neither table joins a CDC publication.

- **One id for life.** A draft's id is the future campaign id. Publish writes the campaign under the draft's id, so `/journeys/[id]` stays the same URL from the first save to analytics.
- **Versioned autosave.** Each draft row has an integer `version`. A save names the version it read. A save against a newer version is refused, and the marketer chooses to load the newer draft or overwrite it with a new version. The server never merges two versions silently.
- **Publish reads the stored draft.** The server publishes the row in `journey_drafts`, not a tree sent from the browser. In one transaction it writes the campaign, its node rows, its metric definitions, and a `journey_publishes` row with the draft id and a hash of the stored root, and it deletes the draft.
- **Retry and collision rule.** Publish decides from what it finds, so a retry converges and a clash with another publisher writes nothing. A `journey_publishes` row that names the draft id under another campaign id means the draft was published as a new journey, so publish writes nothing and opens that campaign. Otherwise this table decides:

| Draft row | Campaign with that id | Result |
|---|---|---|
| Present | None | Publish |
| Absent | Present, with a `journey_publishes` row for this draft id | Already published. Write nothing. |
| Present | Present, with a `journey_publishes` row for this draft id and the same root hash | Already published. Delete the leftover draft. |
| Present | Present, any other way | Collision. Write nothing. Offer to publish the draft under a new id. |
| Absent | Present, with no `journey_publishes` row for this draft id | The draft no longer exists. Write nothing. |
| Absent | None | The draft no longer exists |

- **Publishing under a new id is one transaction.** It writes the campaign under a fresh id, records the old draft id with the new campaign id in `journey_publishes`, and deletes the draft. Its reply carries the new id.
- **Browser drafts move once.** A draft found in the browser is imported under its own id when the id is free, counts as already moved when the same owner already has a draft with that id, `origin = browser`, and the same root, and is imported under a new id with `origin = duplicate:<old id>` when its id collides with any other draft or campaign. The browser then moves the imported entries to a backup key that the classic builder does not read.

The classic publish path stays frozen. It does not read `journey_publishes`. The collision rule and the browser import cover every way a classic edit can meet a v2 draft.

The design writer proposed separate tables, the lead made the retry and collision call and the browser-import collision call, and the owner approved the design on 2026-11-08.

## Why

**Separate tables keep CDC consumers unaware of drafts.** A `draft` status in `campaigns`, or a draft column on it, would put every autosave on the `campaigns_pub` stream. Each consumer would have to learn to skip drafts, and one that did not would load a half-built journey as a rule. That hidden coupling is how #280 happened. A table outside every publication adds no WAL that a consumer decodes.

**The autosave WAL is small.** An autosave writes one row of a few KB at most once a second per open builder. Ten open builders write about 50 KB/s (estimate), under 1% of the 6 MB/s measured in #320. A replication slot still retains this WAL, because a slot holds all WAL, but the volume does not change the slot's risk.

**One id for life removes a mapping.** If drafts had their own ids, every link, every browser import, and every collision check would need a draft-to-campaign map. With one id, the collision check is a lookup by primary key.

**The publish record makes retries safe.** A publish can fail after the transaction commits and before the browser hears back, such as during a rolling restart. Without a record, the retry finds a campaign with its id and cannot tell its own earlier publish from a classic publish of the same id. `journey_publishes` answers that question with the draft id and the root hash.

**Move, not copy.** A copy would leave the same draft editable in both builders, and the two versions would drift with no way to reconcile them. The backup key keeps a rollback path if the v2 builder has to be pulled.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| A `draft` status and a `draft_id` column in `campaigns` | Saves two tables, but every autosave reaches `campaigns_pub`, and every consumer must learn to ignore drafts. |
| Keep drafts in the browser | Loses drafts, cannot autosave across machines, and leaves publish trusting a tree from the browser. |
| Drafts with their own id, mapped to a campaign id at publish | Changes the URL at publish and needs a mapping table for links, imports, and collisions. |
| Publish without a publish record, treating any existing campaign as "already published" | A classic publish of the same id would be taken as success, and the v2 draft would be deleted with its edits. |
| Last write wins on autosave | Two tabs or two machines silently overwrite each other. |
| Copy browser drafts to the server and leave them in the browser | The same draft becomes editable in two builders and forks. |

## Consequences

- `journey_drafts` and `journey_publishes` are new tables in the schema file and join no publication. The [data model](../data-model.md) lists them.
- The [journey builder](../../features/journey-builder.md) contract owns autosave, the version check, the browser import, and the publish checklist. [Campaign management](../../features/campaign-management.md) owns the publish transaction, now with the `journey_publishes` row.
- A published journey cannot be edited in place. Editing means duplicating it to a new draft.
- The browser import code stays one release past the removal of the classic studio, then goes ([decision 0037](0037-one-studio-retire-the-classic-studio.md)).
- Drafts are private to their owner. Whether admins may open other people's drafts is an open question in the builder contract, with "no" as the default.

## Related

- [Journey builder](../../features/journey-builder.md)
- [Campaign management](../../features/campaign-management.md)
- [0013. Apply a campaign save as one change](0013-apply-a-campaign-save-as-one-change.md)
- [0034. Build studio v2 side by side under `/v2` in the same app](0034-build-studio-v2-side-by-side-under-v2.md)
- [0037. One studio: retire the classic studio](0037-one-studio-retire-the-classic-studio.md)
