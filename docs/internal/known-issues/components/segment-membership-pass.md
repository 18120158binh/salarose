---
title: Segment membership pass known issues
contract: ../../architecture/components/segment-membership-pass.md
updated: 2026-11-08
verified_at: 7e88968c
---

# Segment membership pass known issues

The segment membership pass is not built. No scheduled job evaluates segments for imported-only customers, and neither `segment_import_members` nor `customer_attributes` exists in `infra/db/schema.sql`. It waits for the `customer_attributes` table from data import.

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| SMP-KI-01 | Blocking | The pass and its table do not exist | SMP-FR-01 to SMP-FR-19 |

## SMP-KI-01. The pass and its table do not exist

- **Symptom.** Segment size cannot count customers known only from imports, and **Also include current members** has nothing to send its members.
- **Cause.** Nothing in `event-processor/` implements the pass, and `infra/db/schema.sql` has no `segment_import_members` or `customer_attributes` table.
- **Evidence.** Read from the code at `7e88968c`: a search of the repo for `segment_import_members` and `customer_attributes` finds only docs.
- **Fix direction.** Build it as a scheduled job from the `event-processor` image that reuses the condition evaluator in `shared/`, after data import adds `customer_attributes`.
