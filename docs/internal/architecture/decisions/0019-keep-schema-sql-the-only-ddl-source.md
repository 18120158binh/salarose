---
title: Keep schema.sql the only DDL source
id: "0019"
status: proposed
date: 2026-10-18
tags: [postgres, studio, schema]
supersedes: []
superseded_by: ["0024", "0043"]
---

# 0019. Keep `schema.sql` the only DDL source

> Superseded in part by [decision 0024](0024-create-staff-at-first-sign-in-with-the-providers-role.md): `studio` no longer runs upgrade steps for older staff tables, because no older database exists. The table check at start-up still holds.

> Superseded in part by [decision 0043](0043-apply-schema-changes-as-migrations-on-every-sync.md): Flyway applies versioned migrations on every sync. `schema.sql` stays as the readable schema, and CI checks that the migrations build the same one.

> Amended by [decision 0040](0040-import-through-a-batch-path-and-a-separate-store.md). Each Postgres cluster has one DDL file. `schema.sql` creates the main Postgres's tables, and the import store has its own file. No application creates tables.

## Context

`infra/db/schema.sql` defines every table. The `postgres-init-scripts` ConfigMap applies it to a new deployed database, and `pnpm db:reset` applies it locally. Studio also ran its own DDL on the first database call: `CREATE TABLE IF NOT EXISTS` for `system_users`, `campaigns`, and `campaign_nodes`. Its copy used `TEXT` where `schema.sql` uses `VARCHAR`, and it left out the other tables Studio reads, such as `user_events` and `user_metric_definitions`. So the schema had three copies: `schema.sql`, the Studio DDL, and the jOOQ names in the Flink jobs. A column change had to reach all three, and a database that only Studio had touched held tables in a shape `schema.sql` does not define.

## Decision

`schema.sql` is the only place that creates tables. Studio creates none. On its first database call it checks that every table it reads exists, and fails each call with the missing tables named if one does not. Studio keeps the upgrade steps for databases created before the OIDC sign-in: the `admin_users` rename, the added `system_users` columns, the `password` `NOT NULL` drop, and the two unique indexes. They change existing tables, which `schema.sql` cannot do, because it runs only on a new database.

This was chosen during the fix of PLT-KI-09. It is pending owner review.

## Why

- Both the deployed and the local setup apply `schema.sql` before Studio starts, so Studio's DDL only ran in practice on a database that was set up wrong. There it hid the mistake: Studio created three tables and failed later, on the first read of a table it did not create.
- Migration tools such as Flyway and Liquibase, and the migrations of Rails and Django, keep DDL in one step that runs before the application. Hibernate's `ddl-auto=validate` and Flyway's `validate` check the schema when the application starts instead of creating it. A check that names what is missing fails at the first call, with the fix in the message.
- The Flink jobs already work this way. They read and write tables that only `schema.sql` creates.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Generate Studio's DDL and `schema.sql` from one source | Needs a generator and a build step for three tables, and Studio would still create tables in an environment set up wrong. |
| Check a schema version table | The repo has no migration tool or version table, and `schema.sql` runs only on a new database, so nothing would raise the version on an existing one. A table check needs neither. |
| Keep Studio's DDL and fix the column types | Keeps a second copy that the next column change has to reach. |
| Adopt a migration tool now | The right long-term answer, but a larger change than this fix. This decision does not rule it out: the tool would replace `schema.sql` as the one source. |

## Consequences

- A table change edits `schema.sql`, the matching `*Table` class in the jobs, and, when Studio reads a new table, the list that Studio checks.
- A database without the schema fails on Studio's first call, with the missing tables named, instead of half working.
- The `system_users` upgrade steps stay in Studio until a migration tool takes them over.

## Related

- [Data model](../data-model.md)
- [Deployment upgrade note: Studio checks the schema instead of creating tables](../../operations/deployment.md#studio-checks-the-schema-instead-of-creating-tables)
- [Decision 0007](0007-staff-sign-in-through-oidc.md), whose upgrade steps Studio keeps
