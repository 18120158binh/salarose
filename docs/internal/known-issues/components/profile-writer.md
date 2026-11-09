---
title: Profile writer known issues
contract: ../../architecture/components/profile-writer.md
updated: 2026-11-08
verified_at: 0db371f8
---

# Profile writer known issues

Java paths are relative to `event-processor/src/main/java/com/cdp/platform/`.

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| PRW-KI-09 | Minor | `user_metrics` stores occurrence arrays, not buckets | PRW-FR-04 |
| PRW-KI-10 | Blocking | No segment membership sink | PRW-FR-08, PRW-FR-09, PRW-FR-10, PRW-FR-11 |

## PRW-KI-09. `user_metrics` stores occurrence arrays, not buckets

- **Same defect as DEC-KI-42.** See [DEC-KI-42](customer-decision.md#dec-ki-42-metrics-are-stored-as-capped-raw-occurrences-not-buckets). The writer stores what the mutation carries, so it changes with the job. Fix and track it there.

## PRW-KI-10. No segment membership sink

- **Symptom.** `segment_members` stays empty, so studio cannot show segment size.
- **Cause.** `CustomerProfileWriterJob` in `jobs/profilewriter/` reads only `customer-profile-mutations`. `infra/db/schema.sql` has no `segment_members` table, and nothing produces `segment-membership-changes` yet ([DEC-KI-41](customer-decision.md#dec-ki-41-no-membership-flags-no-business-event-matches-and-no-entry-id)).
- **Evidence.** Read from the code at `7e88968c`: no Java or SQL file names `segment_members` or `segment-membership-changes`.
- **Fix direction.** Add a second source and a JDBC sink to the job, keyed by `canon_id`, after customer decision publishes membership changes.
