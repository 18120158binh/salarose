# Internal documentation

These documents define what the platform must do, why it is built the way it is, and where the current code falls short. New here? Read [About the product](product/overview.md), then [About the architecture](architecture/overview.md).

## Contents

### Product

- [About the product](product/overview.md): who uses it and what problem it solves
- [Use cases](product/use-cases.md): the business requirements, and what the code supports today
- [Glossary](product/glossary.md)

### Architecture

- [About the architecture](architecture/overview.md): context, data flow, components, topics, and quality attributes
- [Data model](architecture/data-model.md): every Postgres table, who writes it, and who reads it
- [Platform capacity](architecture/capacity.md): the target load, how to size Postgres, the CDC slots, the disks, and Kafka for it, and the load test that proves it. [Known issues](known-issues/platform.md)
- [Design decisions](architecture/decisions/README.md): one record per architectural choice, with its evidence

### Components

A component is a part of the pipeline that no person uses directly: a Flink job or a stage of one. Each has a contract in `architecture/components/`. The identity contracts share a folder, and [the identity resolution overview](architecture/components/identity/README.md) says how they fit together.

| Component | Area | Contract | Implementation | Known issues |
|---|---|---|---|---|
| [Event ingestion](architecture/components/event-ingestion.md) | `event-processor` | Accepted | Shipped | [List](known-issues/components/event-ingestion.md) |
| [Identifiers](architecture/components/identity/identifiers.md) | `event-processor` | Draft | Planned | [List](known-issues/components/identity/identifiers.md) |
| [Identity stitching](architecture/components/identity/identity-stitching.md) | `event-processor` | Accepted | Partial | [List](known-issues/components/identity/identity-stitching.md) |
| [Identity graph](architecture/components/identity/identity-graph.md) | `event-processor` | Draft | Planned | [List](known-issues/components/identity/identity-graph.md) |
| [Identity merges](architecture/components/identity/identity-merges.md) | `event-processor` | Draft | Planned | [List](known-issues/components/identity/identity-merges.md) |
| [Customer decision](architecture/components/customer-decision.md) | `event-processor` | Accepted | Partial | [List](known-issues/components/customer-decision.md) |
| [Profile writer](architecture/components/profile-writer.md) | `event-processor` | Accepted | Partial | [List](known-issues/components/profile-writer.md) |
| [Journey execution](architecture/components/journey-execution.md) | `event-processor` | Accepted | Partial | [List](known-issues/components/journey-execution.md) |
| [Notification outbox](architecture/components/notification-outbox.md) | `event-processor` | Accepted | Partial | [List](known-issues/components/notification-outbox.md) |
| [Business event fan-out](architecture/components/business-event-fan-out.md) | `event-processor` | Draft | Planned | [List](known-issues/components/business-event-fan-out.md) |
| [Import applier](architecture/components/import-applier.md) | `event-processor` | Accepted | Planned | [List](known-issues/components/import-applier.md) |
| [Import metric pass](architecture/components/import-metric-pass.md) | `event-processor` | Accepted | Planned | [List](known-issues/components/import-metric-pass.md) |
| [Segment membership pass](architecture/components/segment-membership-pass.md) | `event-processor` | Accepted | Planned | [List](known-issues/components/segment-membership-pass.md) |
| [Schema migrations](architecture/components/schema-migrations.md) | `infra` | Accepted | Shipped | [List](known-issues/components/schema-migrations.md) |

### Features

A feature is something a person uses: a marketer or an admin in `studio`, or a customer's developer through the API. Each has a contract in `features/`.

| Feature | Area | Contract | Implementation | Known issues |
|---|---|---|---|---|
| [Journey builder](features/journey-builder.md) | `studio` | Accepted | Partial | [List](known-issues/features/journey-builder.md) |
| [Campaign management](features/campaign-management.md) | `studio` | Accepted | Partial | [List](known-issues/features/campaign-management.md) |
| [AI journey generation](features/ai-journey-generation.md) | `studio` | Draft | Partial | [List](known-issues/features/ai-journey-generation.md) |
| [Event catalog](features/event-catalog.md) | `studio` | Accepted | Partial | [List](known-issues/features/event-catalog.md) |
| [Segments](features/segments.md) | `studio` | Accepted | Partial | [List](known-issues/features/segments.md) |
| [Admin authentication](features/admin-authentication.md) | `studio` | Accepted | Shipped | [List](known-issues/features/admin-authentication.md) |
| [Data ingestion API](features/data-ingestion-api.md) | `studio`, `event-processor` | Accepted | Partial | [List](known-issues/features/data-ingestion-api.md) |
| [Traffic simulator](features/traffic-simulator.md) | `infra` | Accepted | Planned | [List](known-issues/features/traffic-simulator.md) |
| [Platform console](features/platform-console.md) | `studio` | Draft | Partial | [List](known-issues/features/platform-console.md) |
| [Studio shell](features/studio-shell.md) | `studio` | Accepted | Partial | [List](known-issues/features/studio-shell.md) |
| [Home overview](features/home-overview.md) | `studio` | Accepted | Partial | [List](known-issues/features/home-overview.md) |
| [Customer lookup](features/customer-lookup.md) | `studio` | Accepted | Planned | [List](known-issues/features/customer-lookup.md) |
| [Data health](features/data-health.md) | `studio` | Accepted | Partial | [List](known-issues/features/data-health.md) |
| [Data import](features/data-import.md) | `studio`, `event-processor` | Accepted | Planned | [List](known-issues/features/data-import.md) |

