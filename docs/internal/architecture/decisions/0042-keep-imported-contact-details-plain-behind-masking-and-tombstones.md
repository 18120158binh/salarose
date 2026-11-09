---
title: Keep imported contact details in plain form behind masking and tombstones
id: "0042"
status: accepted
date: 2026-11-08
tags: [data-import, privacy, pii]
supersedes: []
superseded_by: []
---

# 0042. Keep imported contact details in plain form behind masking and tombstones

## Context

A shop's customer records carry email addresses and phone numbers. The platform has held neither until now: [customer lookup](../../features/customer-lookup.md) shows no contact details, and the [identifiers contract](../components/identity/identifiers.md#open-questions) lists them as having no source. The owner settled on 2026-11-08 that the import stores them in plain form, so a sender can use them later. The lead set the protections around them the same day.

## Decision

Imported emails, phones, and any column an admin flags as PII are stored in plain form, protected by five rules:

1. **Encryption at rest is the disk's job.** The disk under each Postgres cluster that holds imported data is encrypted, and the drop zone's bucket encrypts every object on the server and keeps no older object version. No column is encrypted by the application. The import accepts no production delivery until this holds (DIM-NFR-08).
2. **Studio masks on the server, for everyone.** Every response masks every PII value, admins included, such as `n***@gmail.com` or `+84 *** *** 678`.
3. **A clear value takes its own logged call.** An admin's reveal is a server call for one field of one customer, which writes a `pii_access_log` row before it returns the value. A rejects download writes a row too, and so does a deletion request. Rows are deleted after 365 days.
4. **Deletion leaves a keyed tombstone.** Deleting a person by customer key stores the key's HMAC-SHA-256 under a deployment secret, the tombstone key, in `person_tombstones` and in the drop zone. The applier deletes the person's stored rows, rewrites the drop-zone and reject files that hold them, replaces the key with the tombstone in earlier access-log rows, and rejects the key in every later run, replay, and re-derive. The metric pass publishes nothing for the key.
5. **Backups expire.** No backup runs for either cluster today. One added later keeps at most 30 days, and a restore re-applies every tombstone first.

Several rules this decision relies on are the lead's defaults of 2026-11-08, not the owner's decisions, and the owner may reverse them. [Data import](../../features/data-import.md#the-leads-defaults) lists each one with its requirement ids.

## Why

**Column encryption adds a key to every reader and little protection.** The outbox and a future sender would each hold the key. On a single-tenant cluster, the threats that volume encryption leaves open, such as a stolen database credential, also expose the key that column encryption needs.

**Masking in the browser ships the clear value.** Anything the server sends, a user can read in the network panel. The server masks before it renders.

**A delete without a tombstone does not last.** A shop's nightly snapshot still holds the person, so the next run brings their rows back. A replay of an old run, or a re-derive after a role mapping change, would too. The tombstone stops all three.

**A plain hash would not hide the key.** Customer keys are often phone numbers, such as `0912345678`. Vietnam's mobile numbers fit in about a billion values, so anyone holding an unsalted SHA-256 recovers the number by trying them all in minutes. An HMAC under a secret the database does not hold makes that search impossible without the secret. The secret cannot rotate, because the platform no longer has the keys to hash again.

**The clear key must leave every table, not only the record tables.** A reveal logs the customer key. If those rows kept it for a year, deleting the person would still leave their key in the platform. The applier replaces it with the tombstone when the deletion runs, so the audit trail keeps which person was revealed, under the same hash, and no clear key.

**Admins get masks too.** A page that ships clear values to admins leaks them through browser caches, screenshots, and support tools, and logs nothing. One value per logged call keeps every clear read on the record.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Column-level encryption | Every reader needs the key, and it adds nothing against the threats volume encryption leaves open on a single-tenant cluster. |
| Store only hashes of emails and phones | The owner wants the values usable by a sender. |
| Mask in the browser | The clear value still reaches the browser. |
| Delete without a tombstone | The next snapshot, replay, or re-derive restores the person. |
| Keep the deleted customer key in clear for audit | Keeps the personal data the deletion was meant to remove. |
| An unsalted SHA-256 tombstone | Phone-number keys are recovered by trying every number. |
| Clear values in admins' pages | Every admin page view would be an unlogged clear read. |

## Consequences

- Today's node disks are not encrypted. The infrastructure code sets no encryption on the root volumes and no default encryption for the account (checked). The Postgres claims live on those root disks. Turning on encryption for an existing root volume replaces the instance (inferred from the AWS provider's behavior), so the change to the data node is gated on the owner. The bucket sets no server-side encryption either.
- Losing the tombstone key makes every tombstone miss. It lives in the deployment's secrets and their backup.
- Every studio read of a PII value goes through one server-side masking step, and a test can assert that no clear value reaches any role's response except a reveal or a rejects download.
- Deletion covers imported data only. Deleting a person's tracked behavior, metrics, journeys, and identity rows belongs to the unwritten consent and deletion contract ([identity overview](../components/identity/README.md#what-is-not-specified-yet)).
- Logs of the applier, the metric pass, and the import API carry run ids, counts, and reasons, never row values.

## Related

- [Data import](../../features/data-import.md#privacy)
- [Import applier](../components/import-applier.md)
- [Customer lookup](../../features/customer-lookup.md)
- [0040. Import through a batch path and a separate store](0040-import-through-a-batch-path-and-a-separate-store.md)
