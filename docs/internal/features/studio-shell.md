---
title: Studio shell
slug: studio-shell
purpose: Give marketers and admins one app shell for the studio, release each new area through a preview stage, and retire the classic studio without downtime or broken bookmarks.
status: accepted
implementation: partial
area: studio
tags: [ui, studio-v2, studio-v3, navigation, roles, routes]
created: 2026-11-07
updated: 2026-11-08
version: 1.0
known_issues: ../known-issues/features/studio-shell.md
---

# Studio shell

## Purpose

Studio v2 is the studio's second set of pages. Phases 0 and 1 run under `/v2` beside the classic studio and read only. Studio v3 makes v2 the only studio. Every write moves into v2, each new area reaches real users through a preview stage first, and the classic studio is retired once every area has shipped. The shell is what every v2 page has in common: the route table and its stages, the sidebar, the top bar, the command palette, the account and settings pages, the page states, the light theme, the time ranges, and the redirects that keep old URLs working. [Decision 0034](../architecture/decisions/0034-build-studio-v2-side-by-side-under-v2.md) explains why v2 was built side by side. [Decision 0037](../architecture/decisions/0037-one-studio-retire-the-classic-studio.md) explains the stages, the redirects, and the removal of the `/v2` prefix.

## Scope

In scope:

- The route table, the stage of each route, and which role may open each route.
- Preview access.
- The sidebar, the top bar, the account menu, and the command palette.
- The account page and the workspace settings page.
- The links between the classic studio and v2 until cutover.
- Cutover, the redirect map, and the removal of the `/v2` prefix.
- Loading, empty, error, and forbidden states.
- The theme: light only, for now.
- Time ranges, the previous period, and how v2 formats numbers and times.

Out of scope:

