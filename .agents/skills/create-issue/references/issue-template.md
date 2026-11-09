# Issue template

Use the section list for the issue's kind. Keep every heading, and write "None" or "Unknown" under one you cannot fill. A reader decides from the first two sections whether the issue is theirs.

A bug starts with a hidden line, `<!-- known-issue: <KI id> -->`, for scripts that read issue bodies. The visible "Known issue" link also carries the id, so a search finds the issue even after someone renames the title.

## Title

- Bug: `<KI id>: <what goes wrong>`, such as `DEC-KI-04: metric conditions see only the metrics this event changed`.
- Decision: `Decide: <question>`, such as `Decide: when does a check take its no branch?`
- Enhancement: `<feature>: <capability>`, such as `Studio: store drafts on the server`.
- Chore or docs: `<area>: <change>`.

Sentence case, no trailing period, at most about 80 characters.

## Bug

```markdown
<!-- known-issue: DEC-KI-04 -->

## Summary

One or two sentences: what goes wrong, for whom, and when.

## Contract

- Breaks: `DEC-FR-06` in [Customer decision](docs/internal/architecture/components/customer-decision.md#functional-requirements)
- Known issue: [DEC-KI-04](docs/internal/known-issues/components/customer-decision.md#dec-ki-04-metric-conditions-see-only-the-metrics-this-event-changed)

## Expected and actual

- Expected: what the contract says, in one line.
- Actual: what the code does, in one line.

## Evidence

How you know. Name the class or file and the line, the command you ran and its output, or "Read from the code, not run". Trim logs to the lines that matter, and remove personal data.

## Acceptance criteria

- [ ] Given ..., when ..., then ... (from the contract's acceptance criteria where one fits)
- [ ] A test covers the case.
- [ ] The known-issues entry is deleted.

## Notes

Fix direction, related issues, and risks. Optional.
```

## Decision

```markdown
## Question

The open question, quoted from the contract, with a link to it.

## Why it blocks

The work that cannot start until it is answered.

## Options

| Option | Effect | Cost |
|---|---|---|

## Decide by

Who decides, and the contract sections that change with the answer.
```

## Enhancement

```markdown
## Summary

Who needs what, and why.

## Requirements

| Id | Requirement |
|---|---|
| XX-FR-NN | The feature must ... |

## Acceptance criteria

- [ ] Given ..., when ..., then ...
- [ ] The contract in `docs/internal/features/` or `docs/internal/architecture/components/` has the new rows.

## Out of scope

What this does not include.
```

## Chore or docs

```markdown
## Summary

What changes and why.

## Done when

- [ ] A concrete check, such as "`pnpm studio:build` passes" or "the link check reports 0 broken links".
```
