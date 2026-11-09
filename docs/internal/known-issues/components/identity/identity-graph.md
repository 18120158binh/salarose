---
title: Identity graph known issues
contract: ../../../architecture/components/identity/identity-graph.md
updated: 2026-10-21
verified_at: 1e59e806
---

# Identity graph known issues

The identity graph is not built. Each device keeps its own identity set in the event parse job's keyed state, and `identity_graph` holds one row per `domain_userid`. Devices converge on a merge by rechecking the user's rows once a minute, as [decision 0021](../../../architecture/decisions/0021-recheck-a-users-rows-to-carry-merges-to-the-users-devices.md) describes. Nothing records merges or a merge history, and no limit refuses a merge.

| Id | Severity | Issue | Breaks |
|---|---|---|---|
