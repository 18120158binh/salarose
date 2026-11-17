---
title: A read-only agent with no PII and a provider-agnostic tool-use model
id: "0056"
status: accepted
date: 2026-11-17
tags: [studio, llm, agent, privacy, security]
supersedes: []
superseded_by: []
---

# 0056. A read-only agent with no PII and a provider-agnostic tool-use model

> Amended on 2026-11-17 by the owner's answers to #161 to #171, which settle points this record leaves open or to the lead. The decision stands. The permission set is the four of item 5, and each of the other three requires `agent.use` (#171). The default mapping gives `editor` `agent.use` and `agent.suggest`, not nothing (#165). The four tools the contract marked open join (#170). Conversations live in Postgres, in `agent_conversations` and `agent_messages`, for 90 days, and users can delete their own (#162, #169). Event attribute values may reach the model unless the event catalog flags the attribute as PII, and a flagged value reaches it only as a keyed hash (#166). A typed name reaches the model no more than a typed email does: the agent asks for an id, an email, or a phone instead (#167). The agent key rotates only on a suspected leak, by a runbook, and each stored hash carries its key id (#168). The cost limit is questions per user per day and tool calls per question, counted in Postgres (#163). Quality is measured by a scenario suite in CI and a user rating (#164). Delivery outcomes are to come back on a Kafka topic keyed by execution id, which the sender, outside this repo, produces (#161). The [CDP agent contract](../../features/cdp-agent.md) holds the rules.

## Context

Staff who want to know why a journey reaches few people, or why one customer got no message, read journey analytics, customer lookup, and data health page by page, and trace the cause themselves. The owner traces it in a fixed order: count the people at each step, find the drop, then check the events, the entry conditions, the channel, and the profile. Nothing in studio does that tracing.

The platform already calls a language model in one place. [AI journey generation](../../features/ai-journey-generation.md) sends one prompt to an OpenAI-compatible endpoint and validates the journey it gets back. It reads no table, sends no customer data, and writes no draft itself.

An agent that answers questions about customers is different in three ways. It must read customer data to answer. It must decide what to read next from what it found. And a wrong or careless design could send personal data to a model provider outside the deployment, or change a running journey on a guess.

The owner decided the agent's shape on 2026-11-17. The [CDP agent contract](../../features/cdp-agent.md) holds the rules.

## Decision

1. **Read-only, with draft proposals.** The agent explains and proposes. A proposed fix, such as a narrower entry or another channel, is a draft the marketer opens in the builder and publishes themself. The agent never writes campaigns, segments, or data. The owner decided this on 2026-11-17.
2. **No contact data reaches the model.** The agent sees `canon_id`, whose risk the owner accepted (see Consequences), behavior, metrics, segments, and keyed hashes of personal values: HMAC-SHA-256 under a key only the agent uses, not plain SHA-256, and not the tombstone key. Profile checks return flags, such as "has an email", not values. An email or a phone that staff type is resolved to `canon_id` on the server, and the value never goes to the model. Staff who need to see personal data open customer lookup under their own permissions, where `pii_access_log` applies. The owner decided this on 2026-11-17.
3. **A provider-agnostic tool-use model.** The contract requires only a model that supports tool use. It names no provider. The owner decided this on 2026-11-17.
4. **A hypothesis graph, not a decision tree.** For each question the agent builds its own graph of hypotheses and verifies each node with tools. The owner's tracing approach is its map of common causes, a starting point, not a script. The UI shows the graph with each node's state, `testing`, `confirmed`, or `ruled out`, and its evidence. The owner decided this on 2026-11-17.
5. **Its own permissions.** Such as `agent.use`, `agent.person_trace`, `agent.data_health`, and `agent.suggest`, which the owner gave as examples, mapped to roles by configuration per client. The agent reads only what the asking staff user may see, and grants no extra access. The owner decided this on 2026-11-17.

These are the lead's defaults, pending owner review: every conclusion carries evidence, or the agent says "not determined"; conversations are stored in Postgres per staff user; the read-only tool list the lead named, without the four tools the contract marks open; and a strict default mapping in which only `admin` has any agent permission.

## Why

