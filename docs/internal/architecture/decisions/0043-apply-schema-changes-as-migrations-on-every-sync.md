---
title: Apply schema changes as versioned migrations on every sync
id: "0043"
status: accepted
date: 2026-11-08
tags: [postgres, schema, deployment, argo-cd]
supersedes: ["0019"]
superseded_by: []
---

# 0043. Apply schema changes as versioned migrations on every sync

## Context

[Decision 0019](0019-keep-schema-sql-the-only-ddl-source.md) made `infra/db/schema.sql` the only DDL source. CloudNativePG applied it once, when the cluster `cdp-pg` was first created, from the ConfigMap `postgres-init-scripts`, and a second step handed every object to the role `cdp`. After that, nothing applied a schema change. Each change shipped with an upgrade note in [deployment](../../operations/deployment.md#upgrade-notes), and an operator ran its SQL by hand.

The V3 lanes add tables in most pull requests. On 2026-11-08 the lead applied V3-02's DDL (#374) by hand as the container's default user, `postgres`. The tables `journey_drafts` and `journey_publishes` then belonged to `postgres`, and `cdp`, the role studio and the Flink jobs use, could not alter them. The pod's `/tmp` is read-only, so the SQL had to come over stdin. Every lane after V3-02 waited on the same hand step, and each one could leave objects with the wrong owner.

## Decision

Flyway applies the schema. Changes are versioned, forward-only files `V<NNNN>__<snake_case>.sql` in `infra/db/migrations/`, with no undo files. `infra/db/kustomization.yaml` packages the files and `infra/db/flyway.toml` into the ConfigMap `db-migrations`, whose name carries a hash of its content.

The Job `db-migrate` runs `flyway migrate` as an Argo CD `Sync` hook in sync wave 1. Wave 0 is the Postgres cluster and the apps start at wave 20. Argo CD waits for the Job, and a failed Job fails the sync, so no app rolls onto a schema that did not apply.

The Job connects as `cdp`, so `cdp` owns what each migration creates. A `beforeMigrate` callback fails every run, including a run with nothing pending, when an object in `public` or a publication belongs to another role, and names each object and its owner.

Every migration session sets `lock_timeout` to 5 seconds and `statement_timeout` to 15 minutes. Flyway's own lock holds no transaction open, so `CREATE INDEX CONCURRENTLY` can run, alone in its file.

`V0001__baseline.sql` is the schema at the deploy tip before V3-02. A database that holds that schema but no history table, the live one, gets a baseline row at version 1 and runs only the later files. An empty database runs every file. `V0002__journey_drafts_and_preview.sql` holds V3-02's DDL.

`infra/db/schema.sql` stays as the readable schema, with the comments that explain each table. CI fails when it and the migrations build different schemas.

The import store, `cdp-import-pg`, keeps its own DDL file under [decision 0040](0040-import-through-a-batch-path-and-a-separate-store.md). This record covers the main cluster only.

## Why

- **A hand step does not scale to one per pull request.** The V3 lanes ship schema changes in most pull requests, and each hand step waited on someone with superuser access to the pod. A Job that runs on every sync removes the wait.
- **The role that runs the DDL owns the objects.** V3-02's hand step showed the failure. DDL run as `postgres` leaves tables that `cdp` cannot alter, so the next migration on them fails. Running as `cdp` makes the right owner the default, and the callback turns a wrong owner into a failed sync that names the object, instead of a failed `ALTER` in a later release.
- **A `Sync` hook in wave 1, not `PreSync`.** Argo CD runs `PreSync` hooks before wave 0. On a new cluster, Postgres does not exist yet, so a `PreSync` Job could not connect. A `Sync` hook in wave 1 runs after the cluster and before every app.
- **A hook, not a plain Job.** A Job's pod template cannot change once created, and a completed Job never runs again. Argo CD creates a hook again on every sync, so the migrations run on every rollout. `BeforeHookCreation` keeps the last run's Job and log until the next sync.
- **Baseline at 1.** The live database holds the schema of `V0001` and no history table. Running `V0001` there would fail on its first `CREATE publication`, which has no `IF NOT EXISTS`. The baseline marks it as at version 1, and the same files then bring the live database and a new one to the same schema. The CI script proves that both reach the schema `schema.sql` builds.
- **`V0002` split from `V0001`.** The live database already holds V3-02's tables from the hand step. Inside `V0001`, the baseline would skip them on the live database, and a database restored from before the hand step would never get them. As its own file, `V0002` runs on every database at version 1. Each of its statements uses `IF NOT EXISTS`, so it is correct whether or not the tables are there.
- **`schema.sql` stays, with a drift check.** The Java schema tests, studio's PGlite test fixtures, and `infra/local/init-db.sh` read it. It is also the one place to read the whole current schema with its comments, which a stack of migration files is not. A second copy drifts unless something checks it, so CI builds both from empty and compares `pg_dump --schema-only`.
- **Forward only.** Flyway stores a checksum of each applied file and fails validation when the file changes. An edit to an applied file would reach new databases but not the live one. A new file reaches both.
- **Short lock timeout.** `ALTER TABLE` takes an `ACCESS EXCLUSIVE` lock. A statement that waits for it queues every later query on the table behind it, so a long wait stalls the jobs' writes. At 5 seconds the migration fails instead, and the Job's retry or the next sync tries again.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Keep upgrade notes and hand-run SQL | The V3 lanes blocked on it, and the hand step left V3-02's tables owned by `postgres`. |
| Liquibase | Its changelogs are XML, YAML, or SQL with a header per change set. Flyway runs plain SQL files with no wrapper, which is what reviewers already read in `schema.sql`. |
| A diff tool that compares `schema.sql` with the live database and applies the difference | It decides at deploy time what to drop or rewrite, so a reviewer never sees the statements that run. A rename looks like a drop and a create. |
| Migrations in studio's start-up | Studio would run DDL as it starts, once per replica, and the Flink jobs could start against an old schema. [Decision 0019](0019-keep-schema-sql-the-only-ddl-source.md) already moved DDL out of studio. |
| `PreSync` hook | Runs before wave 0, so on a new cluster it starts before Postgres exists. |
| Plain Job | Runs once. Its template is immutable, so a new migration needs the Job deleted by hand. |
| Delete `schema.sql` and read the schema from the migrations | The Java tests, the PGlite fixtures, and the local reset read it, and it is the only commented view of the whole schema. The drift check keeps the two equal. |
| Fold V3-02 into `V0001` | The baseline would skip it on any database at version 1, so a database without the hand step would never get the tables. |

## Consequences

- A schema change is a new file in `infra/db/migrations/`, listed in `infra/db/kustomization.yaml`, plus the same change to `schema.sql`, the jOOQ `DSL.name` fields, the studio queries, and [the data model](../data-model.md), in one commit. The [`db-migration` skill](../../../../.agents/skills/db-migration/SKILL.md) lists the steps.
- Old and new app images both run against the new schema during a rollout, because the apps roll after the Job. Every migration must keep the previous release working. Expand first, and contract in a later release.
- A migration that rewrites a large table writes WAL that every CDC slot holds. [Decision 0039](0039-shorten-the-cdc-restore-window.md) caps a slot at 8 GB, so size the WAL before shipping.
- Nobody applies DDL by hand as `postgres`. If an emergency needs it, hand the objects to `cdp` in the same session, or the next sync fails.
- Before the first sync after this change, a superuser must hand `journey_drafts` and `journey_publishes` to `cdp`. The [deployment upgrade note](../../operations/deployment.md#schema-migrations-on-every-sync) has the commands.
- The bootstrap no longer applies `schema.sql` or the owner step, and the ConfigMap `postgres-init-scripts` is gone.
- The `GRANT SELECT ON cdc_heartbeat TO pg_monitor` in the `customer_profiles` Job could move into a migration. It has not yet.

## Related

- [Schema migrations](../components/schema-migrations.md), the contract
- [0019. Keep `schema.sql` the only DDL source](0019-keep-schema-sql-the-only-ddl-source.md), superseded in part
- [0039. Shorten the CDC restore window](0039-shorten-the-cdc-restore-window.md), the WAL cap
- [0040. Import through a batch path and a separate store](0040-import-through-a-batch-path-and-a-separate-store.md), the import store's own DDL
- [Data model](../data-model.md)