- The content of each page. [Home overview](home-overview.md), [customer lookup](customer-lookup.md), [data health](data-health.md), the [event catalog](event-catalog.md), the [journey builder](journey-builder.md), [campaign management](campaign-management.md), [segments](segments.md), and the [platform console](platform-console.md) own their pages.
- What the pages reserved for data import show. The [data import](data-import.md) contract owns them.
- Sign-in, sessions, and the sign-in page. [Admin authentication](admin-authentication.md) owns them.
- The visual system. [DESIGN.md](../../../DESIGN.md#app-patterns) holds the Salarose tokens and the app patterns. [Decision 0045](../architecture/decisions/0045-adopt-the-salarose-design-system-and-approve-a-visual-draft-before-ui-code.md) adopts them.

## Terms

| Term | Meaning |
|---|---|
| Classic studio | The studio pages outside `/v2`: `/campaign`, `/campaign/[id]`, `/segments`, `/admin`, `/admin/events`, `/admin/source-keys`, and `/platform`. |
| Studio v2 | The pages of [Routes](#routes). They live under `/v2` until the prefix drops, and at the root after it. |
| Shell | The parts every v2 page shares: sidebar, top bar, command palette, and page states. |
| Stage | Where a route is in its release: `preview`, `shipped`, or `reserved`. See [Stages](#stages). |
| Preview flag | The column `system_users.preview`, false by default. It opens routes at stage `preview` to the staff user. |
| Preview viewer | An admin, or a staff user whose preview flag is true. |
| Area | A group of routes and controls that moves from `preview` to `shipped` in one release. See [Staged release](#staged-release). |
| Cutover | The release, after every area has shipped, that sends `/` and the sign-in landing to v2 and redirects every classic URL. |
| Soak | The week after cutover, during which the classic code stays deployed and unreachable. |
| Classic removal | The release after the soak that deletes the classic pages. |
| Prefix drop | The release after classic removal that moves every v2 route from `/v2/...` to the root. |
| Data region | A part of a page that loads its own data, such as one KPI card or one table. |
| Viewer | The signed-in staff user who opens a page. |
| Viewer's time zone | The IANA time zone that the viewer's browser reports, such as `Asia/Ho_Chi_Minh`. UTC when the browser sends none or an invalid one. |
| Time range | The span of time a page counts over: Today, Last 7 days, or Last 30 days. See [Time ranges](#time-ranges). |
| Previous period | The span of the same length just before a time range, used for the change shown next to a number. |

## Behavior

Lan is an editor. An admin has set her preview flag so she can try the new journey builder. She signs in and lands on `/campaign`, as before cutover. The classic header links to v2 with **Try the new studio**. She clicks it and lands on the v2 home at `/v2`. The sidebar lists Home, Journeys, Audience, and Customers, then a DATA group. She presses Ctrl+K and picks **Create journey**, which carries a Preview badge, and `/v2/journeys/new` opens. Her colleague Hoa has no preview flag. Hoa's palette offers no **Create journey**, and a request for `/v2/journeys/new` gets the not-found page. From the account menu she picks **Account** and sees her email, her role, her provider, when her session expires, and that she has preview access.

Minh is an admin. His sidebar also lists Sources and Privacy under DATA, and an ADMIN group with Platform and Settings. When Lan pastes the address of the source keys page into her browser, she sees the forbidden state and no keys.

A week after the last area ships, cutover sends a bookmark to `/campaign/CAMP-4f1c9a0b2d3e5f67` to `/v2/journeys/CAMP-4f1c9a0b2d3e5f67` in one hop. After the prefix drops, the same bookmark lands on `/journeys/CAMP-4f1c9a0b2d3e5f67`, still in one hop.

### Routes

This contract writes each route as its final path. Until the prefix drops, every route except `/login` lives under `/v2`, so Home is `/v2` and `/journeys` is `/v2/journeys`. `/login`, the routes under `/api/`, and `/v1/business-events` never move. The identity providers have `/login` registered as the post-logout redirect ([AUTH-FR-14](admin-authentication.md#functional-requirements)) and the callback path as the redirect URI.

The Stage column gives each route's stage when studio v3 starts. The release that changes a stage changes this table in the same change. A route that is not built does not exist, and it arrives at stage `preview`. The last column holds until cutover and is deleted at cutover.

| Route | Page | Who may open it | Stage | Classic page for **Back to classic**, until cutover |
|---|---|---|---|---|
| `/login` | Sign in, [admin authentication](admin-authentication.md#sign-in). Redesigned in place. | Public | `shipped` | None. The page has no shell. |
| `/` | [Home overview](home-overview.md) | Any staff user | `shipped` | `/campaign` |
| `/journeys` | [Journey list](journey-builder.md#journey-pages), with lifecycle actions | Any staff user. Lifecycle actions follow [campaign management](campaign-management.md). | `shipped`. The lifecycle actions are at `preview`. | `/campaign` |
| `/journeys/new` | Start a journey: blank, template, or describe it ([journey builder](journey-builder.md)) | Any staff user | `preview` | `/campaign/new` |
| `/journeys/[id]` | A draft opens the builder. A published journey opens [Analytics](journey-builder.md#node-analytics), with a Journey tab. | Any staff user. Editing follows [campaign management](campaign-management.md). | `shipped` for Analytics. The builder, the Journey tab, and the lifecycle actions are at `preview`. | `/campaign/[id]` for the owner of a published journey or an admin. `/campaign` for anyone else, whom the classic builder refuses, and for a draft. |
| `/segments` | [Segment list](segments.md), with where-used and size | Any staff user | `shipped`. Edit, delete, and **New segment** are at `preview`. | `/segments` |
| `/segments/new`, `/segments/[id]` | [Segment editor](segments.md) | Any staff user | `preview` | `/segments` |
| `/customers`, `/customers/[canonId]` | [Customer search and profile](customer-lookup.md) | Any staff user | `shipped` | `/campaign` |
| `/data/events` | [Event catalog view](data-health.md#event-catalog-view), with **Add event** for admins | Any staff user. Changes: admin. | `shipped`. **Add event** is at `preview`. | `/admin/events` for an admin, `/campaign` for an editor |
| `/data/events/[id]` | [Event detail](event-catalog.md#event-detail-page) | Any staff user. Changes: admin. | `preview` | `/admin/events` for an admin, `/campaign` for an editor |
| `/data/sources` | [Source keys](data-health.md#source-keys-view), with create and revoke | Admin | `shipped`. Create and revoke are at `preview`. | `/admin/source-keys` |
| `/data/monitoring` | Monitoring: Overview, Dropped data, and Dashboards ([data health](data-health.md)). Dropped data replaces the dead-letter page at `/data/dead-letters`, which redirects to `/data/monitoring?tab=dropped` ([DHL-FR-05](data-health.md#functional-requirements)). | Any staff user. The dropped records themselves: admin, as data health says. | `preview`. Monitoring is a new page, so it arrives at `preview` like every new route. Until it ships, staff who lack preview access and follow the old dead-letter link get the not-found page, as SHL-FR-22 says. | `/campaign` |
| `/data/tracking` | Tracking setup guide ([data health](data-health.md)) | Any staff user | `preview` | `/campaign` |
| `/data/datasets`, `/data/imports`, `/data/metrics` | Reserved for [data import](data-import.md). `/data/datasets` replaces `/data/record-types`. | As the data import contract says | `reserved` | None |
| `/data/privacy` | Reserved for [data import](data-import.md) | Admin | `reserved` | None |
| `/platform` | [Platform console](platform-console.md) | Admin | `shipped` | `/platform` |
| `/account` | [Your account](#account-page) | Any staff user | `preview` | `/campaign` |
| `/settings` | [Workspace settings](#settings-page) | Admin | `preview` | `/campaign` |

`/login` is public, so it has no preview stage. Its redesign replaces the page in one release, at the Access step of [Staged release](#staged-release).

### Stages

| Stage | Who reaches the route |
|---|---|
| `preview` | Preview viewers whose role the Who column allows. The sidebar entry and the page header carry a Preview badge. Nobody else sees the route in the sidebar or the palette, and a request from anybody else gets the not-found page, as for a route that does not exist. |
| `shipped` | Every staff user whose role the Who column allows |
| `reserved` | Nobody. The path has no page and no sidebar entry. The data import contract fills it. |

The preview flag narrows who reaches a route and never widens the Who column. An editor with the flag still gets the forbidden state on an admin route. A control that an area adds to a `shipped` route, such as **New segment** on `/segments`, follows the same rule while its area is at `preview`. Preview viewers see it with a Preview badge, and everyone else sees the page as it was, classic links included.

### Preview access

An admin grants preview access by setting `system_users.preview` to true with the SQL statement in the operations docs, and revokes it by setting it to false. Studio has no screen for it, because [AUTH-FR-20](admin-authentication.md#functional-requirements) forbids staff management in studio. The session check reads the flag from `system_users` on every request, so a change applies at the user's next request, with no restart and no new sign-in. Sign-in never writes the flag. [Settings](#settings-page) lists the staff who have it.

### Staged release

Each area moves from `preview` to `shipped` in its own release, in this order. The release that ships an area also removes v2's in-page links to classic pages for that area, such as **Manage in classic**. **Back to classic** in the account menu stays until cutover.

| Order | Area | Routes and controls |
|---|---|---|
| 1 | Data writes | **Add event** on `/data/events`, `/data/events/[id]`, and create and revoke on `/data/sources` |
| 2 | Segments | Edit, delete, and **New segment** on `/segments`, and `/segments/new` and `/segments/[id]` |
| 3 | Builder | `/journeys/new`, the builder and the Journey tab on `/journeys/[id]`, and the lifecycle actions on `/journeys` and `/journeys/[id]` |
| 4 | Access | The redesigned `/login`, `/account`, and `/settings` |

Reverting a release moves its area back to `preview`.

### Sidebar

The sidebar shows the Salarose mark and name at the top, then these entries in order. An entry shows only to a viewer whose role may open its route, and only while its route is not `reserved`.

| Group | Entry | Route | Who sees it |
|---|---|---|---|
| None | Home | `/` | Any staff user |
| None | Journeys | `/journeys` | Any staff user |
| None | Audience | `/segments`. The sidebar says Audience, and the page title says Segments. | Any staff user |
| None | Customers | `/customers` | Any staff user |
| DATA | Events | `/data/events` | Any staff user |
| DATA | Monitoring | `/data/monitoring` | Any staff user |
| DATA | Tracking setup | `/data/tracking` | Any staff user |
| DATA | Sources | `/data/sources` | Admin |
| DATA | Metrics | `/data/metrics` | As the data import contract says |
| DATA | Datasets | `/data/datasets` | As the data import contract says |
| DATA | Imports | `/data/imports` | As the data import contract says |
| DATA | Privacy | `/data/privacy` | Admin |
| ADMIN | Platform | `/platform` | Admin |
| ADMIN | Settings | `/settings` | Admin |

A group label shows only when the viewer sees an entry under it, so an editor sees no ADMIN label. An entry whose route or area is at `preview` carries a Preview badge. Account lives in the account menu, not the sidebar. The entry of the current page is highlighted. The sidebar is 240 px wide and collapses to a 64 px rail of icons, where hovering or focusing an icon shows its name and a small dot marks a Preview page. **Collapse sidebar** at the bottom collapses it. The browser remembers the collapsed state. While the journey builder is open, the sidebar collapses to its rail, and the viewer's own collapsed state comes back on the next page. Below 768 px of window width the sidebar is hidden and opens as a sheet from a menu button in the top bar.

### Top bar

The top bar shows a breadcrumb, the search button, and the account menu. The breadcrumb is the workspace name, then the current page, such as "Mộc Lan Shop / Home". The workspace name comes from the deployment's configuration and is "Studio" when none is set. The search button reads "Search or jump to…" with its shortcut, Ctrl K, and opens the command palette. The account menu opens from an avatar with the viewer's initials. It shows the viewer's name and role, email, role, and whether they have preview access, then **Account**, which opens `/account`, and **Sign out**, which posts to `/api/auth/logout`. Until cutover it also shows **Back to classic**. The top bar has no theme switch.

### Command palette

Ctrl+K, or Cmd+K on macOS, opens the palette from any v2 page. It offers:

- Every page in the sidebar that the viewer may open.
- **Create journey**, which opens `/journeys/new`.
- **New segment**, which opens `/segments/new`.
- For admins, **Add event**, which opens `/data/events` with the **Add event** dialog open.
- Journeys by name, from `campaigns`. Picking one opens `/journeys/[id]`.
- Segments by name, from `segments`. Picking one opens `/segments/[id]` when the viewer may reach that route, and `/segments` with that segment selected otherwise.
- **Look up customer "…"** with the typed text. Picking it opens `/customers?q=` with the text.

A target follows SHL-FR-04 and the stage of its route or control, so a viewer who may not reach the target does not see it. Matching ignores case and finds the typed text anywhere in a name. The palette shows at most 8 journeys and 8 segments. Arrow keys move, Enter picks, and Escape closes.

### Account page

`/account` is open to any staff user. Its header shows an avatar with the viewer's initials, the viewer's name, email, and role, a tag with the workspace name, and the subtitle "Your identity provider manages your email and role." When no name is known, the header shows the email in its place and the initials come from the email. The page body shows the viewer's email, role, the provider they signed in with, when the session expires, and whether they have preview access. It shows the time zone the shell uses from the `tz` cookie, and has **Sign out**, which ends every studio session the viewer has. It has no theme switch while the studio has one theme. The provider owns identity, so the page offers no password or profile editing.

### Settings page

`/settings` is open to admins only. A Workspace section shows, read-only and read from the deployment's configuration: the workspace name, the sign-in providers by name, the session length, whether AI journey generation is configured, and the AI generation rate limits. Each value says "Set by the deployment". The page never shows a secret, a client id, or a key. A second section lists the staff with preview access, by email and role, and says that admins always have preview access and that access is granted in the database. It carries the note "Read only. Studio has no screen to grant access." When no staff user has the flag, the list says "No staff member has the preview flag. Admins still see preview pages." When a configured AI generation rate limit is not a positive whole number, the rate limits show "Not available. A limit is invalid, so AI generation refuses requests." in place of the values. Later contracts add sections. The [data import](data-import.md) contract adds a Data import section, with the default phone country and the reporting time zone, at stage `preview`. Delivery rules come later.

### Page states

Each data region loads on its own, so a slow or failed region never blocks the rest of the page.

| State | What the region shows |
|---|---|
| Loading | A skeleton with the size and layout of the loaded region, so nothing moves when the data arrives |
| Empty | One sentence that says why the region is empty and what to do next, with an action button when the viewer may take that action |
| Error | A fixed sentence that names what failed, such as "Journey numbers could not load", and a **Try again** button. No error text from the server, no stack trace, and no ids. |
| Forbidden | For a whole page an editor may not open: "This page is for admins.", "Ask an admin if you need something from it.", and **Go to Home**. The response holds none of the page's data. |
| Not found | For an unknown address, and for a route at `preview` that the viewer may not reach: "404", "We couldn't find that page.", "The address may be wrong, or the page may have moved.", and **Go to Home**. |
| Not available | For a number that cannot be computed: a dash and "Not available:" with the reason, never 0, as SHL-FR-17 says |

An outcome of an action, such as a copied value or a published journey, shows as a toast. A confirmation is a dialog of the page. v2 never uses a browser alert or a native confirm dialog.

### Time ranges

Pages that count over time offer three ranges, in the viewer's time zone. `now` is the time of the request.

| Range | Start | End | Previous period |
|---|---|---|---|
| Today | Midnight that starts today | `now` | Midnight that started yesterday, to `now` minus one calendar day |
| Last 7 days | Midnight 6 calendar days before today | `now` | The same span moved back 7 calendar days |
| Last 30 days | Midnight 29 calendar days before today | `now` | The same span moved back 30 calendar days |

A time `t` is in a range when `start <= t < end`. Moving back by calendar days keeps the wall-clock times, so a day with a daylight saving change is 23 or 25 hours long. The previous period of Today covers the same hours of yesterday, so a morning compares with the morning before it. Daily series use calendar days in the viewer's time zone. The range picker names the time zone, such as "Times in Asia/Ho_Chi_Minh". The shell writes the browser's time zone to the `tz` cookie on every v2 page load, and the server reads the zone from that cookie. On a first visit the request carries no cookie, so the server renders in UTC. When the zone the server used differs from the browser's, the shell writes the cookie and refreshes the page's data regions once, without reloading the page. If the zone still differs after that refresh, as when the browser blocks cookies, the page stays in UTC. The chosen range stays in the page's address, as `?range=today`, `7d`, or `30d`. The address does not carry the zone, so a copied link opens the same range in the time zone of whoever opens it. Last 7 days is the default. These rules are the lead's default: the platform has no workspace time zone, and the viewer's own day is what a marketer means by "today".

### Change against the previous period

A count or a duration with a previous period shows its change as a percentage, `(current - previous) / previous`, rounded to a whole percent. A rate, such as watch success, shows its change in percentage points, computed from the two whole percents on screen, so 41% against 44% reads "-3 pts". When the previous count is 0, the change reads "New" if the current count is above 0, and "No change" if it is 0 too. A rate whose previous period had nothing to divide, such as no finished watch, shows no change. A duration whose previous period had no activity, or was 0 s, shows no change, since a percentage of nothing is undefined. Each number says whether up is good. For counts, up is good. For lag, up is bad. The change is green when it moves the good way, red when it moves the bad way, and gray when it reads 0% or 0 pts.

### Numbers and times

Counts use the viewer's locale for thousands separators, such as `12,480`. Rates are whole percents. Durations use the largest two units that apply, such as `4 min 12 s` or `2 h 5 min`. Times within the last 24 hours read relative, such as "12 min ago", with the exact time on hover. Older times show the date and time in the viewer's time zone.

### Theme

The studio has one theme, Light, from the Salarose tokens in DESIGN.md, until the owner adds a dark theme to the design system. The owner instructed this on 2026-11-08 ([decision 0045](../architecture/decisions/0045-adopt-the-salarose-design-system-and-approve-a-visual-draft-before-ui-code.md)). The Account board's Light and Dark choice under Preferences, and the "Switch to dark theme" button in its top bar, are leftovers from the v2 shell. This contract overrides them. v2 shows no theme switch, does not read the `theme` cookie, and does not write it. The classic studio keeps reading the cookie until classic removal.

### Copy

The UI says what the marketer means, not what the code calls it. No engineering terms such as "predicate" or "canon id" in labels, no emoji as icons, and no raw id as a row's main label. An id may appear as secondary text where a person needs it, such as a customer's id on their profile. Icons come from one icon set.

### Until cutover, the classic studio stays as it is

Both studios run until cutover. A classic page changes only where a module it shares with v2 moved, and then its routes, behavior, and writes stay the same and its acceptance tests pass unchanged. Its two headers, the marketer header and the admin header, keep the **Try the new studio** link to the v2 home. After sign-in without a return path, staff land on `/campaign`.

v2 writes only through the actions that a feature contract names, and each action checks the session and the role on the server before it writes. The classic actions stay untouched until classic removal.

### Cutover and redirects

Cutover comes after every area has shipped. From cutover, `/` and the sign-in landing go to the v2 home, and every classic URL redirects to its v2 page. The classic code stays deployed and unreachable for the one-week soak, then classic removal deletes it. The prefix drop comes after classic removal.

Redirect map:

| Old URL | From cutover | After the prefix drops |
|---|---|---|
| `/` | `/v2` | No redirect. `/` is Home. |
| `/campaign` | `/v2/journeys` | `/journeys` |
| `/campaign/new` | `/v2/journeys/new` | `/journeys/new` |
| `/campaign/[id]` | `/v2/journeys/[id]` | `/journeys/[id]` |
| `/segments` | `/v2/segments` | No redirect. `/segments` is the segment list. |
| `/admin`, `/admin/events` | `/v2/data/events` | `/data/events` |
| `/admin/source-keys` | `/v2/data/sources` | `/data/sources` |
| `/platform` | `/v2/platform` | No redirect. `/platform` is the platform console. |
| `/v2/data/dead-letters` | `/v2/data/monitoring?tab=dropped`. This redirect starts when Monitoring is built, before cutover. | `/data/monitoring?tab=dropped` |
| `/v2` and `/v2/[path]` | No redirect. These are the v2 pages. | `/` and `/[path]` |

Every redirect:

- Takes one hop. No target is itself redirected. The prefix drop re-targets the classic redirects to final paths, so a classic URL never redirects through a `/v2` URL.
- Keeps the query string.
- Uses status 307 from cutover until classic removal, so a browser does not cache a redirect that a reverted cutover would undo. From classic removal, every redirect uses 308.

`/campaign/new` matches before `/campaign/[id]`. `/login`, the routes under `/api/`, and `/v1/business-events` never redirect.

A classic URL for a draft that lives only in the viewer's browser redirects to `/v2/journeys/[id]`. No server draft or campaign has that id, so the page shows the browser-draft move banner with "This draft is still in your browser", not "does not exist". The [journey builder](journey-builder.md) owns that banner and the move.

## Functional requirements

| Id | Requirement |
|---|---|
| SHL-FR-01 | Every studio page must live at its route in [Routes](#routes), with the route's stage. Until the prefix drops, every route except `/login` must live under `/v2`, with Home at `/v2`. A route that is not built must not exist. A route at stage `reserved` must have no page and no sidebar entry. `/login`, the routes under `/api/`, and `/v1/business-events` must never move. |
| SHL-FR-02 | A request to a studio page without a valid session must redirect to `/login` with the requested path as the return path, and the viewer must land on that path after sign-in. |
| SHL-FR-03 | A route marked Admin must be refused for an editor, on the server, with the forbidden state of [Page states](#page-states), whatever the editor's preview flag. The response must hold none of the page's data. |
| SHL-FR-04 | The sidebar and the command palette must not offer a page that the viewer's role may not open. |
| SHL-FR-05 | The sidebar must list the entries of [Sidebar](#sidebar), highlight the current one, collapse to icons, remember the collapsed state in the browser, and open as a sheet below 768 px of window width. While the journey builder is open, it must collapse to its rail and restore the viewer's own state on the next page. |
| SHL-FR-06 | The top bar must show the breadcrumb of the workspace name and the current page, the search button with its shortcut, and the account menu with the viewer's name, email, role, preview access, **Account**, and **Sign out**. Until cutover, the account menu must also show **Back to classic**. The top bar must show no theme switch. |
| SHL-FR-07 | Ctrl+K and Cmd+K must open the command palette on every v2 page. The palette must offer the targets in [Command palette](#command-palette), with keyboard navigation. |
| SHL-FR-08 | Until cutover, both classic headers must show a **Try the new studio** link to the v2 home, and **Back to classic** must open the classic page that [Routes](#routes) names for the current v2 page and the viewer's role. At cutover, **Back to classic** must leave the account menu. |
| SHL-FR-09 | After sign-in without a return path, staff must land on `/campaign` until cutover, and on Home from cutover, which is `/v2` until the prefix drops and `/` after it. |
| SHL-FR-10 | Until cutover, a classic page may change only where a module it shares with v2 moved, with no change to its routes, behavior, or writes, and every classic acceptance test must pass unchanged. From cutover, every classic URL must redirect as SHL-FR-21 says. |
| SHL-FR-11 | v2 must write to a table, or produce a record to a topic, only through an action that a feature contract names. Each action must check the session and the role on the server before it writes, and must write nothing when either check fails. **Sign out** uses the existing sign-out route. The consumer groups of the dead-letter browser ([DHL-FR-08](data-health.md#functional-requirements)) are not a write by studio, though the broker records their membership in its internal offsets topic. |
| SHL-FR-12 | Each data region must have its own loading, empty, and error state, as [Page states](#page-states) describes. One region's failure must not stop another region from loading. |
| SHL-FR-13 | v2 must show an action's outcome as a toast and must never use a browser alert or a native confirm dialog. |
| SHL-FR-14 | Every v2 page must render in the light theme from the Salarose tokens of DESIGN.md. v2 must show no theme switch and must not write the `theme` cookie. |
| SHL-FR-15 | Every page that counts over time must use the ranges, boundaries, previous periods, and time zone rules of [Time ranges](#time-ranges), must read the zone from the `tz` cookie, and must keep the range in the address. |
| SHL-FR-16 | Every change against a previous period must follow [Change against the previous period](#change-against-the-previous-period). |
| SHL-FR-17 | v2 must not show a number that no table or topic backs. A number v2 cannot compute shows as "Not available" with the reason, never as 0. |
| SHL-FR-18 | Labels and messages must follow [Copy](#copy). |
| SHL-FR-19 | `/account` must be open to any staff user and must show the viewer's email, role, provider, session expiry, and preview access, with the time zone and **Sign out**. Its header must show the viewer's initials, name, email, role, the workspace name as a tag, and the subtitle of [Account page](#account-page), with the email in place of a missing name. It must offer no identity editing and no theme switch. |
| SHL-FR-20 | `/settings` must be admin-only. It must show the workspace configuration of [Settings page](#settings-page) read-only, each value marked as set by the deployment, with no secret, and must list the staff with preview access with the "Read only" note. An empty list must show its empty sentence, and an invalid AI rate limit must show "Not available" with its reason, as [Settings page](#settings-page) says. |
| SHL-FR-21 | From cutover, every classic URL must redirect in one hop to its v2 page, per the [redirect map](#cutover-and-redirects), keeping the query string, with status 307 until classic removal and 308 from then on. After the prefix drops, every `/v2/...` URL must redirect with status 308 in one hop to the same path without `/v2`, and every classic URL must redirect in one hop to its final path. From the release that builds Monitoring, `/v2/data/dead-letters` must redirect in one hop to `/v2/data/monitoring?tab=dropped`, and `/data/dead-letters` to `/data/monitoring?tab=dropped` after the prefix drops. |
| SHL-FR-22 | A route at stage `preview` must be reachable only by admins and by staff whose `system_users.preview` is true, within the roles the route allows. It must carry a Preview badge, and must not appear in anyone else's sidebar or palette. Anyone else's request must get the not-found page and none of the page's data. A control that an area at `preview` adds to a `shipped` route must follow the same rule. |

## Non-functional requirements

| Id | Requirement |
|---|---|
| SHL-NFR-01 | The shell of a v2 page, without its data regions, must reach the browser within 1 second of the request at the 95th percentile. |
| SHL-NFR-02 | Every interactive element must be reachable and usable with the keyboard alone, with a visible focus ring. |
| SHL-NFR-03 | Text and the controls' boundaries must meet WCAG 2.1 AA contrast in the light theme. |
| SHL-NFR-04 | The full layout must work from 1024 px of window width. From 768 px to 1023 px the sidebar starts collapsed. Below 768 px it opens as a sheet. |
| SHL-NFR-05 | A studio deploy must not take studio down, the classic studio included until classic removal. Studio keeps its rolling restart. |

## Interfaces

| Direction | Interface | Use |
|---|---|---|
| UI | The routes in [Routes](#routes), under `/v2` until the prefix drops | The v2 pages |
| UI | The classic headers, until cutover | The **Try the new studio** link |
| HTTP | The redirects of the [redirect map](#cutover-and-redirects) | Status 307 from cutover, 308 from classic removal, `Location` with the query string kept |
| Read | Session cookie, `system_users`: `role`, `preview` | Who the viewer is, their role, and their preview flag, as [admin authentication](admin-authentication.md) defines |
| Read | Session cookie: `idp`, `exp` | The provider and the session expiry on `/account` |
| Read | `system_users`: `email`, `role`, where `preview` is true | The preview list on `/settings` |
| Read and write | Cookie `tz` | The viewer's IANA time zone, written by the browser, read by the server |
| Read | `campaigns`, `segments` | Command palette search |
| Write | `POST /api/auth/logout` | Sign out |
| Read | Studio's configuration | The workspace name, and the read-only values on `/settings` |

## Failure handling

| Case | Behavior |
|---|---|
| The session expired | The next request redirects to `/login` with the return path, as SHL-FR-02 says. |
| The database is down | The shell renders. Each data region shows its error state. |
| The browser sends no time zone | Ranges use UTC, and the range picker says "Times in UTC". |
| An unknown range in the address | The page uses Last 7 days and rewrites the address. |
| The command palette search fails | The palette still offers the pages and the create targets, and says that journeys and segments could not load. |
| A viewer without preview access follows a link to a route at `preview` | The not-found page, as SHL-FR-22 says. |
| A setting on `/settings` is missing from the configuration | The value reads "Not set". |

## Acceptance criteria

- Given a signed-in editor on `/campaign` before cutover, when she clicks **Try the new studio**, then `/v2` opens with the sidebar and the top bar. (SHL-FR-01, SHL-FR-08)
- Given the route table before the prefix drops, then every route except `/login` resolves under `/v2`, and `/v2/data/imports`, `/v2/data/datasets`, `/v2/data/metrics`, and `/v2/data/privacy` get the not-found page and have no sidebar entry. (SHL-FR-01)
- Given no session, when a browser requests `/v2/journeys`, then it is redirected to `/login`, and after sign-in it lands on `/v2/journeys`. (SHL-FR-02)
- Given an editor, when she requests `/v2/data/sources`, then the page shows "This page is for admins." and **Go to Home**, and the response holds no source key. Given an editor whose preview flag is true, when she requests `/v2/settings` at stage `preview`, then she gets the same forbidden state. (SHL-FR-03)
- Given an editor, then the sidebar and the command palette offer no Sources, Privacy, Platform, Settings, or **Add event** entry, and the sidebar shows no ADMIN label. Given an admin, they offer every one whose route is not `reserved`. (SHL-FR-04)
- Given an admin and every route out of `reserved`, then the sidebar lists Home, Journeys, Audience, Customers, then DATA: Events, Monitoring, Tracking setup, Sources, Metrics, Datasets, Imports, Privacy, then ADMIN: Platform, Settings, in that order, and Audience opens a page titled Segments. (SHL-FR-05)
- Given the sidebar collapsed, when the viewer reloads the page, then it is still collapsed. (SHL-FR-05)
- Given the sidebar expanded, when the viewer opens a journey in the builder, then the sidebar shows its rail, and when the viewer then opens `/v2/segments`, the sidebar is expanded again. (SHL-FR-05)
- Given a window 700 px wide, then the sidebar is hidden and the menu button opens it as a sheet. (SHL-FR-05, SHL-NFR-04)
- Given a signed-in admin before cutover on Home, then the top bar shows the breadcrumb "<workspace name> / Home", the search button with Ctrl K, and an account menu with the admin's name, email, the role Admin, preview access, **Account**, **Back to classic**, and **Sign out**, and no theme switch. Given cutover deployed, the menu has no **Back to classic**. Given no configured name, the breadcrumb starts with "Studio". (SHL-FR-06, SHL-FR-08)
- Given `/v2/journeys/CAMP-4f1c9a0b2d3e5f67` before cutover and its owner, when the owner picks **Back to classic**, then `/campaign/CAMP-4f1c9a0b2d3e5f67` opens. Given an editor who does not own it, `/campaign` opens. Given `/v2/data/events` and an editor, then `/campaign` opens. (SHL-FR-08)
- Given a journey named "Cart abandonment", when the viewer presses Ctrl+K and types "CART", then the palette offers it, and Enter opens its page. (SHL-FR-07)
- Given an admin who is a preview viewer and the builder and segment areas at `preview`, when he opens the palette, then it offers **Create journey**, **New segment**, and **Add event**, and each opens `/v2/journeys/new`, `/v2/segments/new`, and `/v2/data/events` with the **Add event** dialog open. Given an editor without preview access, the palette offers none of the three. (SHL-FR-07, SHL-FR-22)
- Given a signed-in user before cutover who signs in again without a return path, then they land on `/campaign`. Given cutover deployed, they land on `/v2`. Given the prefix dropped, they land on `/`. (SHL-FR-09)
- Given any release before cutover, when every classic acceptance test runs, then each passes unchanged. (SHL-FR-10)
- Given every v2 action that writes, when it is called with no session, or by an editor where its feature contract requires an admin, then it returns an error and no row changes. (SHL-FR-11)
- Given a viewer who opens every v2 page and uses every read-only control on it, then no row in any table changes, and studio produces no record to any topic. The broker's group records for the dead-letter browser's reads may appear in its internal offsets topic. (SHL-FR-11)
- Given the KPI query of the home overview fails, then the KPI cards show their error state with **Try again**, and the journeys table still loads. (SHL-FR-12)
- Given any v2 action with an outcome, such as copying a value, then a toast reports it, and no browser alert or native confirm opens on any v2 page. (SHL-FR-13)
- Given any v2 page, then it renders with the light Salarose tokens, shows no theme switch, and its response sets no `theme` cookie. Given a `theme` cookie of `dark`, v2 still renders light. (SHL-FR-14)
- Given the viewer's time zone `Asia/Ho_Chi_Minh` and `now` 2026-11-10T09:30 local, then Today is 2026-11-10T00:00 to 09:30 local, and its previous period is 2026-11-09T00:00 to 09:30 local. Last 7 days starts 2026-11-04T00:00 local. (SHL-FR-15)
- Given a first visit from a browser in `Asia/Ho_Chi_Minh` with no `tz` cookie, then the first render is in UTC, the data regions refresh once, and the page then says "Times in Asia/Ho_Chi_Minh". Given a browser that blocks cookies, the page stays in UTC and refreshes no more than once. (SHL-FR-15)
- Given a count of 120 against 100 in the previous period, then the change reads "+20%" in green. Given 0 against 0, it reads "No change". Given 5 against 0, it reads "New". Given a lag of 90 s against 60 s, the change reads "+50%" in red. Given watch success of 41% against 44%, it reads "-3 pts" in red, even when the unrounded rates differ by 2.6 points. Given watch success of 41% against a previous period with no finished watch, no change shows. Given a lag p95 of 2 s against a previous period with no activity, or against 0 s, no change shows. (SHL-FR-16)
- Given a number that its query cannot compute, then the card shows "Not available" and the reason, not 0. (SHL-FR-17)
- Given every v2 page, then no label is an emoji, a raw id as a row's main label, or a server error text. (SHL-FR-18)
- Given an editor signed in at the provider `keycloak` with preview access, when she opens `/v2/account`, then it shows her email, the role Editor, the provider's name, her session's expiry time, and "Preview access: on", with her time zone and **Sign out**, and no field to edit her email or password and no theme switch. Given her name "Lan Nguyen" and the workspace "Mộc Lan Shop", the header shows "LN", "Lan Nguyen", her email, Editor, the tag "Mộc Lan Shop", and "Your identity provider manages your email and role." Given no name, the header shows her email in place of the name. (SHL-FR-19)
- Given an editor, when she requests `/v2/settings`, then she gets the forbidden state. Given an admin and a deployment with AI generation configured, then the page shows the workspace name, the providers, the session length, "AI generation: configured", and the rate limits, each marked "Set by the deployment", the response holds no client secret or API key, and the preview list names every staff user whose preview flag is true, under "Read only. Studio has no screen to grant access." Given no staff user with the flag, the list says "No staff member has the preview flag. Admins still see preview pages." Given an AI rate limit of `-1` or `abc`, the rate limits show "Not available. A limit is invalid, so AI generation refuses requests." (SHL-FR-20)
- Given cutover deployed, when a browser requests `/campaign/CAMP-4f1c9a0b2d3e5f67?range=7d`, then the response is 307 to `/v2/journeys/CAMP-4f1c9a0b2d3e5f67?range=7d`, and that page answers without a further redirect. Given `/campaign/new`, the target is `/v2/journeys/new`. Given `/admin/source-keys`, the target is `/v2/data/sources`. (SHL-FR-21)
- Given classic removal deployed, when a browser requests `/admin/events`, then the response is 308 to `/v2/data/events`. (SHL-FR-21)
- Given the prefix dropped, when a browser requests `/v2/segments/abc?x=1`, then the response is 308 to `/segments/abc?x=1`. Given `/campaign/CAMP-4f1c9a0b2d3e5f67`, then the response is 308 to `/journeys/CAMP-4f1c9a0b2d3e5f67` in one hop. Given `/segments` or `/platform`, then the page itself answers with no redirect. (SHL-FR-21)
- Given Monitoring built, when a browser requests `/v2/data/dead-letters`, then the response redirects in one hop to `/v2/data/monitoring?tab=dropped`. Given the prefix dropped, `/data/dead-letters` redirects to `/data/monitoring?tab=dropped`. (SHL-FR-21, DHL-FR-05)
- Given every old URL in the redirect map and a request for each at each release from cutover on, then each ends on a page that answers 200 after at most one redirect. (SHL-FR-21)
- Given `/login`, `/api/auth/oidc/callback`, and `/v1/business-events` after the prefix drops, then none redirects. (SHL-FR-01, SHL-FR-21)
- Given `/journeys/new` at stage `preview`, then an admin and an editor whose preview flag is true can open `/v2/journeys/new` and see its Preview badge in the sidebar and the page header, and an editor whose flag is false gets the not-found page and sees no entry for it. (SHL-FR-22)
- Given an editor without preview access on a page, when an admin sets her preview flag to true, then her next request to a route at `preview` opens it, without a new sign-in or a restart. (SHL-FR-22)
- Given the segments area at `preview`, then an editor without preview access sees `/v2/segments` with no **New segment**, Edit, or Delete, and an editor whose preview flag is true sees them with a Preview badge. (SHL-FR-22)
- Given a deployed release, when the shell of `/v2/journeys` is requested 100 times, then the 95th percentile reaches the browser within 1 second. (SHL-NFR-01)
- Given every v2 page used with the keyboard alone, then every control is reachable and shows a focus ring, and an automated contrast check passes in the light theme. (SHL-NFR-02, SHL-NFR-03)
- Given windows of 1280, 900, and 700 px, then the sidebar is open, collapsed, and a sheet, in that order. (SHL-NFR-04)
- Given a studio deploy during a run of requests to `/campaign` before cutover and to `/v2/journeys`, then no request fails. (SHL-NFR-05)

## Open questions

The time zone rules are the lead's default, marked in [Time ranges](#time-ranges). The design leaves three details open, and this contract states a default for each until the lead confirms it:

- **What a viewer without preview access gets on a route at `preview`.** The default is the not-found page, as for a route that does not exist. The alternative is a forbidden state that says the page is in preview.
- **Controls that an area adds to a `shipped` route.** The design stages areas, not controls. The default is that such a control follows its area's stage, as SHL-FR-22 says. The alternative is to ship the controls of a shipped route to everyone at once.
- **Preview and actions.** The default is that an action checks the session and the role its feature contract names, not the preview flag, because the classic studio offers the same writes to every staff user until cutover. The alternative is that every action behind a preview area also checks the preview flag.

## Later phases

These are not requirements yet. Each gets its own contract change when its phase starts.

- Studio v2 phase 3: A/B splits and control groups, frequency caps and quiet hours under Settings, preview and test send, and one-off campaigns. The Campaigns entry arrives then.
- Data import: the [data import](data-import.md) contract gives the reserved routes their pages and moves them out of `reserved`.

## Related

- [0034. Build studio v2 side by side under `/v2`](../architecture/decisions/0034-build-studio-v2-side-by-side-under-v2.md)
- [0037. One studio: retire the classic studio](../architecture/decisions/0037-one-studio-retire-the-classic-studio.md)
- [0045. Adopt the Salarose design system, and approve a visual draft before UI code](../architecture/decisions/0045-adopt-the-salarose-design-system-and-approve-a-visual-draft-before-ui-code.md)
- [0036. Store journey drafts on the server, outside CDC](../architecture/decisions/0036-store-journey-drafts-on-the-server-outside-cdc.md)
- [Admin authentication](admin-authentication.md)
- [Home overview](home-overview.md)
- [Customer lookup](customer-lookup.md)
- [Data health](data-health.md)
- [Event catalog](event-catalog.md)
- [Journey builder](journey-builder.md)
- [Campaign management](campaign-management.md)
- [Segments](segments.md)
- [Platform console](platform-console.md)
- [Data import](data-import.md)
- [DESIGN.md app patterns](../../../DESIGN.md#app-patterns)
- [Known issues](../known-issues/features/studio-shell.md)
