---
title: Staff sign in through OpenID Connect
id: "0007"
status: accepted
date: 2026-10-14
tags: [studio, security, authentication]
supersedes: []
superseded_by: ["0024"]
---

# 0007. Staff sign in through OpenID Connect

> Superseded in part by [decision 0024](0024-create-staff-at-first-sign-in-with-the-providers-role.md): sign-in no longer admits only emails already in `system_users`. It creates the staff user at the first sign-in, matched by the provider account, with the role from the provider's role claim, and the provider decides who gets in. OIDC with PKCE, the app's own signed session cookie, and the check in every handler still hold.

## Context

`studio`, then named `campaign-admin`, had a password login. Passwords were stored in plain text in `system_users.password`. The session cookie `admin_session` held the raw user id, so anyone who knew an id could forge a session. The old `middleware.ts` let every `/api/*` request through without a check.

## Decision

Staff sign in through one OpenID Connect provider, with the authorization code flow, PKCE, `state`, and `nonce`. Only an email already in `system_users` gets in. The app issues its own signed session cookie and checks it on every page, route, and server action. There is no password login, no self sign-up, and no automatic account creation.

The flow uses `openid-client` 6 and the cookies use `jose` 6. Both are small, framework-independent, and from the same maintainer, and `openid-client` 6 already depends on `jose`.

Commit `f0b23afc` made the change.

## Why

- An external provider removes stored passwords from the app.
- A signed cookie with an audience and an expiry cannot be forged from a user id.
- An allow list of emails keeps the provider's other users out.
- Checking the session in every handler, and not only in the proxy, keeps a server action safe when a matcher change drops it from the proxy. The Next.js documentation warns about that case.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Fix the password login | Keeps password storage, reset, and rotation in the app. |
| Auth.js | The app needs one generic provider, its own `system_users` check, and its own cookie format. Auth.js would replace all three with its own conventions and adapters. |
| Automatic account creation from the provider | Anyone at the provider would get in. |

## Consequences

- Users are matched by email, not by the provider's subject id. Whoever controls a matching email at the provider gets the account.
- Sign-out ends the app session only. The provider session stays open.
- Existing databases keep the old `password` column, with its plain-text values, until someone drops it.

## Related

- [Admin authentication](../../features/admin-authentication.md)
