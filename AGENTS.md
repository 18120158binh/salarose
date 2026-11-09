<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `studio/node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Java Code Formatting & Style Standards
- **No Inline Package Imports**: Always import classes at the top of the file; never use `new com.pkg.ClassName()`.
- **Clean Architecture**: Separate PostgreSQL schemas, columns, and RowMappers into `*Table.java` metamodel classes.
- **Zero Redundancy**: Omit redundant `implements Serializable`, unused imports, and dead code.
- **Automated Formatting**: Enforce formatting via Spotless (`./mvnw spotless:apply`).

# Agent guide

This repo is a customer data platform (CDP) journey engine. A Snowplow tracker sends behavior events to an OpenSnowcat collector. Five Flink jobs in `event-processor/` parse the events, stitch identities, update per-customer metrics, decide which journey nodes each event satisfies, and move customers through journeys. Marketers build the journeys in the Next.js app `studio/`. Postgres stores campaign definitions, metric definitions, and journey state.

Read [docs/internal/README.md](docs/internal/README.md) before you change a feature or a component. Each has a contract and a known-issues page. Its section "How this folder is organized" defines the doc layout and which folder a new contract goes in.

## Repo map

| Path | What lives there |
|---|---|
| `event-processor/` | Java 21 Flink jobs. One package per job under `src/main/java/com/cdp/platform/jobs/`: `eventparser`, `customerdecision`, `profilewriter`, `statemachine`, `outbox`. |
| `event-processor/.../platform/shared/` | Shared models (`models/`, `models/node/`, `models/db/`), jOOQ repositories (`db/repositories/`), config, utils. |
| `studio/` | Next.js app, Journey Studio: login, campaign list, journey builder canvas, event and user management. |
| `shared/` | TypeScript package used by `studio`: coss UI components, DB client, campaign types, metric definitions. |
| `infra/db/` | Postgres schema, legacy state machine SQL. |
| `infra/local/` | Podman compose stack: Kafka, Flink, Postgres, collector. |
| `docs/internal/features/` | Feature contracts: what each user-facing feature must do. No code names. |
| `docs/internal/architecture/components/` | Component contracts: what each pipeline job or stage must do, such as identity, customer decision, and journey execution. No code names. |
| `docs/internal/known-issues/` | Where the code departs from each contract, with class and file names. `features/` and `components/` mirror the contract folders. |
| `docs/internal/architecture/` | The high-level architecture, the data model, the component contracts in `components/`, and the design decisions in `decisions/`. |
| `docs/internal/operations/` | Configuration, local run, deployment. |
| `.agents/skills/` | Skills this guide routes you to. |

## Work from the contracts

A contract defines the behavior of a feature or a component: terms, algorithm, requirements with ids such as `DEC-FR-06`, interfaces, and acceptance criteria.

- To build or change a feature or a component, read its contract first. Implement against the requirement ids, and turn the acceptance criteria into tests.
- To fix a bug, find its id in the contract's known-issues page. Delete the entry in the same change as the fix.
- If the code must do something the contract does not say, or the contract has an open question in your way, stop and ask. Don't guess the answer into the code.
- To understand why the architecture is the way it is, read the decision records in `docs/internal/architecture/decisions/`. Don't reverse one silently. Propose a new record.

## Skills

Skills live in `.agents/skills/<name>/SKILL.md`. If your harness does not load them on its own, open the file and follow it. `.claude/skills/` links the ones meant to run as slash commands in Claude Code. The tables say when each one applies. Skills named `principle-*` are short; read the whole file.

The skills from [pstack](https://github.com/backnotprop/pstack) are copied verbatim from commit `fce11a3`, under the MIT license in `.agents/skills/PSTACK_LICENSE`. To update one, copy the upstream file again rather than editing it here. Put repo-specific rules in this file instead.

Five investigation principles are this repo's own, not pstack's, and you edit them here: `principle-question-driven-investigation`, `principle-inspect-resources-and-config`, `principle-corroborate-with-the-right-evidence`, `principle-decompose-into-independent-questions`, and `principle-keep-a-finding-ledger`.

Four frontend skills come from other repos and were installed with the [`skills`](https://github.com/vercel-labs/skills) CLI, which records each source and hash in `skills-lock.json`: `vercel-react-best-practices`, `vercel-composition-patterns`, and `web-design-guidelines` from [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) (MIT), and `frontend-design` from [anthropics/skills](https://github.com/anthropics/skills) (Apache 2.0). Don't edit them here. To update them, run `pnpm dlx skills update -p`, then move any copy it writes to `.claude/skills/` into `.agents/skills/`. [.agents/skills/THIRD_PARTY.md](.agents/skills/THIRD_PARTY.md) lists every vendored skill and its license.

### Investigating a question

Use these for a bug report, a "how does X work", a review, an incident, or any question about what the system does.

| Situation | Skill |
|---|---|
| Starting any investigation | `principle-question-driven-investigation`. Write the questions and the evidence each needs before you search. |
| The answer depends on built or deployed behavior | `principle-inspect-resources-and-config`. Read `infra/db/schema.sql`, `event-processor/pom.xml` and its `Dockerfile`, the collector config in `infra/local/`, the env vars in [configuration.md](docs/internal/operations/configuration.md), and the deploy manifests the `deploy` skill names, alongside the code. |
| Stating a conclusion | `principle-corroborate-with-the-right-evidence`. Runtime observation here means the remote cluster, only when static evidence cannot answer and you have access. Never a local stack, as [Verify](#verify) says. |
| More than a few questions | `principle-decompose-into-independent-questions` |
| An investigation that spans passes, workers, or sessions | `principle-keep-a-finding-ledger` |

### Before you change code

| Situation | Skill |
|---|---|
| Any change to existing code | Read every file you touch and its callers first. Read the feature contract and its known issues. |
| You don't yet know how a subsystem works | `how`. Explore before you edit. |
| Choosing types, tables, or state layout for new logic | `principle-foundational-thinking`, `principle-model-the-domain` |
| A new requirement doesn't fit the current design | `principle-subtract-before-you-add` |
| Multi-step work: a migration, a schema change, a sweep across jobs | `principle-sequence-verifiable-units` |

### While you write code

| Situation | Skill |
|---|---|
| Any `.ts` or `.tsx` file | `typescript-best-practices`, `principle-type-system-discipline` |
| Any change to the Postgres schema: a table, column, index, view, function, or publication | `db-migration` |
| Parsing Kafka payloads, CDC rows, request bodies, env vars | `principle-boundary-discipline` |
| Sinks, timers, anything that can replay after a restart | `principle-make-operations-idempotent` |
| Two jobs or two subtasks writing the same Postgres rows | `principle-separate-before-serializing-shared-state` |
| Journey node logic, branches, campaign status, predicate trees | `principle-model-the-domain` |
| Diff is growing, or you want a new layer or wrapper | `principle-laziness-protocol`, `principle-minimize-reader-load` |
| A rule you keep repeating in review | `principle-encode-lessons-in-structure` |
| UI work in `studio` | Follow [DESIGN.md](DESIGN.md) and reuse the coss components in `shared/`. |
| React components, Next.js pages, data fetching, or bundle size in `studio` | `vercel-react-best-practices` |
| A component with many boolean props, or a reusable component API | `vercel-composition-patterns` |
| Reviewing UI code for accessibility, forms, focus, motion, and UX | `web-design-guidelines` |
| Designing a new screen with no existing pattern | `frontend-design`. [DESIGN.md](DESIGN.md) wins where they disagree: keep its tokens, type, and spacing, and spend the skill's advice on layout and hierarchy. |

### Debugging and performance

| Situation | Skill |
|---|---|
| Any bug | `principle-fix-root-causes`. Reproduce first. Don't add a null check to silence it. |
| The bug has a cheap local test target | `tdd` |
| Throughput, latency, backpressure, or checkpoint numbers | `benchmark-checklist`, `principle-explain-the-number` |
| Context is filling with logs or large files | `principle-guard-the-context-window` |

### Before you call it done

| Situation | Skill |
|---|---|
| Every task | The checks in [Verify](#verify), then `principle-prove-it-works` |
| You added or changed a test | `principle-test-behavior-not-implementation` |
| You wrote docs, a README, a commit message, or a PR body | `technical-writing`, then `unslop` |

### Shipping and tracking

| Situation | Skill |
|---|---|
| The user asks to deploy, release, or push images: GitHub, AWS, or k3d | `deploy`. Only on the user's ask in this conversation. It is the one exception to the no-local-run rule in [Verify](#verify). |
| The user asks to file an issue, or a bug you found needs tracking | `create-issue`. Dry run first, and create only on the user's yes. |
| Open, update, or review a GitHub pull request | `pull-request` |

## Rules for this repo

These come from mistakes found in this codebase. Each rule names the skill it applies.

- **Flink sinks must survive replay.** After a restart, Flink replays events from the last checkpoint, and CDC sources may re-read a snapshot. A sink must converge on the same rows when it sees a record twice. Use an upsert keyed on a natural id, or an insert that skips existing rows. Never generate a random id inside a sink path. (`principle-make-operations-idempotent`)
- **Key by the row's owner.** [Decision 0002](docs/internal/architecture/decisions/0002-key-every-write-by-its-owner.md) records a deadlock between two subtasks of an unkeyed JDBC sink. `keyBy` the stream on the row's owner, usually `canon_id` or the journey key, so one subtask writes each row. Add locks only if that is not enough. (`principle-separate-before-serializing-shared-state`)
- **Parse at the edge.** Snowplow payloads become `Event` in `ParseSnowplowEvent`. Node rows become `CampaignNode` in `CampaignNode.load`. Metric definition rows become `MetricConfig` in `MetricConfig.fromRow`. Code after those parsers trusts the types. A parse failure must not stop the job: log it and drop the row. (`principle-boundary-discipline`)
- **A schema change is a migration, and everything that names the schema changes with it.** Add a new file in `infra/db/migrations/` and list it in `infra/db/kustomization.yaml`. Never edit a migration already on the deploy branch. In the same commit, make the same change to `infra/db/schema.sql`, the `DSL.name(...)` fields in `shared/db/repositories/`, the `studio` queries, and [docs/internal/architecture/data-model.md](docs/internal/architecture/data-model.md). `schema.sql` and the jOOQ names have drifted before (`matched_event_timestamp`, `last_event_timestamp`), so grep the repositories for an old name after a rename. CI fails when the migrations and `schema.sql` build different schemas. Never run DDL by hand as `postgres`. (`db-migration`)
- **Branch names are a contract.** `studio/src/entities/journey/model/utils.ts` (`flattenCampaignTree`) writes `parent_branch`. `Event.matchAll` and `TransitionEngine` read it. A new branch name or node type touches all three, plus `shared/types/campaigns.ts` and `shared/models/node/`. Change them in one commit, and keep the branch table in [the journey builder contract](docs/internal/features/journey-builder.md#saved-format) true. (`principle-model-the-domain`)
- **CI minutes are a budget.** Every workflow gets a path filter and a `concurrency` group, commits that only move image tags build nothing, and a fork's pull request never runs on a self-hosted runner. Measure billed minutes before you trim. [Keep CI cheap](docs/internal/operations/ci-cost.md) has the steps and the reasons.

## Verify

The services run on remote infrastructure: a Kubernetes cluster with Flink, Postgres, and Kafka. Don't start them locally to test a change, unless the user asked for a deploy, which follows the `deploy` skill. Don't run `mvnw exec:java`, `java -jar`, `pnpm studio:dev`, or the compose stack, and don't call localhost endpoints. Run the tests, builds, and linters that apply:

```bash
# Flink jobs. Spotless and Checkstyle are not bound to a build phase, so run them explicitly. CI runs spotless:check and checkstyle:check and fails on a violation.
./event-processor/mvnw -f event-processor/pom.xml spotless:apply
./event-processor/mvnw -f event-processor/pom.xml clean test
./event-processor/mvnw -f event-processor/pom.xml checkstyle:check

# Postgres migrations. Needs docker and a throwaway Postgres on localhost:5432, the one local service a check may start.
# The script's header has the command. CI runs the same script.
bash infra/db/test-migrations.sh

# studio
pnpm --filter studio test
pnpm --filter studio lint
pnpm studio:build
```

Report the command you ran and its result. If a check fails, say so and paste the error. If you added logic without a test, say so.

## Documentation

`docs/internal/` follows the layout in [docs/internal/README.md](docs/internal/README.md):

- A change that alters what a feature or a component does updates its contract in `docs/internal/features/` or `docs/internal/architecture/components/` in the same change. Contracts name tables, topics, routes, and message fields, never classes, files, or environment variables.
- A fix deletes its entry in `docs/internal/known-issues/`. A new defect gets an entry there, with the requirement id it breaks.
- A new architectural choice gets a decision record in `docs/internal/architecture/decisions/`.
- A new or renamed environment variable goes in `docs/internal/operations/configuration.md`.

Write docs with the `technical-writing` skill and run `unslop` over them. Start new pages from the templates in `docs/internal/_templates/`.