**Read-only bounds what a wrong answer can cost.** A model can misread a number or confirm a cause on thin evidence. If the agent only explains and proposes, the worst outcome is a wrong explanation that a marketer checks against the evidence it cites. If the agent applied changes, the worst outcome is a running journey changed for thousands of customers on a guess. The journey builder already has a draft, a validator, and a publish step that a person confirms ([journey builder](../../features/journey-builder.md#publish)). A proposal that becomes a draft reuses all three, and the person who publishes it is accountable for it, as for any other draft.

**Keeping PII out of the model removes the data-processing question.** The model provider is outside the deployment. A prompt with a customer's email in it is a transfer of personal data to that provider, with its retention and training terms, in every deployment and for every provider a client picks. The questions the agent answers do not need the values: "has no email" explains a missing email message as well as the address would, and a `canon_id` names the person as well as their phone. Customer lookup already masks imported PII on the server for every viewer ([data import](../../features/data-import.md#privacy)). The agent follows the same line.

**A keyed hash, not a plain one.** A plain SHA-256 of an email can be reversed for any known address by hashing it, so it protects nothing against someone who has a customer list. An HMAC under a secret key cannot be computed without the key. `person_tombstones` uses HMAC for the same reason ([DIM-FR-23](../../features/data-import.md#functional-requirements)). A key the agent alone holds means an agent hash never matches a tombstone or any other feature's hash, so a model output or a stored conversation cannot be joined to other data by hash.

**Tool use is the one capability the design needs.** The agent's loop is: the model asks for a tool, the server checks permission and runs it, the model reads the result. Every current provider family and most self-hosted models offer that. Requiring nothing more lets a client choose a provider, or a self-hosted model, by its own data rules and cost.

**A graph adapts where a tree breaks.** A fixed decision tree encodes one path through the causes. Real cases skip steps, combine causes, or have a cause the tree lacks: a tracker release that renamed an event, a segment that emptied overnight. A tree either answers wrongly or stops. A graph the agent builds and verifies keeps the owner's order as its starting point, can add a hypothesis the evidence points to, and shows the user every hypothesis and why it was confirmed or ruled out. The user can check the reasoning, which a tree's output does not show.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| An agent that applies changes: edits the entry, switches the channel, pauses a journey | A model error would change running journeys for real customers. The builder's draft, validator, and publish step already exist, and a draft proposal reuses them with a person in charge of the change. The owner chose read-only. |
| Send PII to the model, with the provider's data terms as the safeguard | Every client and every provider would need a data-processing review, and a prompt log at the provider would hold customer contact data. The questions need flags and ids, not values. |
| Mask PII with a plain SHA-256 | Reversible for any known email or phone by hashing a list. |
| Reuse the tombstone key for the agent's hashes | Joins the agent's outputs to deletion records, and couples a key that never rotates to a feature that may need to rotate. |
| Name one model provider | Ties every client to that provider's terms, regions, and prices. Tool use is the only capability the design needs. |
| A fixed decision tree that encodes the owner's tracing order | Cannot follow a case the tree lacks, and shows the user an answer without the reasoning. The owner's order stays, as the map the agent starts from. |
| Give the agent its own read access, wider than the asking user's | An editor could read through the agent what studio does not show them, such as dropped records. The agent reads as the asking user. |

## Consequences

- Every tool reads as the asking user, and the server checks the permission on every tool call, not only on the question. A tool result is data, so text inside it cannot widen what the model may call.
- Tools return only `canon_id`, counts, configuration, flags, and keyed hashes. A new tool that needs a personal value must compute a flag or a hash on the server instead.
- Some causes cannot be confirmed until data exists. "The channel does not fit" needs delivery outcomes from the sender, which nothing feeds back today, so the agent says "not determined" for it.
- Event attributes may carry personal data, and the catalog has no PII flag, so the tools return no attribute values until that is decided.
- `canon_id` reaches the model as it is, and the owner accepted the risk on 2026-11-17. A `canon_id` derived from a `user_id` is an unkeyed name-based UUID of the value ([identity stitching](../components/identity/identity-stitching.md#derive-a-root)). When a deployment fills `user_id` with an email or a phone, anyone who holds the model provider's prompt log and a candidate list can compute each candidate's `canon_id` and recover the value. That is the attack this record rejects plain SHA-256 for, accepted here for `canon_id` only. Planned email and phone roots will carry the same risk.
- Profile attributes and condition and filter values reach the model, except values on identifier fields and PII-flagged columns, which are withheld or keyed-hashed. The owner decided this on 2026-11-17.
- Free text staff type, other than an email or a phone, reaches the model as typed until the contract's open question on typed personal data is answered.
- The deployment holds one more secret, the agent key, beside the tombstone key. Its rotation is not decided.
- The agent's answers can be only as good as the model and the tools. How their quality is measured is open, and so is the cost limit per user.
- A draft proposal enters the builder as an ordinary draft. Nothing the agent proposes reaches customers until a person publishes it.

## Related

- [CDP agent](../../features/cdp-agent.md)
- [AI journey generation](../../features/ai-journey-generation.md)
- [Customer lookup](../../features/customer-lookup.md)
- [Data import: privacy](../../features/data-import.md#privacy)
- [Admin authentication](../../features/admin-authentication.md)
- [0024. Create staff at their first sign-in, with the role the provider gives](0024-create-staff-at-first-sign-in-with-the-providers-role.md)
- [0042. Keep imported contact details in plain form behind masking and tombstones](0042-keep-imported-contact-details-plain-behind-masking-and-tombstones.md)
