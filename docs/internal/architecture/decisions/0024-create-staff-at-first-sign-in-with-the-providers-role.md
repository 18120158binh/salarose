---
title: Create staff at their first sign-in, with the role the provider gives
id: "0024"
status: proposed
date: 2026-10-20
tags: [studio, security, authentication]
supersedes: ["0007", "0010", "0016", "0018", "0019", "0023"]
superseded_by: []
---

# 0024. Create staff at their first sign-in, with the role the provider gives

This record supersedes [decision 0007](0007-staff-sign-in-through-oidc.md) in part: only an email already in `system_users` got in, and there was no automatic account creation. It supersedes [0010](0010-link-staff-to-provider-accounts-and-end-sessions-server-side.md), [0018](0018-offer-several-providers-and-name-the-claim-that-proves-an-email.md), and [0019](0019-keep-schema-sql-the-only-ddl-source.md) in part, and [0016](0016-link-only-a-verified-email-and-let-admins-reset-links.md) and [0023](0023-let-admins-link-a-user-to-a-provider-account.md) in full.

## Context

Until this record, an admin added each staff user to `system_users` by email and chose the role in `/admin`. The first sign-in found the row by email and linked it to the ID token's `iss` and `sub` ([decision 0010](0010-link-staff-to-provider-accounts-and-end-sessions-server-side.md)). Trusting the email at that first link needed a verified email claim, an opt-out, an admin link reset, an admin email change ([decision 0016](0016-link-only-a-verified-email-and-let-admins-reset-links.md)), a configurable verified email claim and a refusal of emails two rows share ([decision 0018](0018-offer-several-providers-and-name-the-claim-that-proves-an-email.md)), and an admin link by subject ([decision 0023](0023-let-admins-link-a-user-to-a-provider-account.md)). Each one patched the same root: the email decided which row a stranger's first sign-in got (AUTH-KI-12). `studio` also carried start-up steps and runbooks for databases from before the OIDC sign-in ([decision 0019](0019-keep-schema-sql-the-only-ddl-source.md), AUTH-KI-04).

The owner decided these rules on 2026-10-20:

1. A staff user is created at their first sign-in (just-in-time provisioning). Admins no longer add users by hand. The owner decided this on 2026-10-20.
2. The role, admin or editor, comes from a roles or groups claim in the provider's ID token, mapped to Studio roles by configuration, and is read again at every sign-in. The owner decided this on 2026-10-20.
3. A token that gives no role Studio recognizes is refused with `not_authorized`. The provider's app assignment decides who gets in. The owner decided this on 2026-10-20.
4. Authentication and authorization are delegated to the identity provider. Studio keeps no user administration. The owner decided this on 2026-10-20.
5. The system has never run, so there is no legacy data to support: no old databases, users, or deployments. The owner decided this on 2026-10-20.

The record status stays proposed until the owner accepts the record as a whole. Everything below that is not one of these rules was chosen during the fix. It is pending owner review, except where a rule says the owner decided it.

## Decision

- **Match only by provider account.** Sign-in finds the row by the ID token's `iss` and `sub`, and never by email. No row for that account and a mapped role: sign-in creates the row. A row with that account: sign-in writes the role and the email from the token. One `INSERT ... ON CONFLICT (oidc_issuer, oidc_subject) DO UPDATE` does both, so a retried or concurrent first sign-in converges on one row.
- **A row holds only what campaigns and sessions need.** `id` owns campaigns. `oidc_issuer` and `oidc_subject`, both required, name the account. `role` is read by every session check. `session_epoch` ends sessions at sign-out. `email` goes into the session and is not unique. Nothing else is stored.
- **Role mapping per provider.** `OIDC_ROLE_CLAIM` names one top-level claim, and `OIDC_ROLE_MAP` is a JSON object from claim values to `admin` or `editor`. Both are required, per provider as `OIDC_<ID>_ROLE_CLAIM` and `OIDC_<ID>_ROLE_MAP` with `OIDC_PROVIDERS`. The claim may be one string or a list of strings. When several values map, the highest role wins: `admin`, then `editor`. An invalid or missing setting fails the configuration, so every sign-in reports `server_error` and the log names the variable.
- **`viewer` cannot be mapped.** Studio has no read-only role, and the contracts define only `admin` and `editor`. A map that names `viewer` fails the configuration, so viewers are refused. The owner decided this on 2026-10-20.
- **The refusal comes before any write.** A token without a mapped role, or without an email, changes nothing in `system_users`.
- **Access is revoked at the provider.** The user's next sign-in is refused, and the row keeps its last role. An open session keeps working with that role until it expires, after 12 hours by default and 7 days at most. Studio does not ask the provider between sign-ins.
- **No user administration in Studio.** The Users tab, with its list, delete, and sign out everywhere, is gone, and so are the server actions behind it. `/admin` opens the event catalog.
- **No legacy data paths.** `infra/db/schema.sql` is the only schema. `studio` runs no start-up DDL for older staff tables: no `admin_users` rename, no added columns, no `password` handling, no index changes. The upgrade notes and runbooks for older staff tables are gone.
- **Removed with the email link.** `email_unverified`, `email_ambiguous`, `account_mismatch`, `OIDC_REQUIRE_EMAIL_VERIFIED`, and `OIDC_VERIFIED_EMAIL_CLAIM`. A verified email no longer matters, because the email decides nothing.
- **Kept.** OIDC with PKCE and the app's own signed session cookie from decision 0007. The session epoch and the provider sign-out from decision 0010. Several providers and the stored ID token for `id_token_hint` from decision 0018. The table check at start-up from decision 0019.

