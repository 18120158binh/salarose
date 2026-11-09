---
title: Customer lookup known issues
contract: ../../features/customer-lookup.md
updated: 2026-11-08
verified_at: 8de15919
---

# Customer lookup known issues

Studio paths are relative to `studio/`.

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| CUS-KI-01 | Minor | No command palette entry starts a search | CUS-FR-03 |
| CUS-KI-02 | Risk | Search and profile latency are not measured | CUS-NFR-01, CUS-NFR-02 |
| CUS-KI-03 | Missing | No search by imported email, phone, or part of a name | CUS-FR-11, CUS-NFR-01 |
| CUS-KI-04 | Missing | No activity timeline, and no store of a person's events | CUS-FR-12 |
| CUS-KI-05 | Missing | No delivery status reaches studio | CUS-FR-13 |
| CUS-KI-06 | Missing | The profile does not list segments, and stored membership does not exist | CUS-FR-14 |
| CUS-KI-07 | Missing | The title shows no name | CUS-FR-04 |
| CUS-KI-10 | Missing | The profile shows no imported attributes, and an imported-only customer has no profile | CUS-FR-40, CUS-FR-41 |

## CUS-KI-01. No command palette entry starts a search

- **Symptom.** The acceptance criterion for CUS-FR-03 starts from the command palette entry **Look up customer "usr_1001"**. The palette does not exist yet, so a marketer can start a search only from the search box or a `/v2/customers?q=` link.
- **Cause.** The studio shell's command palette (SHL-FR-07) is not built. `app/v2/customers/page.tsx` does run the search on load from `?q=`, which is the half of CUS-FR-03 this feature owns.
- **Evidence.** Read from the code. `app/v2/customers/__tests__/pages.test.tsx` covers the `?q=` half.
- **Fix direction.** The palette's customer target opens `/v2/customers?q=<text>`. Delete this entry when it ships.

## CUS-KI-02. Search and profile latency are not measured

- **Symptom.** Nobody has timed a search or a profile region on the deployed database, or read the search plan, so CUS-NFR-01 and CUS-NFR-02 are unverified.
- **Cause.** Each region's reads run through `readOnly(5000)` in `src/features/customer-lookup/model/server.ts`, and each search match is written to read one index (`src/features/customer-lookup/model/queries.ts`). One known gap: the newest user id orders by `updated_at DESC NULLS LAST`, which does not match `idx_ig_canon_latest (canon_id, updated_at DESC)`, so Postgres sorts that person's identity rows. The cost per person is small.
- **Evidence.** Read from the code. Not measured.
- **Fix direction.** Phase 1 verification (V2-19) runs EXPLAIN and times p95 for a person with 1,000 transitions on the cluster.

## CUS-KI-03. No search by imported email, phone, or part of a name

- **Symptom.** The search box finds ids only. An email or a phone finds a person only when it is their user id, matched in its lower-case or `+84` and leading-0 forms. A name finds nobody, so `Lan` does not find Nguyễn Thị Lan. The Email and Phone columns of the result list are empty, and the hint under the box says name search starts once customer lists are imported.
- **Cause.** `customer_attributes` does not exist yet. `searchQuery` in `src/features/customer-lookup/model/queries.ts` reads `identity_graph`, `user_campaign_state_transitions`, and `user_metrics` only, and `searchText` in `src/features/customer-lookup/model/search.ts` builds the user id forms.
- **Evidence.** Read from `infra/db/schema.sql` and the code.
- **Fix direction.** Once data import stores `customer_attributes`, match the same contact forms against the imported email and phone, and a name as a substring without case or diacritics, with an index per match so CUS-NFR-01 holds. A substring match needs a trigram index. Return only masked values, fill the Email and Phone columns, and restore the board's name sentence in the hints. Wait for the owner's answer on which attribute is the name.

## CUS-KI-04. No activity timeline, and no store of a person's events

- **Symptom.** The Activity timeline region reads "Not available" with the reason. It shows no events, no journey entries, and no filter chips.
- **Cause.** No table keeps a person's tracked events. Ingestion parses each event and passes it on in Kafka. `user_metrics` keeps only bucketed counts, and `user_campaign_state_transitions` keeps only journey steps. The lead has not decided the store.
- **Evidence.** Read from `infra/db/schema.sql`: no per-person event table. `app/v2/customers/[canonId]/page.tsx` renders the not-available state.
- **Fix direction.** Needs a store of recent events per `canon_id`, with retention, and a decision record for it. The timeline also merges journey entries from `user_campaign_state_transitions` and filters by the chips All, Events, Orders, and Journeys, which waits for the owner to name the order event.

## CUS-KI-05. No delivery status reaches studio

- **Symptom.** Every row of Messages received reads "Sent". None reads "Delivered" or "Failed".
- **Cause.** The outbox publishes requests to Kafka `journey-engine-outbound-noti`, and the sender reports nothing back, so studio knows only that the journey handed the request on. `parseMessages` in `src/features/customer-lookup/model/messages.ts` has no status field.
- **Evidence.** Read from the code and `infra/db/schema.sql`.
- **Fix direction.** Delivery status needs a sender report and a place to store it, which the contract leaves open. Then join it to each engagement transition.

## CUS-KI-06. The profile does not list segments, and stored membership does not exist

- **Symptom.** The Segments region reads "Not available" with the reason, and lists no segment.
- **Cause.** `segment_members` and `segment_import_members` are not built ([SMP-KI-01](../components/segment-membership-pass.md)). No profile query reads membership.
- **Evidence.** Read from `infra/db/schema.sql` and the code.
- **Fix direction.** Build after the segment membership pass. Then read the person's rows from both tables.

## CUS-KI-07. The title shows no name

- **Symptom.** The title is the newest user id alone, and the avatar shows a person icon, not initials.
- **Cause.** `customer_attributes` does not exist yet, and datasets flag email and phone columns but mark no column as a name, so studio cannot tell which imported attribute to show. The contract added the name beside the title on 2026-11-08.
- **Evidence.** Read from the code and from [data import](../../features/data-import.md).
- **Fix direction.** Wait for the owner's answer on which attribute is the name, then show it beside the title and as the avatar's initials.

## CUS-KI-10. The profile shows no imported attributes, and an imported-only customer has no profile

- **Symptom.** The profile has no Customer records card, no spend tile, and no **Reveal**. A search for a customer key that only `customer_attributes` would hold finds nobody, so the imported-only note never shows.
- **Cause.** `customer_attributes` does not exist yet. No query in `src/features/customer-lookup/model/` reads imported attributes, and `app/v2/customers/[canonId]/page.tsx` has no imported-only branch.
- **Evidence.** Read from `infra/db/schema.sql` and the code.
- **Fix direction.** Build after data import stores `customer_attributes`. Mask on the server, and log each reveal in `pii_access_log`.
