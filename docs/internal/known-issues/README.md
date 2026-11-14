# Known issues

A contract, in [features/](../features/) or [architecture/components/](../architecture/components/), says what a feature or a component must do. These pages say where the current code does not do it, and what else is wrong with it. They are the only feature pages that name classes, files, and commits. [Platform](platform.md) holds the gaps against [platform capacity](../architecture/capacity.md), and the build, tooling, and shared-code issues that no other contract owns.

Every issue has an id, a severity, and the requirement it breaks. Fix an issue and delete its entry in the same change.

| Feature | Blocking | Wrong result | Risk | Minor |
|---|---|---|---|---|
| [Event ingestion](components/event-ingestion.md) | 0 | 0 | 1 | 0 |
| [Identifiers](components/identity/identifiers.md) | 0 | 0 | 0 | 0 |
| [Identity stitching](components/identity/identity-stitching.md) | 0 | 0 | 0 | 0 |
| [Identity graph](components/identity/identity-graph.md), not built | 0 | 0 | 0 | 0 |
| [Identity merges](components/identity/identity-merges.md), not built | 0 | 0 | 0 | 0 |
| [Customer decision](components/customer-decision.md) | 0 | 2 | 0 | 0 |
| [Profile writer](components/profile-writer.md) | 1 | 0 | 0 | 1 |
| [Journey execution](components/journey-execution.md) | 0 | 0 | 0 | 1 |
| [Notification outbox](components/notification-outbox.md) | 0 | 0 | 0 | 0 |
| [Business event fan-out](components/business-event-fan-out.md) | 1 | 0 | 0 | 0 |
| [Segment membership pass](components/segment-membership-pass.md), not built | 1 | 0 | 0 | 0 |
| [Import applier](components/import-applier.md), not built | 0 | 0 | 0 | 0 |
| [Import metric pass](components/import-metric-pass.md) | 0 | 0 | 3 | 2 |
| [Schema migrations](components/schema-migrations.md) | 0 | 0 | 0 | 0 |
| [Journey builder](features/journey-builder.md) | 0 | 1 | 0 | 0 |
| [Campaign management](features/campaign-management.md) | 0 | 0 | 0 | 0 |
| [Event catalog](features/event-catalog.md) | 0 | 0 | 0 | 0 |
| [Segments](features/segments.md) | 0 | 0 | 0 | 1 |
| [AI journey generation](features/ai-journey-generation.md) | 0 | 0 | 0 | 0 |
| [Admin authentication](features/admin-authentication.md) | 0 | 0 | 0 | 0 |
| [Platform](platform.md) | 0 | 0 | 5 | 0 |
| [Data ingestion API](features/data-ingestion-api.md) | 1 | 0 | 3 | 0 |
| [Platform console](features/platform-console.md) | 0 | 0 | 2 | 1 |
| [Traffic simulator](features/traffic-simulator.md) | 0 | 0 | 0 | 0 |
| [Studio shell](features/studio-shell.md), not built | 0 | 0 | 0 | 0 |
| [Home overview](features/home-overview.md), not built | 0 | 0 | 0 | 0 |
| [Customer lookup](features/customer-lookup.md), not built | 0 | 0 | 1 | 1 |
| [Data health](features/data-health.md), not built | 0 | 0 | 1 | 0 |
| [Data import](features/data-import.md), not built | 0 | 0 | 0 | 0 |
| Total | 3 | 3 | 13 | 5 |

To recount one page, run `grep -cE '^\| [A-Z]+-KI-[0-9]+ \| Blocking \|' <page>.md`, with each severity in turn.

## What stops a journey today

No known issue stops every journey.

Write a new page from [the template](../_templates/known-issues.md).
