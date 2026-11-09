---
title: Feature name known issues
contract: ../../features/feature-name.md
updated: YYYY-MM-DD
verified_at: <commit>
---

# Feature name known issues

<!--
This page lists where the current code differs from its contract,
plus defects the contract does not cover. It is the only place where feature
documentation names classes, files, and commits. Delete an issue when the fix
lands, in the same change.
-->

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| XX-KI-01 | Blocking | One line | XX-FR-01 |

Severity is one of:

- Blocking: the feature does not work end to end.
- Wrong result: the feature runs but produces output the contract forbids.
- Risk: the feature works today but fails under a condition that can happen in production.
- Minor: cosmetic, dead code, or missing tests.

## XX-KI-01. One-line title

- **Symptom.** What a user or operator sees.
- **Cause.** The class, file, or commit that causes the problem.
- **Evidence.** "Read from the code" or "Reproduced with ...". Mark an inference as one.
- **Fix direction.** Optional. One or two sentences.