### Known issues

- [Known issues](known-issues/README.md): where the code departs from each contract, by severity, and what stops a journey today

### Integration

- [Tracking integration guide](integration/tracking-guide.md): for a customer's developers. How to send events with the Snowplow trackers or the tracker protocol, the rules events must follow, and the profile data feed.

### Operations

- [Onboard a customer](operations/onboard-a-customer.md): intake, provisioning, the collector in production, studio setup, and the first events
- [Configuration](operations/configuration.md): every environment variable and its default
- [Batch jobs](operations/batch-jobs.md): how a Java job without Flink is written, built, scheduled as a CronJob, and deployed
- [How to run the stack locally](operations/local-environment.md)
- [Deployment](operations/deployment.md)
- [AWS Free Plan environment](operations/aws-free-plan.md): the contract for a short-lived three-node k3s deploy on an AWS Free Plan account
- [Monitoring](operations/monitoring.md): the journey engine's drop counters, the Prometheus reporter, and the alerts
- [Keep CI cheap](operations/ci-cost.md): how to cut GitHub Actions cost, and the lesson from hitting the minutes limit

## How this folder is organized

The folders answer four questions. Product says who the platform is for and what they need. Architecture says how the platform is built and why. Features say what a person can do with it. Known issues say where the code falls short of the contracts. Each kind of page has one job, as in [Diátaxis](https://diataxis.fr/):

| Folder | Kind | Holds | Names code? |
|---|---|---|---|
| `product/` | Explanation and reference | Users, use cases, terms | No |
| `architecture/overview.md` | Explanation | The map: data flow, components, topics, and quality attributes. It links each component's contract and repeats none of its rules. | Component and job names only |
| `architecture/components/` | Specification | The contract each pipeline component must meet | No |
| `architecture/data-model.md` | Reference | Tables, owners, CDC publications | Yes |
| `architecture/capacity.md` | Specification | The platform's target load, the sizing method, and the load test's pass rules. Its known issues go in `known-issues/platform.md`. | No |
| `architecture/decisions/` | Explanation | Why each choice was made: context, evidence, alternatives | Where the evidence needs it |
| `features/` | Specification | The contract each user-facing feature must meet | No |
| `known-issues/` | Reference | Gaps between the code and the contracts. `features/` and `components/` mirror the contract folders, and `platform.md` holds the gaps against `architecture/capacity.md` and what no other contract owns. | Yes |
| `integration/` | Explanation and reference, for customers | How a customer sends data | Only the names a customer needs |
| `operations/` | How-to and reference | Running, deploying, configuring, and onboarding | Yes |

### Put a contract in the right folder

Features and components use the same contract template. The difference is who the contract serves:

- **A feature** has a user. A marketer builds a journey, an admin manages staff, a customer's developer posts events. If you can describe it by what a person does on a screen or through an API, it is a feature and goes in `features/`.
- **A component** has only other components as users. It reads and writes topics, tables, and keyed state. If its users are jobs, it is a component and goes in `architecture/components/`.

A capability that spans both, such as running a journey from the builder to the message, is a use case in `product/use-cases.md`. It links the feature and component contracts that deliver it, and it is not a contract of its own.

Contracts that belong to one subsystem share a folder with a `README.md` overview, such as `architecture/components/identity/`. The overview says how the contracts fit together and defines the terms they share. Its known-issues pages go in the matching folder under `known-issues/`.

The architecture overview and the contracts must not say the same thing twice. The overview names each component, its topics, and its contract. The contract holds the rules, the algorithm, and the message shapes.

Research notes and incident write-ups do not get their own pages. Their findings go into the decision they justify, under "Why", and their requirements go into the contract.

## Writing rules

- **A contract states requirements, not code.** No class names, file paths, function names, libraries, or environment variables in `features/`, `architecture/components/`, or `architecture/capacity.md`. Name tables, topics, routes, and message fields, because those are interfaces.
- **Give every requirement an id.** Known issues and tests cite it.
- **Don't guess.** A behavior nobody has decided goes under "Open questions" in the contract.
- **Write from the code in `known-issues/`.** Name the real class, file, and commit. Mark anything you inferred but did not run.
- **Keep the pages true.** A change that alters what a feature or a component does updates its contract in the same change. A fix deletes its known issue in the same change.
- Follow the `technical-writing` skill, then run the `unslop` skill over the page. Both come from [pstack](https://github.com/backnotprop/pstack). [AGENTS.md](../../AGENTS.md#upstream-skills) says how to install them.
- Use sentence-case headings, no emoji, and no em dashes.

## Add a page

- **A feature or a component.** Decide which it is by [the rule above](#put-a-contract-in-the-right-folder). Copy [_templates/contract.md](_templates/contract.md) into `features/` or `architecture/components/`, or into a subsystem folder there. Fill in every section. Add a known-issues page from [_templates/known-issues.md](_templates/known-issues.md) in the matching folder under `known-issues/`, and add a row to the table in [Contents](#contents).
- **A design decision.** Copy [_templates/decision.md](_templates/decision.md) into `architecture/decisions/` with the next free number, and add it to [the index](architecture/decisions/README.md).

## Other references

- [DESIGN.md](../../DESIGN.md): UI design tokens for `studio`, modeled on Cal.com.
