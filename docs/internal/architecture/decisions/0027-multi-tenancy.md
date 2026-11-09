---
title: Serve several customers from one deployment
id: "0027"
status: proposed
date: 2026-10-18
tags: [tenancy, onboarding, architecture]
supersedes: []
superseded_by: []
---

# 0027. Serve several customers from one deployment

## Context

The platform has no idea of a customer. A customer here means a company whose website or app sends tracking data, and whose marketers build journeys in `studio`. Today each customer needs a deployment of its own: its own database, Kafka topics, Flink jobs, `studio`, OIDC client, and collector. [Onboarding a customer](../../operations/onboard-a-customer.md) works that way.

The code shows why. No table, topic key, keyed state, or `studio` page carries a tenant:

- `identity_graph`, `user_events`, `user_metric_definitions`, `campaigns`, `campaign_nodes`, `user_metrics`, and `user_campaign_state_transitions` have no tenant column. Two customers in one database would share one event catalog and one set of campaigns, and could stitch each other's identifiers together.
- Kafka records are keyed by `canon_id` or by journey key. Flink state is keyed the same way.
- The parser reads the Snowplow app id (`aid`) into `app_id`, and nothing downstream reads it.
- `studio` roles are `admin` and `editor`, with no scope. An admin sees every campaign.
- `customer_profiles` is one table, and the lookup key is a bare person id.

A deployment per customer is safe, because nothing is shared. It is also costly: every customer pays for its own Kafka brokers, Flink cluster, and Postgres, and every release has to roll out once per customer.

## Decision

Not decided. This record lists the options so that the choice is made on purpose, before the second customer arrives. Until then, the rule is one deployment per customer.

## Options

| Option | What changes | Isolation | Cost per customer |
|---|---|---|---|
| A. Deployment per customer (today) | Nothing | Full: separate data, compute, and credentials | Highest. A full stack each. |
| B. Shared everything, tenant id on every key | Every table gets `tenant_id` in its primary key. Kafka keys and Flink state keys start with the tenant. Topics stay shared. The collector maps each request to a tenant, by host name or by app id. `studio` scopes every query and role to a tenant, with one OIDC configuration per tenant. | Logical only. A missing tenant filter leaks data. | Lowest |
| C. Shared platform, separate data planes | One Kafka cluster and one Flink cluster. Each tenant gets its own topics (`<tenant>.snowplow-parsed`), its own Postgres database or schema, its own job instances, and its own `studio` deployment. | Strong for data, shared for compute | Medium |

## Why this matters now

Option B touches every contract that names a key or a table. Retrofitting it after data exists means a migration for every table and a re-keying of all Flink state, which a savepoint cannot carry over. Option C needs no code change to the jobs, because they already read topic names and database settings from the environment. It needs tooling to create a tenant's topics, database, and job set from one command.

## Open questions

- How many customers are expected in the next year, and at what event volume each? Option A is fine for a few large customers. Option B pays off for many small ones.
- Do any customers require their data in a given region, or on separate infrastructure by contract? That rules out B for them.
- Should one customer with several brands or apps be one tenant or several? Today `app_id` would be the only way to tell the apps apart, and nothing reads it.
- Who operates a shared platform, and how does a noisy tenant get throttled?

## Consequences of staying on option A

- Onboarding is a provisioning task. [The deploy skill](../../../../.agents/skills/deploy/SKILL.md) and [the runtime checklist](../../../../.agents/skills/deploy/references/runtime-checklist.md) apply once per customer.
- Releases roll out once per customer. Track the version each customer runs.
- Never point two customers' trackers at one collector.

## Related

- [Onboard a customer](../../operations/onboard-a-customer.md)
- [Event ingestion](../components/event-ingestion.md)
- [Identity stitching](../components/identity/identity-stitching.md)
