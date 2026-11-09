---
title: Feature or component name
slug: feature-name
purpose: One sentence. The outcome this feature gives its users.
status: draft
implementation: planned
area: event-processor
tags: [tag-one, tag-two]
created: YYYY-MM-DD
updated: YYYY-MM-DD
version: 0.1
known_issues: ../known-issues/features/feature-name.md
---

# Feature or component name

<!--
A contract says what a feature or a component must do, in terms
that a coding agent can implement and a reviewer can check. It does not
describe the current code: no class names, file paths, function names,
libraries, or environment variables. Those belong in the code, in
operations/configuration.md, and in known-issues/.

Front matter:
- known_issues: the paths above are for a feature in features/. A component in
  architecture/components/ uses ../../known-issues/components/<name>.md.
- status: draft (still being decided), accepted (the contract to build
  against), or deprecated.
- implementation: planned, partial, or shipped. "partial" means the code
  exists but misses part of the contract. Its known-issues file says which part.
- version: raise the minor number for a clarification, the major number
  for a change that breaks consumers.
-->

## Purpose

Two or three sentences. Say who uses the feature, what problem it solves, and what changes for them when it works. A reader who stops here knows whether this is the page they need.

## Scope

In scope:

- What the feature owns.

Out of scope:

- What a reader might expect here but another feature or system owns. Link it.

## Terms

Words with one fixed meaning on this page. Use the same word everywhere, in the code, the UI, and the messages. Link the [glossary](../product/glossary.md) for terms shared across features.

| Term | Meaning |
|---|---|

## Behavior

The feature as its users see it, in order. Give one concrete example with real values. Use a diagram when the flow branches, loops, or crosses components. Mermaid renders on GitHub.

## Algorithm

Only when the feature has one. State the inputs, the steps, the output, and the rules that decide ties and edge cases. Write it so that two independent implementations produce the same output for the same input. Give a worked example.

## Functional requirements

Each requirement has an id, one testable statement, and uses "must" or "must not". Known issues and tests cite these ids.

| Id | Requirement |
|---|---|
| XX-FR-01 | The feature must ... |

## Non-functional requirements

Bounds on latency, throughput, state size, durability, delivery, security, and recovery. Give a number and a unit for each. A bound that operators can change says so and gives its default. [Configuration](../operations/configuration.md) names the setting.

| Id | Requirement |
|---|---|
| XX-NFR-01 | ... |

## Interfaces

What the feature reads and writes, as contracts between components: Kafka topics with their key and message shape, Postgres tables, HTTP routes, and UI entry points. Link [the data model](../architecture/data-model.md) for column details instead of copying them.

## Failure handling

What the feature does with bad input, a missing dependency, a duplicate, a late record, and a restart.

## Acceptance criteria

Concrete checks in the form "Given ..., when ..., then ...". Each one maps to a requirement id. A coding agent turns these into tests.

## Open questions

Decisions nobody has made yet. Don't guess the answer in the sections above. Delete this section when it is empty.

## Related

- Design decisions in [architecture/decisions/](../architecture/decisions/README.md) that shape this feature.
- The [known issues](../known-issues/features/feature-name.md) for the current implementation.
- Other contracts that this one depends on.
