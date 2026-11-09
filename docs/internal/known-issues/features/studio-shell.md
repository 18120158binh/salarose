---
title: Studio shell known issues
contract: ../../features/studio-shell.md
updated: 2026-11-08
verified_at: none, read from the code
---

# Studio shell known issues

Studio v2 phase 1 built the route table, the sidebar, the top bar, the palette, and the page states. Studio v3 adds the account and settings pages.

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| SHL-KI-01 | Minor | `/v2/account` and `/v2/settings` have no route entry, no Preview badge, and no preview check | SHL-FR-22 |
| SHL-KI-02 | Minor | The account menu cannot show the viewer's name, because no table stores it | SHL-FR-06, SHL-FR-19 |
| SHL-KI-03 | Minor | The v2 top bar still has a theme switch that writes the `theme` cookie | SHL-FR-06, SHL-FR-14, SHL-FR-19 |
| SHL-KI-04 | Minor | The sidebar does not match the v3 entry list | SHL-FR-05 |
| SHL-KI-05 | Minor | The top bar shows the workspace name with no breadcrumb | SHL-FR-06 |
| SHL-KI-06 | Minor | `/v2/data/dead-letters` is still a page, not a redirect to Monitoring | SHL-FR-21 |

## SHL-KI-01. `/v2/account` and `/v2/settings` have no route entry, no Preview badge, and no preview check

- **Symptom.** Both pages exist, but the sidebar, the palette, and the account menu do not link to them. An editor without preview access who types `/v2/account` opens it instead of getting the not-found page. Neither page header carries a Preview badge. `/v2/settings` is admin-only, and every admin is a preview viewer, so only `/v2/account` is open too widely.
- **Cause.** A feature lane adds its page with no route entry, and only the integrator edits `studio/src/widgets/v2-shell/`. The route table in `model/routes.ts` has no `preview` stage yet, and the shell's route guard does not call the preview check that V3-02 adds in `studio/src/shared/auth/preview.ts`.
- **Evidence.** Read from the code.
- **Fix direction.** Add route entries for `/v2/account` and `/v2/settings` at stage `preview`, add **Account** to the account menu in `ui/TopBar.tsx`, and wire the preview check and the Preview badge into the shell, as the tracker's checklist lists.
- **Fixed by.** The integrator's route-entry and preview-guard items in the studio v3 tracker.

## SHL-KI-02. The account menu cannot show the viewer's name, because no table stores it

- **Symptom.** The approved Shell board shows the viewer's name and role in the account menu, such as "Minh · Admin". Studio knows only the email and the role.
- **Cause.** `system_users` has `email` and `role` but no name, and sign-in reads no `name` claim from the ID token. The session cookie carries no name either.
- **Evidence.** Read from `infra/db/schema.sql` and `studio/src/widgets/v2-shell/ui/TopBar.tsx`, which takes `email` and `role` only.
- **Fix direction.** Store the token's `name` claim on `system_users` at sign-in, through a migration, and fall back to the email when the provider sends none. The admin authentication contract then names the claim.
- **Fixed by.** Not yet planned.

## SHL-KI-03. The v2 top bar still has a theme switch that writes the `theme` cookie

- **Symptom.** Every v2 page shows a "Switch to dark theme" button, and clicking it writes the `theme` cookie and turns the page dark.
- **Cause.** `ThemeSwitch` in `studio/src/widgets/v2-shell/ui/TopBar.tsx` writes `themeCookie(next)` from `studio/src/widgets/v2-shell/model/preferences.ts`, and the v2 layout reads the cookie.
- **Evidence.** Read from `TopBar.tsx` and `studio/app/v2/layout.tsx`.
- **Fix direction.** Delete `ThemeSwitch`, the `theme` prop, and the cookie read in the v2 layout. Keep the classic layout's cookie read until classic removal.
- **Fixed by.** Not yet planned.

## SHL-KI-04. The sidebar does not match the v3 entry list

- **Symptom.** The sidebar lists Dead letters under Data. It has no Monitoring or Tracking setup entry and no **Collapse sidebar** button; it collapses only through the top bar's trigger and the drag rail. Its group labels read "Data" and "Admin".
- **Cause.** The route table in `studio/src/widgets/v2-shell/model/routes.ts` predates v3: it has a `dead-letters` entry and no `monitoring` or `tracking` entry. `AppSidebar.tsx` sets `SECTION_LABELS` to "Data" and "Admin" and renders `SidebarRail` with no collapse button.
- **Evidence.** Read from `routes.ts` and `studio/src/widgets/v2-shell/ui/AppSidebar.tsx`.
- **Fix direction.** Replace the Dead letters entry with Monitoring and Tracking setup at stage `preview`, add **Collapse sidebar** at the bottom, and style the labels as `overline` (DATA, ADMIN).
- **Fixed by.** Not yet planned.

## SHL-KI-05. The top bar shows the workspace name with no breadcrumb

- **Symptom.** The top bar shows only the workspace name, such as "Mộc Lan Shop", not "Mộc Lan Shop / Home".
- **Cause.** `TopBar.tsx` renders `{workspace}` alone and receives no current page.
- **Evidence.** Read from `studio/src/widgets/v2-shell/ui/TopBar.tsx`.
- **Fix direction.** Pass the current route's label into the top bar and render the breadcrumb.
- **Fixed by.** Not yet planned.

## SHL-KI-06. `/v2/data/dead-letters` is still a page, not a redirect to Monitoring

- **Symptom.** `/v2/data/dead-letters` opens the v2 dead-letter page.
- **Cause.** Monitoring is not built, so `studio/app/v2/data/dead-letters/` still holds the page and no redirect exists.
- **Evidence.** Read from `studio/app/v2/data/`, which has no `monitoring` folder.
- **Fix direction.** When Monitoring is built, replace the page with a redirect to `/v2/data/monitoring?tab=dropped`.
- **Fixed by.** The Monitoring lane of the studio v3 tracker.
