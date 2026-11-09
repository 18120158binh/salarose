---
title: Identity merges known issues
contract: ../../../architecture/components/identity/identity-merges.md
updated: 2026-10-21
verified_at: 1e59e806
---

# Identity merges known issues

Identity merges are not built. No topic carries merge records, and no job folds state under a retired `canon_id`. The old Postgres engine planned an `__identity_merged__` event for this, and the Flink engine never built it ([decision 0001](../../../architecture/decisions/0001-run-the-journey-engine-in-flink.md#consequences)). Until this contract is built, the accepted [identity stitching](../../../architecture/components/identity/identity-stitching.md#merges-reach-the-users-devices-not-later-stages) contract describes what happens after a merge.

| Id | Severity | Issue | Breaks |
|---|---|---|---|
