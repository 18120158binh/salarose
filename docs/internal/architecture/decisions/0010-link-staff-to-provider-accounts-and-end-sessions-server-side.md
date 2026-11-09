---
title: Link staff to provider accounts and end sessions server-side
id: "0010"
status: proposed
date: 2026-10-17
tags: [studio, security, authentication]
supersedes: []
superseded_by: ["0024"]
---

# 0010. Link staff to provider accounts and end sessions server-side

> Superseded in part by [decision 0024](0024-create-staff-at-first-sign-in-with-the-providers-role.md): sign-in no longer matches a row by email or links it. It matches only the provider account, and creates the row at the first sign-in. The session epoch and the provider sign-out stay.

## Context

[Decision 0007](0007-staff-sign-in-through-oidc.md) left three gaps, listed in its consequences and in the admin authentication known issues:

- Users were matched by email. Whoever controlled a matching email at the provider got the account, and a user whose email changed at the provider was locked out.
- A session cookie was valid until it expired. Signing out deleted it in one browser, and a copy kept working.
- Sign-out ended only the app session. The next **Sign in with SSO** could pass the provider without a prompt.

The owner decided all three on 2026-10-17.

## Decision

- **Provider account link.** The first sign-in matches the user by email and stores the ID token's `iss` and `sub` in `system_users.oidc_issuer` and `system_users.oidc_subject`, unique as a pair. Later sign-ins match on the pair. A sign-in with the email of a user linked to another pair fails with `account_mismatch`.
- **Session epoch.** `system_users.session_epoch` is an integer. The session cookie carries its value at sign-in. Every session check that loads the user rejects a cookie below the current value. Sign-out raises it. The proxy does not query the database, so it cannot check the epoch. Pages, routes, and actions do.
- **Provider sign-out.** Logout redirects to the provider's `end_session_endpoint`, found by discovery, with `client_id` and `post_logout_redirect_uri` set to `/login` on the public origin. Without that endpoint, logout ends only the app session.

## Why

- `iss` and `sub` name one account at one provider and do not change with the email. The email still finds the row once, so admins keep adding staff by email.
- The link is a conditional update that also accepts the same pair again. A retried or concurrent first sign-in converges on one link.
- An epoch on the user row needs no session table and adds no query: `getSession` already loads the row.
- Only sign-out raises the epoch. A role change takes effect on the next request because the role is read on every check, and the user management contract says a role change must not need a new sign-in. A deleted user has no row, and a user added again gets a new id.
- The epoch rises only when the cookie's epoch is at least the current one. A repeated sign-out, or one from an already ended cookie, does not end a newer session.
- `client_id` instead of `id_token_hint`. RP-Initiated Logout 1.0 accepts either one with `post_logout_redirect_uri`. Keeping the ID token would grow the session cookie by about 1 KB, more for Entra tokens with many claims, and would put a provider-signed token with personal data in a browser cookie.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Match by `sub` only, with no email step | Admins would need each user's `sub` before the first sign-in. |
| Link the first `sub` and also update the stored email from the token | Not asked for. The stored email stays the one the admin entered. |
| A session table with one row per sign-in | Ends one session at a time, but adds a table, writes at every sign-in, and a cleanup job. |
| Raise the epoch on role change and user delete too | Breaks the user management rule that a role change needs no new sign-in, and does nothing for a deleted row. |
| Store the ID token in the session cookie for `id_token_hint` | Cookie size, and a provider token in the browser. |
| Store the ID token in the database | It is per session, and there is no session table. |

## Consequences

- Changing the provider or `OIDC_ISSUER` makes every linked user fail with `account_mismatch` until the link is cleared. [Decision 0016](0016-link-only-a-verified-email-and-let-admins-reset-links.md) adds a reset in `/admin`.
- Signing out in one browser signs the user out in every browser.
- A provider that requires `id_token_hint` refuses the logout redirect. The app session is already over by then.
- Without an `id_token_hint`, some providers ask the user to confirm the sign-out.
- The proxy still lets a cookie with an old epoch through to the page, which then treats the user as signed out.
- Cookies issued before the session epoch have no `epoch` claim and are invalid, so every user signs in once after the deploy.

## Related

- [Admin authentication](../../features/admin-authentication.md)
- [0007. Staff sign in through OpenID Connect](0007-staff-sign-in-through-oidc.md)
