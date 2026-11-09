# About the product

This repo is a demo of a customer data platform (CDP) for an e-commerce site. It tracks what shoppers do, joins their devices into one profile, and runs marketing journeys that react to that behavior in near real time. The product is branded Salarose. The brand used in the demo data is Auroracy.

## Who uses it

| User | What they do | Where |
|---|---|---|
| Marketer (`editor` role) | Builds journeys, publishes and pauses campaigns, and defines segments. Watches journeys, looks up customers, and reads the event catalog in studio v2. | `studio`, `/campaign`, `/segments`, and `/v2` |
| Admin (`admin` role) | Everything an editor does, plus the event catalog, source keys, the platform page, and the dropped-input browser. The identity provider manages staff accounts, not studio. | `studio`, `/admin`, `/platform`, and `/v2` |
| Shopper | Generates events on the website or app, and receives messages | The tracked site, which is not in this repo |

## The problem it solves

Batch marketing tools segment customers overnight and send messages the next day. By then the shopper who left a cart has bought elsewhere. This platform reacts to each event as it arrives:

1. A shopper adds a phone to the cart and leaves.
2. Within seconds, the event reaches the journey engine with the shopper's stitched identity.
3. The journey waits one hour for a purchase. When the hour passes with no purchase, it requests a push message.

The time from event to decision is bounded by the Flink jobs, not by a batch schedule.

## Use cases

The 21 business use cases, and what the code supports today, are in [Use cases](use-cases.md).

No known issue stops every journey today. See [what stops a journey today](../known-issues/README.md#what-stops-a-journey-today). The [notification outbox](../architecture/components/notification-outbox.md) publishes each notification request, with its content, on `journey-engine-outbound-noti`. A sender outside this repo delivers it.

Studio v2, under `/v2`, adds the pages for staff's daily work: an overview, journey numbers per step, customer lookup, and data health. The [studio shell](../features/studio-shell.md) describes it, and [daily work in studio](use-cases.md#daily-work-in-studio) lists its use cases.

## Features

| Area | Feature |
|---|---|
| Data collection | [Event ingestion](../architecture/components/event-ingestion.md), [identity stitching](../architecture/components/identity/identity-stitching.md) |
| Behavior | [Customer decision](../architecture/components/customer-decision.md), [profile writer](../architecture/components/profile-writer.md) |
| Journeys | [Journey builder](../features/journey-builder.md), [AI journey generation](../features/ai-journey-generation.md), [campaign management](../features/campaign-management.md) |
| Runtime | [Customer decision](../architecture/components/customer-decision.md), [journey execution](../architecture/components/journey-execution.md), [notification outbox](../architecture/components/notification-outbox.md) |
| Daily work | [Studio shell](../features/studio-shell.md), [home overview](../features/home-overview.md), [customer lookup](../features/customer-lookup.md), [data health](../features/data-health.md), [segments](../features/segments.md) |
| Administration | [Admin authentication](../features/admin-authentication.md), [event catalog](../features/event-catalog.md), [platform console](../features/platform-console.md) |

## Related

- [Architecture overview](../architecture/overview.md)
- [Glossary](glossary.md)
- [Use cases](use-cases.md)
