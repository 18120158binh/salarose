---
title: Segment membership pass known issues
contract: ../../architecture/components/segment-membership-pass.md
updated: 2026-11-14
verified_at: 43060d0
---

# Segment membership pass known issues

The nightly pass is built: the CronJob `segment-membership-pass` runs `SegmentMembershipPassJob` from the `event-processor` image, and `infra/db/migrations/V0007__segment_import_members.sql` creates `segment_import_members` and `segment_membership_passes`. The current-member duty is not built.

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| SMP-KI-01 | Blocking | The current-member duty does not exist | SMP-FR-13 to SMP-FR-19, SMP-NFR-05, SMP-NFR-06 |
| SMP-KI-02 | Wrong result | A skipped segment loses the rows of a key that became tracked or left `customer_attributes` | SMP-FR-12 |

## SMP-KI-01. The current-member duty does not exist

- **Symptom.** A publish with **Also include current members** sends no member to the journey.
- **Cause.** Nothing in `event-processor/` reads `current_member_entries`, and the table, the topic `current-member-entries`, and the every-minute schedule do not exist.
- **Evidence.** Read from the code at `43060d0`: the package `jobs/segmentpass` holds only the nightly pass, and `infra/db/schema.sql` has no `current_member_entries`.
- **Fix direction.** Add the duty as a second entry point and CronJob in `jobs/segmentpass`, reusing `WalGovernor` and `PostgresReadings`.

## SMP-KI-02. A skipped segment loses the rows of a key that became tracked or left `customer_attributes`

- **Symptom.** A segment whose `conditions_json` does not parse keeps the rows of keys that are still imported-only, but loses the rows of a key that a tracked person now holds or that is gone from `customer_attributes`.
- **Cause.** SMP-FR-06 asks to delete every row of a key a tracked person holds, and SMP-FR-12 asks to keep a skipped segment's rows unchanged. The two conflict for such a key. `JdbcPassStore.deleteStale` follows SMP-FR-06 and the failure table's deleted-person case, so the size of a broken segment never counts a person twice or a deleted person.
- **Evidence.** `SegmentMembershipPassTest.aKeyThatATrackedPersonNowHoldsLosesItsRows` and the query in `JdbcPassStore`.
- **Fix direction.** The owner's review of SMP-FR-12, which is still the lead's default, decides which rule wins. Then state it in the contract and delete this entry.
