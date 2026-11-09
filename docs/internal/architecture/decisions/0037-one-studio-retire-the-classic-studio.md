---
title: "One studio: retire the classic studio"
id: "0037"
status: accepted
date: 2026-11-08
tags: [studio, studio-v3, rollout, routes, auth]
supersedes: ["0034"]
superseded_by: []
---

# 0037. One studio: retire the classic studio

## Context

[Decision 0034](0034-build-studio-v2-side-by-side-under-v2.md) built studio v2 as a second route tree under `/v2`, read-only in its first phases, beside the classic studio. Phases 0 and 1 went live on 2026-11-08. Every write still goes through a classic page: building, publishing, and pausing a journey, editing a segment, changing the catalog, creating a source key, and signing in. A marketer moves between two visual systems for one task, and the team maintains two UIs and two sets of tests.

On 2026-11-08 the owner asked to redesign all the UI and drop v1. Real marketers start using the studio soon, so the owner kept the full zero-downtime plan: both UIs live, a staged release per area, a move of browser drafts, redirects, and a soak.

Decision 0034 set cutover's rule loosely: cutover when every classic page has a v2 equivalent, and deletion once logs show two weeks without classic visits. It did not say how an unfinished v2 area reaches real users, how old URLs behave, or what happens to the `/v2` prefix.

## Decision

The classic studio is retired in stages, and one studio remains. This record replaces decision 0034's cutover section and its rule that v2 does not write. The rest of 0034 stands.

**v2 writes.** Each v2 write goes through a server action owned by its feature, which checks the session and the role itself. The classic actions stay untouched until they are deleted.

**Every route has a stage.** The studio shell's route table gives each v2 route one of three stages:

| Stage | Who reaches it |
|---|---|
| `preview` | Admins, and staff whose `system_users.preview` flag is true. The page carries a Preview badge and is absent from everyone else's sidebar and command palette. |
| `shipped` | Every staff user the route's role allows |
| `reserved` | Nobody. The path is held for a later design and has no page and no sidebar entry. |

An admin sets the preview flag with a documented SQL statement, because staff management has no screen ([AUTH-FR-20](../../features/admin-authentication.md)). The flag takes effect at the user's next request.

**The migration runs in steps, and each step reverts on its own.**

| Step | What happens |
|---|---|
| Shared modules | The journey model moves into one shared module that both builders import. The classic tests pass unchanged. |
| Tables | The draft, publish-record, and preview-flag DDL is applied before any image that reads it. |
| Preview | Each new v2 area ships at stage `preview`. |
| Area release | One area at a time moves to `shipped`, and the same change removes v2's links to classic for that area. The order is Data writes, Segments, the builder with lifecycle actions and new journeys, then sign-in, account, and settings. |
| Cutover | `/` and the sign-in default go to the v2 home. Every classic URL redirects to its v2 page in one hop with status 307, keeping the query string. |
| Soak | One week of normal use, watching redirect hits, 404s, and how many users still have drafts only in their browser |
| Remove classic | The classic pages, headers, actions, and tests are deleted. Redirects become 308. A test fails the build if any code imports from a deleted classic path. |
| Drop the prefix | v2 routes move from `/v2/...` to the root, and `/v2/:path*` redirects 308 to `/:path*`. Classic redirects are re-targeted to final paths, so every old URL still takes one hop. |
| Remove browser import | One release after classic removal, the browser-draft import goes. |

**Paths that never move.** `/login` and `/api/auth/*` stay where they are, because each identity provider has `/login` registered as the post-logout redirect and the callback path as the redirect URI. `/v1/business-events` is an API path and stays.

The owner chose the full zero-downtime plan on 2026-11-08. Dropping the `/v2` prefix and the stage model are the design writer's calls, and preview access for flagged editors is the lead's call. The owner approved the design on 2026-11-08.

## Why

**Stages let real users try a page before it replaces anything.** A `preview` area runs on the cluster with real data, used by the owner and named editors, while the classic page still serves everyone. Flipping a stage is a one-line change, so a bad release reverts in one pull request. The preview flag is a column rather than configuration, so granting it needs no restart.

**Redirects keep bookmarks working.** A marketer's bookmark to `/campaign/abc` must land on the same journey. One hop, with the query string kept, avoids redirect chains that browsers and logs both make hard to follow. Temporary redirects during the soak mean a browser does not cache a redirect the team might still revert.

**Dropping the prefix is cheap now and costly later.** Once the classic studio is gone, a version number in every URL is a permanent oddity, and it leaves `/segments` and `/platform` unused for no reason. One route table holds every path, so the move is one change plus one redirect rule.

**Deleting last keeps rollback a revert.** Until classic removal, every step reverts by reverting one pull request. Both builders save the same `campaigns.root` tree and `campaign_nodes` rows, so even classic removal reverts with no data step.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Keep `/v2` forever | A permanent version prefix after v1 is gone, and free top-level paths unused |
| A big-bang switch with no preview stage | Real marketers would meet every new page at once, with no trial on real data |
| Feature flags per user from a flag service | The platform has no flag store. A column on `system_users` does the job. |
| A staff-management screen to grant preview | [AUTH-FR-20](../../features/admin-authentication.md) forbids staff management in studio |
| Permanent redirects from day one | Browsers cache them, so reverting cutover during the soak would leave users on the wrong page |
| Delete classic at cutover | Removes the rollback path before a week of real use proves the v2 pages |

## Consequences

- The [studio shell](../../features/studio-shell.md) owns the route table, the stages, the redirect map, and the preview rule. One integrator owns every route-table and stage change, so feature lanes never edit the table at once.
- Each feature contract names the v2 routes and actions it writes through. The classic routes leave the contracts when the classic studio is removed.
- During the build, the classic studio changes only where a shared module moved, with its acceptance tests unchanged.
- `system_users` gains `preview boolean NOT NULL DEFAULT false`. The [data model](../data-model.md) lists it.
- The browser-draft move of [decision 0036](0036-store-journey-drafts-on-the-server-outside-cdc.md) runs during the build and the soak and is removed one release after classic removal.

## Related

- [Studio shell](../../features/studio-shell.md)
- [Admin authentication](../../features/admin-authentication.md)
- [Journey builder](../../features/journey-builder.md)
- [0034. Build studio v2 side by side under `/v2` in the same app](0034-build-studio-v2-side-by-side-under-v2.md)
- [0036. Store journey drafts on the server, outside CDC](0036-store-journey-drafts-on-the-server-outside-cdc.md)
