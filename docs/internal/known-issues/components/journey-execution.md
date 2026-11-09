---
title: Journey execution known issues
contract: ../../architecture/components/journey-execution.md
updated: 2026-10-27
verified_at: 0db371f8
---

# Journey execution known issues

Java paths are relative to `event-processor/src/main/java/com/cdp/platform/`.

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| JEX-KI-37 | Minor | A setup trigger opens an entry for every new entry id, with no re-entry check and no refusal count | JEX-FR-18 |

## JEX-KI-37. A setup trigger opens an entry for every new entry id, with no re-entry check and no refusal count

- **Symptom.** A setup trigger with an entry id the journey key does not hold always opens a new entry. The job does not read the campaign's entry trigger kind or its re-entry setting (`never`, `always`, `after`), so it refuses no setup trigger and counts no refusal. A person-event campaign still gets one entry, because its setup triggers carry no entry id and share the entry `first`.
- **Cause.** `JourneyStateMachineFunction.targets` in `jobs/statemachine/transforms/` maps a setup trigger to the entry it names, or to `VersionedTrigger.FIRST_ENTRY`, and `TransitionEngine.evaluate` in `jobs/statemachine/engine/` completes the setup node in any entry where it has not completed. No segment entry trigger exists yet to carry a re-entry setting.
- **Evidence.** Read from the code.
- **Fix direction.** Read the entry trigger kind and re-entry setting from the campaign graph when segment entry triggers land, refuse a setup trigger that [Open an entry](../../architecture/components/journey-execution.md#open-an-entry) does not allow, and count it.

Tracked in #223 and #220.
