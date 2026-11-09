---
title: Build studio v2 side by side under /v2 in the same app
id: "0034"
status: accepted
date: 2026-11-07
tags: [studio, studio-v2, ui, rollout]
supersedes: []
superseded_by: ["0037", "0045"]
---

# 0034. Build studio v2 side by side under `/v2` in the same app

> Superseded in part by [decision 0037](0037-one-studio-retire-the-classic-studio.md): v2 now writes through each feature's own actions, and the cutover section is replaced by 0037's staged migration, redirect map, one-week soak, and removal of the `/v2` prefix. One app, shared sign-in, and the rolling restart stay.
>
> Superseded in part by [decision 0045](0045-adopt-the-salarose-design-system-and-approve-a-visual-draft-before-ui-code.md): the studio is light theme only for now and no longer writes the shared `theme` cookie.

## Context

Studio is a journey builder, a campaign list, a segments page, two admin pages, and a platform page. A marketer cannot see how journeys did, look up a customer, or check whether data arrives. The marketer pages and the admin pages have separate headers, and the UI departs from DESIGN.md in many places: hardcoded colors, emoji icons, browser alerts, and engineering copy. The owner asked for a more beautiful studio that covers a marketer's daily jobs, and set one hard rule: the current studio must not change behavior or go down while the new one is built.

The redesign spans several phases. Phases 0 and 1, the shell and the pages that need no new pipeline data, must be live on the AWS Free Plan cluster before the account closes on 2026-11-14. Phases 2 to 4 follow in the repo.

## Decision

Studio v2 is a second route tree, `/v2/...`, in the same Next.js app as the classic studio. It shares the app's sign-in, session, server code, database client, and Kafka client. The owner decided this on 2026-11-07.

- v2 adds pages. It does not edit a classic page, except where a fix is needed by both, and such a change goes in its own pull request that says so.
- Shared UI components are only added to. A component that needs a different look in v2 gets a new variant, so that no classic page changes.
- The classic studio stays the default after sign-in. Its two headers link to `/v2`, and v2 links back to the matching classic page.
- In phases 0 and 1, v2 reads and does not write. Every change still goes through a classic page.
- Deploys keep studio's rolling restart.

### Cutover

Cutover is the last phase. It happens when every classic page has a v2 page that does the same job, and when no classic page is linked from v2 for an action. Then `/` and the sign-in landing go to `/v2`, and the **Try the new studio** link goes away. A later pull request deletes the classic pages once the logs show nobody opens them for two weeks, which is the lead's default. Contracts then drop the classic routes.

## Why

Most of what v2 needs already exists in the app. Sign-in through OIDC, the session cookie with its epoch, the role checks, and the database access sit in studio's server code. A page under `/v2` gets all of it by being in the same app, and a request from v2 is checked by the same code as a request from a classic page.

The owner's hard rule is easiest to keep when v2 cannot write. A read-only v2 cannot corrupt a journey, a segment, or the catalog. A classic acceptance test that still passes shows that the classic pages did not change. The design's rule that shared components are only added to keeps the classic look fixed while v2's look changes.

One app also means one deploy. The 2026-11-07 deploy of studio already ran with a rolling restart and no downtime, so v2 ships the same way, and a rollback rolls back both.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| A separate Next.js app for v2 | It would duplicate sign-in, the session, the role checks, and data access, and need its own ingress, OIDC client, deploy, and secrets. On a cluster that closes in a week, that is days of work that delivers no screen. Two copies of the session rules can also drift, which is a security risk. |
| Rewrite the classic pages in place | Every change risks the classic studio, which the owner forbade. A half-finished page would ship to every user. |
| A feature flag per page, in the same routes | Each page would carry two versions behind a flag, so every classic route changes and every test runs twice. Rollout per user needs a flag store the platform does not have. |
| A subdomain such as `v2.studio` served by the same app | It needs a second hostname, a certificate, and a second OIDC redirect, for no gain over a path. |

## Consequences

- Every v2 contract states its route under `/v2` and its role, and the [studio shell](../../features/studio-shell.md) holds the route table.
- The classic and v2 pages share the `theme` cookie, the session, and the sign-out.
- Studio's own API under `/v1` is the data ingestion API. A future version of that API must not use `/v2` paths in studio, because `/v2` belongs to the UI. It would go under another prefix, such as `/api/ingest/v2`.
- Studio reads the dead-letter topic for the [data health](../../features/data-health.md#who-may-see-dropped-data) page. Where the broker enforces authorization, that read uses an identity limited to the topic. The AWS Free Plan cluster's broker has no authentication or authorization, so decision 0017's access rule is not enforced at the topic there.
- From phase 2, v2 writes, and the v2 builder must save the classic builder's saved format through the same validation, so both builders write the same rows. That code moves into shared modules before the v2 builder is built.
- Until cutover, two UIs exist. A fix that both need is made once, in shared code, and named in its pull request.

## Related

- [Studio shell](../../features/studio-shell.md)
- [Admin authentication](../../features/admin-authentication.md)
- [0035. Compute journey analytics from the transitions on read](0035-compute-journey-analytics-from-transitions-on-read.md)
