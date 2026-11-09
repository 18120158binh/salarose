---
title: Let admins link a user to a provider account
id: "0023"
status: superseded
date: 2026-10-20
tags: [studio, security, authentication]
supersedes: []
superseded_by: ["0024"]
---

# 0023. Let admins link a user to a provider account

> Superseded by [decision 0024](0024-create-staff-at-first-sign-in-with-the-providers-role.md): sign-in creates each row from its provider account, so no row waits for an admin's link.

## Context

[Decision 0010](0010-link-staff-to-provider-accounts-and-end-sessions-server-side.md) links each staff user to their provider account, the ID token's `iss` and `sub`, at the first sign-in, which finds the row by email. [Decision 0016](0016-link-only-a-verified-email-and-let-admins-reset-links.md) makes that first link require a verified email, with an opt-out for a provider that sends no claim that proves the email. With the opt-out, the email alone decides the first link: whoever sets a staff user's email at the provider before that user's first sign-in gets the row and its role. The admin authentication known issues track it as AUTH-KI-12.

Both earlier records rejected "admins enter each user's `sub` before the first sign-in", because admins rarely know a user's `sub`. That objection holds for a rule that makes it mandatory. It does not rule out an option for the deployments that need it.

The owner did not choose the rules below. Each one was chosen during the fix of AUTH-KI-12, from common practice. Each one is pending owner review.

## Decision

- An admin can link another staff user to a provider account from the Users tab of `/admin`. The admin picks one of the configured providers and enters the person's subject there, the `sub` claim.
- The app stores the issuer that the provider's discovery document names, because that is the `iss` its ID tokens carry, and the subject trimmed. A subject must be 1 to 255 ASCII characters.
- The write is one `UPDATE` keyed by the user id. It sets `oidc_issuer` and `oidc_subject`, raises `session_epoch`, and deletes the user's stored ID token, as the link reset does. Linking the account the row already has changes nothing. An account already linked to another row is refused through the unique index on the pair.
- Sign-in does not change. A linked row signs in only with its account, and a sign-in that finds the row by email with another account fails with `account_mismatch`. That holds for a row an admin linked, so a linked row is safe from the email takeover under the opt-out.
- A row nobody linked keeps today's behavior. With the opt-out, its first sign-in still trusts the email.
- The Users tab shows whether each row is linked, so an admin can see which rows the opt-out still exposes.

## Why

- Admin consoles that broker external sign-in link an account the same way: the admin names the provider and the user's id there. Keycloak's admin REST API has `POST /admin/realms/{realm}/users/{user-id}/federated-identity/{provider}`, whose body holds `identityProvider`, `userId`, and `userName`, and its admin console shows these as the user's identity provider links. <https://www.keycloak.org/docs-api/latest/rest-api/index.html>
- OpenID Connect Core 1.0 says only `iss` and `sub` identify the user, and `sub` is a case-sensitive string of at most 255 ASCII characters. <https://openid.net/specs/openid-connect-core-1_0.html#IDToken>
- A provider id from the configuration, instead of a typed issuer URL, removes a class of typos. The discovered issuer, instead of the configured URL, matches the token's `iss` exactly, even when the two differ by a trailing slash.
- No sign-in change means no new path to get wrong. The link check that stops a second account already exists.
- Raising the epoch on a changed link ends the sessions of an account that was wrongly linked before. The same reason applies to the reset.
- Keeping the opt-out's behavior for unlinked rows follows the stop rule: no contract says those rows must be refused.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Require a link for every row when the opt-out is on | Changes the opt-out's behavior, which no contract asks for. Left as an open question for the owner. |
| A provider directory lookup by email | Each provider has its own directory API and credentials. The OIDC flow has no standard one. |
| Type the issuer URL | Easy to mistype, and the configured URL may differ from the token's `iss`. |
| Store the provider id instead of the issuer | Sign-in matches on `iss` and `sub`. Two columns for one account would drift. |
| An invitation link the user opens once | Needs mail delivery and a token store. Larger than the risk. |

## Consequences

- An admin needs the person's `sub`. Some providers show it, such as the user ID on Keycloak's user page. Microsoft Entra's `sub` differs for each application, so its portal does not show it. Not checked against live providers.
- A linked row keeps its account until an admin resets it. A person whose provider account is recreated needs a reset or a new link.
- The admin action calls the provider's discovery endpoint, once per process. When the provider cannot be reached, the link fails with a message and nothing is written.
- No audit log records who linked an account, as for the reset and the email change. The server log has the failures only.

## Related

- [Admin authentication](../../features/admin-authentication.md)
- [Admin authentication known issues](../../known-issues/features/admin-authentication.md)
- [0010. Link staff to provider accounts and end sessions server-side](0010-link-staff-to-provider-accounts-and-end-sessions-server-side.md)
- [0016. Link only a verified email, and let admins reset links](0016-link-only-a-verified-email-and-let-admins-reset-links.md)
