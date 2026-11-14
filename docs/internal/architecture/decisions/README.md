# Design decisions

Each record explains one choice that shapes the architecture: the context, the decision, the evidence, and the rules that follow. The incidents and research that led to a choice are kept in its "Why" section.

| Id | Decision | Status | Date |
|---|---|---|---|
| [0001](0001-run-the-journey-engine-in-flink.md) | Run the journey engine in Flink, not in Postgres triggers | Accepted | 2026-08-06 |
| [0002](0002-key-every-write-by-its-owner.md) | Key every stateful write by its owner | Accepted | 2026-06-23 |
| [0003](0003-load-rules-through-cdc-and-broadcast-state.md) | Load rules through CDC and broadcast state | Accepted | 2026-06-03 |
| [0004](0004-compute-metrics-and-decisions-in-one-keyed-job.md) | Compute metrics and decisions in one keyed job | Accepted | 2026-08-07 |
| [0005](0005-keep-live-state-in-flink.md) | Keep live state in Flink and a durable copy in Postgres | Accepted | 2026-08-07 |
| [0006](0006-at-least-once-delivery-with-idempotent-writes.md) | At-least-once delivery with idempotent writes | Accepted | 2026-08-21 |
| [0007](0007-staff-sign-in-through-oidc.md) | Staff sign in through OpenID Connect | Accepted. Superseded in part by [0024](0024-create-staff-at-first-sign-in-with-the-providers-role.md) | 2026-10-14 |
| [0008](0008-one-trigger-watermark-for-both-producers.md) | One trigger watermark for both producers | Proposed | 2026-10-18 |
| [0009](0009-compute-node-stats-as-a-view.md) | Compute node stats as a view, not a trigger-maintained table | Accepted by [0035](0035-compute-journey-analytics-from-transitions-on-read.md) | 2026-10-18 |
| [0010](0010-link-staff-to-provider-accounts-and-end-sessions-server-side.md) | Link staff to provider accounts and end sessions server-side | Proposed. Superseded in part by [0024](0024-create-staff-at-first-sign-in-with-the-providers-role.md) | 2026-10-17 |
| [0011](0011-the-first-trigger-to-arrive-completes-a-node.md) | The first trigger to arrive completes a node | Accepted | 2026-10-17 |
| [0012](0012-resolve-events-without-a-device-from-the-durable-copy.md) | Resolve events without a device from the durable copy | Proposed | 2026-10-18 |
| [0013](0013-apply-a-campaign-save-as-one-change.md) | Apply a campaign save as one change | Proposed | 2026-10-18 |
| [0014](0014-gate-events-on-their-catalog-schema-at-ingestion.md) | Gate events on their catalog schema at ingestion | Proposed | 2026-10-18 |
| [0015](0015-check-a-segment-when-a-person-reaches-it.md) | Check a segment when a person reaches it | Proposed | 2026-10-18 |
| [0016](0016-link-only-a-verified-email-and-let-admins-reset-links.md) | Link only a verified email, and let admins reset links | Superseded by [0024](0024-create-staff-at-first-sign-in-with-the-providers-role.md) | 2026-10-18 |
| [0017](0017-keep-dropped-ingestion-input-in-a-dead-letter-topic.md) | Keep dropped ingestion input in a dead-letter topic | Proposed | 2026-10-18 |
| [0018](0018-offer-several-providers-and-name-the-claim-that-proves-an-email.md) | Offer several providers, and name the claim that proves an email | Proposed. Superseded in part by [0024](0024-create-staff-at-first-sign-in-with-the-providers-role.md) | 2026-10-18 |
| [0019](0019-keep-schema-sql-the-only-ddl-source.md) | Keep `schema.sql` the only DDL source | Proposed. Superseded in part by [0024](0024-create-staff-at-first-sign-in-with-the-providers-role.md) and [0043](0043-apply-schema-changes-as-migrations-on-every-sync.md) | 2026-10-18 |
| [0020](0020-read-the-identity-graph-off-the-streams-thread-inside-the-stitcher.md) | Read the identity graph off the stream's thread inside the stitcher | Proposed | 2026-10-18 |
| [0021](0021-recheck-a-users-rows-to-carry-merges-to-the-users-devices.md) | Recheck a user's rows to carry merges to the user's devices | Proposed | 2026-10-18 |
| [0022](0022-version-each-published-graph.md) | Version each published graph and drop triggers decided against an older one | Proposed | 2026-10-19 |
| [0023](0023-let-admins-link-a-user-to-a-provider-account.md) | Let admins link a user to a provider account | Superseded by [0024](0024-create-staff-at-first-sign-in-with-the-providers-role.md) | 2026-10-20 |
| [0024](0024-create-staff-at-first-sign-in-with-the-providers-role.md) | Create staff at their first sign-in, with the role the provider gives | Proposed | 2026-10-20 |
| [0025](0025-bundle-connectors-in-the-job-jar.md) | Bundle the connectors in the job JAR and keep the JDBC driver in the image | Proposed | 2026-10-20 |
| [0026](0026-read-user-metrics-through-the-mailbox-of-the-behavior-operator.md) | Read user metrics through the mailbox of the behavior operator | Proposed | 2026-10-20 |
| [0027](0027-multi-tenancy.md) | Serve several customers from one deployment | Proposed | 2026-10-18 |
| [0028](0028-store-metrics-as-tiered-time-buckets.md) | Store metrics as tiered time buckets | Accepted | 2026-10-21 |
| [0029](0029-model-a-rule-as-a-trigger-and-person-conditions.md) | Model a rule as a trigger and person conditions | Accepted | 2026-10-21 |
| [0030](0030-make-every-rule-decision-in-one-keyed-operator.md) | Make every rule decision in one keyed operator | Accepted | 2026-10-21 |
| [0031](0031-reusable-segments-with-entry-triggers.md) | Reusable segments with entry triggers | Accepted. Superseded in part by [0038](0038-store-segment-membership-and-evaluate-every-segment.md) | 2026-10-21 |
| [0032](0032-fan-out-business-events-to-interested-people.md) | Fan out business events to interested people | Accepted | 2026-10-21 |
| [0033](0033-a-journey-instance-is-one-entry.md) | A journey instance is one entry | Accepted | 2026-10-21 |
| [0034](0034-build-studio-v2-side-by-side-under-v2.md) | Build studio v2 side by side under `/v2` in the same app | Accepted. Superseded in part by [0037](0037-one-studio-retire-the-classic-studio.md) and [0045](0045-adopt-the-salarose-design-system-and-approve-a-visual-draft-before-ui-code.md) | 2026-11-07 |
| [0035](0035-compute-journey-analytics-from-transitions-on-read.md) | Compute journey analytics from the transitions on read | Accepted | 2026-11-07 |
| [0036](0036-store-journey-drafts-on-the-server-outside-cdc.md) | Store journey drafts on the server, outside CDC | Accepted | 2026-11-08 |
| [0037](0037-one-studio-retire-the-classic-studio.md) | One studio: retire the classic studio | Accepted | 2026-11-08 |
| [0038](0038-store-segment-membership-and-evaluate-every-segment.md) | Store segment membership and evaluate every segment | Accepted | 2026-11-08 |
| [0039](0039-shorten-the-cdc-restore-window.md) | Shorten the CDC restore window to keep slots under the WAL cap | Accepted | 2026-11-08 |
| [0040](0040-import-through-a-batch-path-and-a-separate-store.md) | Import through a batch path and a separate store | Accepted | 2026-11-08 |
| [0041](0041-imported-data-reaches-conditions-as-profile-attributes.md) | Imported data reaches conditions as profile attributes | Accepted | 2026-11-08 |
| [0042](0042-keep-imported-contact-details-plain-behind-masking-and-tombstones.md) | Keep imported contact details in plain form behind masking and tombstones | Accepted | 2026-11-08 |
| [0043](0043-apply-schema-changes-as-migrations-on-every-sync.md) | Apply schema changes as versioned migrations on every sync | Accepted | 2026-11-08 |
| [0044](0044-classify-event-field-changes-as-safe-asks-first-or-breaking.md) | Classify event field changes as Safe, Asks first, or Breaking | Accepted | 2026-11-08 |
| [0045](0045-adopt-the-salarose-design-system-and-approve-a-visual-draft-before-ui-code.md) | Adopt the Salarose design system, and approve a visual draft before UI code | Accepted | 2026-11-08 |
| [0046](0046-cap-fan-out-at-10000-exact-items-and-thresholds-as-filters.md) | Cap fan-out at 10,000 people, match exact items, and express thresholds as filters | Accepted | 2026-11-14 |
| [0047](0047-email-and-phone-are-guarded-match-keys-from-import-and-the-api.md) | Email and phone are guarded match keys, learned from imports and the API | Accepted | 2026-11-14 |
| [0048](0048-ingestion-keeps-tracker-parity-a-per-replica-limit-and-two-keys-for-rotation.md) | The ingestion API ignores catalog status, counts its rate limit per replica, and allows two keys per app id | Accepted | 2026-11-14 |
| [0049](0049-the-ingestion-api-writes-plain-json-to-its-own-topic-and-leaves-history-to-import.md) | The ingestion API writes plain JSON to its own topic, and leaves history to the import | Accepted | 2026-11-05 |

To add a decision, copy [the template](../../_templates/decision.md) to the next free number. Never edit an accepted record to reverse it. Write a new record and set `superseded_by` on the old one.
