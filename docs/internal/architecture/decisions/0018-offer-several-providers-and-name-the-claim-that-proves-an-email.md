---
title: Offer several providers, and name the claim that proves an email
id: "0018"
status: proposed
date: 2026-10-18
tags: [studio, security, authentication]
supersedes: []
superseded_by: ["0024"]
---

# 0018. Offer several providers, and name the claim that proves an email

> Superseded in part by [decision 0024](0024-create-staff-at-first-sign-in-with-the-providers-role.md): the verified email claim, `OIDC_REQUIRE_EMAIL_VERIFIED`, the refusal of shared emails, and `account_mismatch` are gone. The password column warning is gone too, because no older database exists. Several providers and the `id_token_hint` opt-in stay.

## Context

After [decision 0016](0016-link-only-a-verified-email-and-let-admins-reset-links.md), five limits stayed in the admin authentication known issues:

- A deployment could read only one `OIDC_ISSUER`.
- Only `email_verified` could prove an email. Microsoft Entra sends no such claim, so an Entra deployment had to set `OIDC_REQUIRE_EMAIL_VERIFIED=false`, and the first sign-in then trusted the email alone.
- Logout sent `client_id` and no `id_token_hint`, because [decision 0010](0010-link-staff-to-provider-accounts-and-end-sessions-server-side.md) kept the ID token out of the session cookie. Providers such as Okta refuse that sign-out.
- Rows whose emails differed only in case stopped the unique index on `lower(email)`, and with it every database call.
- Old databases still had the plain-text `system_users.password`.

The owner asked for every known issue to be fixed. The owner did not choose the rules below, including leaving the drop of the password column as a runbook step in each environment. Each one was chosen during the fix, from common practice. Each one is pending owner review.

## Decision

- **Several providers.** `OIDC_PROVIDERS` lists provider ids. Each provider reads its own `OIDC_<ID>_*` variables: issuer, client, name, scopes, and the three settings below. Without `OIDC_PROVIDERS`, the unprefixed variables describe one provider with the id `default`, as before. Mixing the two forms fails at start-up. The login page shows one link per provider. The transaction cookie and the session cookie carry the provider's id, in the `idp` claim, so the callback and logout use the right provider.
- **One provider account per staff user.** A staff row stays linked to one `iss` and `sub`, as decision 0010 set. A sign-in at a second provider with the same email gets `account_mismatch`. An admin resets the link to move the user. There is no account linking across providers.
- **The claim that proves the email.** `OIDC_VERIFIED_EMAIL_CLAIM`, per provider, names the claim that must be the boolean `true` for a first link by email. It defaults to `email_verified`. For Entra it is `xms_edov`. `OIDC_REQUIRE_EMAIL_VERIFIED=false` stays, for a provider with no such claim.
- **`id_token_hint` by opt-in, kept server-side.** `OIDC_LOGOUT_ID_TOKEN_HINT=true`, per provider, makes the callback store the ID token in `system_user_id_tokens`, keyed by user and tagged with the session epoch. Logout deletes the row at the cookie's epoch and sends its token as `id_token_hint`. The default is off.
- **Case duplicates do not stop start-up.** If the unique index on `lower(email)` fails with a unique violation, `studio` logs the duplicate emails and runs without the index. A first sign-in by such an email fails with the new error `email_ambiguous`. Merging the rows is a runbook step.
- **The legacy password column is warned about, not dropped.** `studio` logs a warning at start-up while `system_users.password` exists. Dropping it is a runbook step in each environment.

## Why

- Prefixed variables per provider keep each secret in its own environment variable, which a Kubernetes secret maps one to one. A JSON variable would put several secrets in one value. Rejecting the unprefixed form next to `OIDC_PROVIDERS` stops a setting meant for one provider from applying to all.
- One shared redirect URL keeps the provider registration the same as before. The transaction cookie names the provider, so the code goes to the token endpoint of the provider the user chose. Each configured provider is one the operator trusts.
- Linking one account per user is the rule decision 0010 already enforces. Linking several accounts to one user needs a table of links and a rule for which provider may add a link. Neither was asked for.
- Microsoft documents `xms_edov` as the optional claim that says the tenant verified the email's domain, and recommends it to apps that must use the email claim. A claim name keeps the code free of provider-specific logic, as AUTH-FR-01 requires. <https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference>
- Only the boolean `true` counts, as for `email_verified`. A provider that sends a string does not get a weaker check by accident.
- Server-side storage keeps the ID token out of the browser, which was the reason decision 0010 sent `client_id`. A cookie would also hit the 4 KB limit with large Entra tokens. One row per user, replaced at each sign-in, needs no cleanup job. The epoch tag means logout sends only the token from the sign-in the cookie came from, or a later one at the same epoch, which belongs to the same `sub`.
- The table is written only for a provider that opts in. A deployment that does not need `id_token_hint` stores no tokens.
- Two staff rows with one email cannot be resolved safely by code. Picking one could hand a role to the wrong person. Refusing the email keeps every other user signing in while an admin merges the rows.
- The password column holds data someone may need to keep. A warning puts the decision in front of the operator without destroying it.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| One JSON variable with every provider | Puts several secrets in one value, and a typo breaks every provider at once. |
| Unprefixed settings as defaults for every provider | A setting meant for one provider, such as `OIDC_REQUIRE_EMAIL_VERIFIED=false`, would silently weaken the others. |
| Link several provider accounts to one staff user | Needs a link table and a rule for adding links. Not asked for. |
| A built-in Entra mode instead of a claim name | Provider-specific code, against AUTH-FR-01. |
| Keep the ID token in a cookie scoped to the logout route | Puts a provider-signed token with personal data in the browser, and large tokens pass the 4 KB cookie limit. |
| Keep the ID token for every provider | Stores personal data that most deployments do not need. |
| Pick the oldest row for an ambiguous email | Could give the wrong person a role. |
| Merge case duplicates, or drop the password column, at start-up | Changes data without a person's decision. |

## Consequences

- An Entra deployment that adds the `xms_edov` claim no longer needs `OIDC_REQUIRE_EMAIL_VERIFIED=false`. The opt-out stays for providers with no claim that proves the email, and the admin authentication known issues keep that case.
- Moving a user to another provider needs a link reset.
- Sessions signed in before several providers carry no `idp`. Logout sends them to the only provider, or with several providers, signs them out locally.
- With `OIDC_LOGOUT_ID_TOKEN_HINT=true`, Postgres holds each user's latest ID token. Anyone who can read the database can read it.
- While case duplicates remain, the unique index on `lower(email)` is missing, so adding a user whose email differs only in case from an existing row is not rejected.
- Each environment must still run the password and duplicate runbooks in `docs/internal/operations/deployment.md`.

## Related

- [Admin authentication](../../features/admin-authentication.md)
- [0010. Link staff to provider accounts and end sessions server-side](0010-link-staff-to-provider-accounts-and-end-sessions-server-side.md)
- [0016. Link only a verified email, and let admins reset links](0016-link-only-a-verified-email-and-let-admins-reset-links.md)
