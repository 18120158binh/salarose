---
title: Email and phone are guarded match keys, learned from imports and the API
id: "0047"
status: accepted
date: 2026-11-14
tags: [identity, identifiers, normalization]
supersedes: []
superseded_by: []
---

# 0047. Email and phone are guarded match keys, learned from imports and the API

## Context

The [identifiers contract](../components/identity/identifiers.md) typed `user_id` and `domain_userid`, and left `email` and `phone` without a source, a match-key rule, or a merge priority. It asked four questions this record answers:

1. Where does the platform learn email addresses and phone numbers?
2. Are they match keys, which link identity sets, or stored identifiers, which link nothing?
3. Which country does a phone number without a country code belong to?
4. Can a customer add their own identifier types, such as a loyalty card number?

Two things changed since the contract was written. [Decision 0040](0040-import-through-a-batch-path-and-a-separate-store.md) added a batch import whose type mapping can mark a column as email or phone. [Decision 0042](0042-keep-imported-contact-details-plain-behind-masking-and-tombstones.md) stores imported contact details in plain form. The [data import contract](../../features/data-import.md) already sets the rules an import follows when it links a person: the customer key is the authority, and a value two or more customer keys hold links nothing.

The contract's fifth question, hashing, is the owner's and stays open. So does any rewrite of existing `canon_id` values.

## Decision

1. **Sources.** The platform learns `email` and `phone` from two places: the email and phone roles of an import's type mapping, and optional `email` and `phone` fields on a person event posted to the [data ingestion API](../../features/data-ingestion-api.md). Tracker hits do not carry them. The profile data feed in `customer_profiles` is not a source.
2. **Guarded match keys.** `email` and `phone` are match keys with merge priority 1, below `domain_userid` (2) and `user_id` (3). A merge through an email or a phone must never join two sets that each hold a `user_id`. When one would, the value links nothing, and the event or row is counted as a conflict by type. The per-type limit on how many sets one value may join belongs to the [identity graph](../components/identity/identity-graph.md#open-questions).
3. **Default country.** Each deployment has one default country for phone numbers, as an ISO 3166 two-letter code. A number written without `+` or the international prefix is read as a national number of that country. With no default set, such a number does not fit its type and is dropped.
4. **No customer-defined types now.** The type list is fixed. A loyalty card number or CRM id stays an imported attribute, which conditions read through profile attributes ([decision 0041](0041-imported-data-reaches-conditions-as-profile-attributes.md)). A new type takes a new record.

## Why

**Sources.** Every product compared here learns contact details from the customer's own systems, not from a browser hit. [Segment](https://www.twilio.com/docs/segment/connections/spec/identify) reads `email` from the traits of an `identify` call, and [mParticle](https://docs.mparticle.com/guides/idsync/components) sends email and mobile number as user identities in each IDSync request. This platform already has two server-side channels: the import, which carries the shop's customer records, and the ingestion API. Adding the fields there costs no new endpoint. A tracker field would put contact details in every browser's request log, and the trackers' `uid` already identifies the person. The profile feed's table belongs to another system, and the import replaces it as the platform's own copy of customer records.

**Guarded match keys.** A stored-only email cannot join a person's anonymous web session to the account the shop knows by email, which is the main reason to collect it. [Segment Unify](https://www.twilio.com/docs/segment/unify/identity-resolution/identity-resolution-settings) and [mParticle IDSync](https://docs.mparticle.com/guides/idsync/best-match-strategy) both resolve on email. Both also guard against the shared-address case the contract raised. Segment [advises](https://www.twilio.com/docs/segment/unify/identity-resolution/identity-resolution-onboarding) a limit of one `user_id` per profile with the highest priority, and when an event would bring a second `user_id` into a profile, it demotes the email on that event instead of merging. mParticle's default strategy fixes the customer id as the identity that decides a known user, and ranks email above device ids. Forbidding any email or phone merge between two sets that each hold a `user_id` is the same guard, and it matches the import's rule that the customer key is the authority. A family sharing one address stays two people when each has an account. Priority 1 makes a contact detail the weakest root, so a merge never renames a set that holds a device or an account after an email.

**Default country.** Vietnamese shops, the first customers, write mobile numbers as `0912345678`. [Braze](https://braze.com/docs/user_guide/channels/sms_mms_and_rcs/message_setup/user_phone_numbers) asks for E.164 and reads any number without `+` as a United States number, one fixed country for bare numbers. One country per deployment matches [decision 0027](0027-multi-tenancy.md), where a deployment serves one customer. Dropping bare numbers when no country is set keeps normalization free of guessing (IDN-NFR-01).

**No customer-defined types.** [Segment Unify](https://www.twilio.com/docs/segment/unify/identity-resolution/identity-resolution-settings) and mParticle both allow custom identifiers, and both pair them with limits and priorities per type that this platform has not built. The two named cases, a card number and a CRM id, are already imported columns. If a shop's trackers send the CRM id, the import maps it as the customer key, which is a `user_id`. Adding the type system later costs less than removing one nobody uses.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Read email and phone from the profile data feed | Another system owns `customer_profiles`, and the import replaces it. |
| Carry email and phone on tracker hits | Puts contact details in every browser request, for ids the API and import already deliver. |
| Stored identifiers only | Cannot link an anonymous session to a known email, the main use of collecting it. |
| Unguarded match keys | A shared address merges two accounts into one person. |
| Detect the country per number | Bare national numbers carry no country to detect. |
| Customer-defined types now | Needs per-type limits and priorities first, and the named cases are already imported attributes. |

## Consequences

- The ingestion API's person event gains optional `email` and `phone` fields, normalized with the same rules as the import.
- Identity stitching gains the guard: an email or phone merge between two `user_id` sets is refused and counted.
- A deployment must set its default phone country before bare numbers count.
- Hashing stays open. Until the owner answers, the graph keeps email and phone in plain form, as decision 0042 does for imports.

## Related

- [Identifiers](../components/identity/identifiers.md)
- [Identity graph](../components/identity/identity-graph.md)
- [Data import](../../features/data-import.md)
- [Data ingestion API](../../features/data-ingestion-api.md)
- [0042. Keep imported contact details in plain form behind masking and tombstones](0042-keep-imported-contact-details-plain-behind-masking-and-tombstones.md)