## Why

- OpenID Connect Core 1.0, section 5.7, says only `iss` and `sub` identify the user, and the email is not a stable identifier. Matching on the pair removes the email takeover at its root instead of guarding it. <https://openid.net/specs/openid-connect-core-1_0.html#ClaimStability>
- Grafana maps a claim to its roles with `role_attribute_path`, and `role_attribute_strict` refuses a sign-in that maps to no role. Argo CD maps the `groups` claim to roles through RBAC policy. Both create the user at the first sign-in and leave assignment to the provider. <https://grafana.com/docs/grafana/latest/setup-grafana/configure-security/configure-authentication/generic-oauth/#configure-role-mapping> <https://argo-cd.readthedocs.io/en/stable/operator-manual/rbac/>
- A JSON object, instead of a list of `value=role` pairs, holds any claim value, including the commas and equals signs of an LDAP group's distinguished name. A JMESPath expression, as in Grafana, would reach nested claims such as Keycloak's `realm_access.roles`, but adds a parser for a case a provider-side claim mapper already covers.
- Requiring the settings, instead of defaulting them, makes a missing mapping visible in the log at the first sign-in. A default would refuse every user with `not_authorized` and no hint.
- The highest role wins because the provider can assign a person to several groups, and taking the lowest would demote an admin who is also in the editors group.
- Writing the role at sign-in is enough for the running sessions: every session check reads the role from `system_users` (AUTH-FR-08), so a promotion or a demotion takes effect on the next request after the next sign-in.
- With the provider deciding who gets in and with which role, a Studio-side list, delete, or forced sign-out would be a second place to manage access. Revoking at the provider and letting the session expire keeps one place.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Keep the admin's list, and only take the role from the token | The owner dropped the manual list. It also keeps the email link and its takeover risk. |
| Default `OIDC_ROLE_CLAIM` to `roles` or `groups` | Providers differ. A silent default refuses everyone with no hint. |
| Ask the provider for the role on each request, or refresh it with the refresh token | Needs a token store and a provider call on every check. The session lifetime already bounds a stale role. |
| Keep a read-only Users tab with sign out everywhere and delete | The owner delegated user administration to the provider. |
| Keep the unique email index | One person could not use two providers. |
| Map `viewer` to a read-only Studio | Studio has no read-only role. The owner chose to keep `viewer` refused on 2026-10-20. |

## Consequences

- Before the first sign-in, each provider needs a role claim in its ID token, `OIDC_ROLE_CLAIM` and `OIDC_ROLE_MAP` set, and at least one person given the admin value.
- A provider that sends no roles or groups claim in the ID token cannot be used. Google sends none, so a Google deployment needs a provider in front that can, such as Keycloak.
- Microsoft Entra drops the `groups` claim for a user in more than 200 groups and sends an overage marker instead, so that user is refused. App roles in the `roles` claim avoid it.
- One person who signs in at two providers gets two rows, each with its own role and campaigns. Changing a provider's issuer gives each person a new row, and the old row keeps its campaigns.
- To shorten how long a revoked person's open session lasts, lower `SESSION_MAX_AGE_SECONDS`.
- The admin role still gates the event catalog in `/admin` and the admin overrides on campaigns: pause, resume, and delete of any campaign, and the campaigns with no owner.
- No audit log records role changes. The provider's own log does.

## Related

- [Admin authentication](../../features/admin-authentication.md)
- [Configuration](../../operations/configuration.md#studio)
- [0007. Staff sign in through OpenID Connect](0007-staff-sign-in-through-oidc.md)
- [0010. Link staff to provider accounts and end sessions server-side](0010-link-staff-to-provider-accounts-and-end-sessions-server-side.md)
- [0016. Link only a verified email, and let admins reset links](0016-link-only-a-verified-email-and-let-admins-reset-links.md)
- [0018. Offer several providers, and name the claim that proves an email](0018-offer-several-providers-and-name-the-claim-that-proves-an-email.md)
- [0019. Keep `schema.sql` the only DDL source](0019-keep-schema-sql-the-only-ddl-source.md)
- [0023. Let admins link a user to a provider account](0023-let-admins-link-a-user-to-a-provider-account.md)
