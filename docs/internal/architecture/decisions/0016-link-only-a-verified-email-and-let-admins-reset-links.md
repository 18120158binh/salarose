---
title: Link only a verified email, and let admins reset links
id: "0016"
status: superseded
date: 2026-10-18
tags: [studio, security, authentication]
supersedes: []
superseded_by: ["0024"]
---

# 0016. Link only a verified email, and let admins reset links

> Superseded by [decision 0024](0024-create-staff-at-first-sign-in-with-the-providers-role.md): sign-in no longer finds a row by email, so the verified email check, the link reset, and the email change are gone.

## Context

[Decision 0010](0010-link-staff-to-provider-accounts-and-end-sessions-server-side.md) links each staff user to their provider account, the ID token's `iss` and `sub`, at the first sign-in. That first sign-in finds the row by email. Two gaps followed:

- The email check passed when the token had no `email_verified` claim. Microsoft Entra sends none. On Entra, whoever held a staff user's email at the provider before that user's first sign-in got the row and its role. Every existing row started unlinked at the deploy.
- Only SQL could clear a link. After a provider switch, a change of `OIDC_ISSUER`, or a wrong link, the user got `account_mismatch`, and `/admin` offered no fix.

The owner asked for every known issue to be fixed. The owner did not choose the rules below. Each one was chosen during the fix, from common practice, under that instruction. Each one is pending owner review: the verified email by default, the opt-out, the admin link reset, and the admin email change.

## Decision

- **Verified email for the first link.** When no row is linked to the token's provider account, the app links a row by email only if the token has `email_verified: true`. Otherwise sign-in fails with `email_unverified`, before the email lookup. A row already linked signs in without the claim. `OIDC_REQUIRE_EMAIL_VERIFIED=false` turns the rule off for a deployment whose provider never sends the claim. It defaults to `true`. A token with `email_verified: false` fails in either case.
- **Admin link reset.** An admin can reset another staff user's link from the Users tab of `/admin`. One `UPDATE` clears `oidc_issuer` and `oidc_subject` and raises `session_epoch`. The user's sessions end, and their next sign-in links again under the rule above. An admin cannot reset their own link.
- **Admin email change.** An admin can change another staff user's stored email from the same tab. The new email is trimmed and lowercased, and the same `UPDATE` resets the link as above. A duplicate email fails with a message, through the unique `lower(email)` index. An admin cannot change their own email. Saving the email the user already has changes nothing.
- **Link only the row the sign-in read.** The link `UPDATE` also requires the email the sign-in matched the row by. A sign-in that read the row before an admin changed its email cannot link it afterwards.

## Why

- OpenID Connect Core 1.0, section 5.7, says the `email` claim is not guaranteed unique and must not be used as the user's identifier. Only `iss` and `sub` are stable. A first link by email is safe only if the provider vouches for the address. <https://openid.net/specs/openid-connect-core-1_0.html#ClaimStability>
- Auth.js links a provider account to an existing user by email only when `allowDangerousEmailAccountLinking` is set. The flag is off by default, and its name states the risk. <https://authjs.dev/reference/core/providers#allowdangerousemailaccountlinking>
- Microsoft tells apps never to use the `email` claim to decide access, because it is not unique and tenant admins, or sometimes users, can change it. <https://learn.microsoft.com/en-us/entra/identity-platform/claims-validation#validate-the-subject>
- A deployment-wide flag is enough, because a deployment has one provider. In a single-tenant Entra issuer, the tenant controls who can sign in and, mostly, their emails. Trusting the email there is a risk the operator takes on purpose, and the link reset undoes a wrong link.
- The check runs before the email lookup, so a stranger cannot learn from `email_unverified` versus `not_authorized` whether an email belongs to staff.
- The reset raises the epoch because a wrong link may belong to someone else, who may hold a live session. Raising the epoch ends it. The reset is one `UPDATE` keyed by the user id, so a repeated click converges on an unlinked row.
- An email change resets the link because the account linked under the old email may belong to someone else under the new one.
- Without the email in the link `UPDATE`, a sign-in that read the row by its old email could link the old provider account after an admin's email change, and undo the reset.
- An admin who reset their own link, or changed their own email, would sign themselves out, and with an unverified email could not sign in again. Blocking it protects the last admin.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Keep passing an absent `email_verified` | Leaves the Entra takeover open by default. |
| Require `email_verified` with no opt-out | Entra could not be used at all. |
| A configurable claim name, such as Entra's `xms_edov` | More setup and a claim whose format was not checked against a live tenant. The flag can grow into this later. |
| Admins enter each user's `sub` before the first sign-in | Decision 0010 rejected it. Admins rarely know a user's `sub`. |
| Delete and add the user again to clear a link | Moves the user's campaigns to the admin and gives the row a new id. |

## Consequences

- An Entra deployment must set `OIDC_REQUIRE_EMAIL_VERIFIED=false` before the deploy, or no unlinked user can sign in. With it set, the first sign-in on Entra trusts the email, as before.
- A provider switch or issuer change no longer needs SQL for one user. Resetting every user at once still does.
- A link reset raises the session epoch, so sign-out is no longer the only thing that does.
- With `OIDC_REQUIRE_EMAIL_VERIFIED=false`, the first link still trusts the email alone. The admin authentication known issues track that case.
- No audit log records who reset a link or changed an email. The server log has the failures only. An audit trail is left for later.
- A user whose stored email differs from their email at the provider no longer needs to be deleted and added again. An admin changes the email.

## Related

- [Admin authentication](../../features/admin-authentication.md)
- [0010. Link staff to provider accounts and end sessions server-side](0010-link-staff-to-provider-accounts-and-end-sessions-server-side.md)
