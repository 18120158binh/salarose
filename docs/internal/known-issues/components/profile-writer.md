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

## PRW-KI-09. `user_metrics` stores occurrence arrays, not buckets

- **Same defect as DEC-KI-42.** See [DEC-KI-42](customer-decision.md#dec-ki-42-metrics-are-stored-as-capped-raw-occurrences-not-buckets). The writer stores what the mutation carries, so it changes with the job. Fix and track it there.
