---
name: db-migration
description: >
  Write, test, and review a Postgres schema change for the main database as a
  Flyway migration in infra/db/migrations, which the Job db-migrate applies on
  every Argo CD sync before any app rolls. Covers naming and the next version,
  the kustomization list, expand then contract, locks and timeouts, CREATE
  INDEX CONCURRENTLY, WAL size against the 8 GB slot cap, ownership by cdp,
  the files that change in the same commit, the local test, and the review
  checklist. Use for any change to a table, column, index, view, sequence,
  function, or publication in Postgres, and when reviewing one. Not for the
  import store, which keeps its own DDL.
---

# Write a database migration

The contract is [schema migrations](../../../docs/internal/architecture/components/schema-migrations.md). Its requirement ids, MIG-FR-xx and MIG-NFR-xx, are what a reviewer cites. [Decision 0043](../../../docs/internal/architecture/decisions/0043-apply-schema-changes-as-migrations-on-every-sync.md) says why it works this way.

On every sync, the Job `db-migrate` (wave 1) connects as `cdp` and applies every pending file in `infra/db/migrations/` in version order. The apps roll in wave 20 and up, only after the Job succeeds. Old pods of the previous release keep running against the new schema until they are replaced. A failed Job fails the sync, and the previous release keeps running.

## 1. Name the file and pick the version

1. List the versions on your branch and on the deploy branch. Another open pull request may already hold the next one.

   ```bash
   git fetch origin
   ls infra/db/migrations
   git ls-tree --name-only origin/deploy/aws-free-plan infra/db/migrations/
   ```

2. Take the next free four-digit number. Name the file `V<NNNN>__<snake_case>.sql`, such as `V0003__campaigns_archived_at.sql`. CI fails on another pattern, on two files with one version, and on CR bytes.
3. If another pull request merges first with the same version, rename yours to the next free number before you merge. Flyway refuses a version below one already applied (`outOfOrder = false`).
4. List the file in `infra/db/kustomization.yaml` under `configMapGenerator`, in version order. A file missing from the list never reaches the Job, and CI fails.

Never edit, rename, or delete a migration that is already on the deploy branch (MIG-FR-07). Flyway stores each file's checksum and fails every later run when an applied file changes. CI compares your branch with its base and fails on any such change. To change what an applied migration did, add a new one. There are no undo files.

## 2. Expand, then contract

Both releases run against the new schema during a rollout, so every migration must keep the previous release working (MIG-FR-13).

Safe in one release (expand):

- A new table, view, index, or sequence.
- A new nullable column, or a column with a constant default. On Postgres 16 a constant default does not rewrite the table.
- A new `CHECK` or foreign key added `NOT VALID`, then `VALIDATE CONSTRAINT` in a later migration.

Needs two or more releases (contract):

- Drop or rename a column or a table.
- Change a column's type.
- Set `NOT NULL` on an existing column.

For a rename, release 1 adds the new column and the code writes both. Release 2 backfills and reads the new column. Release 3 drops the old one, after no running image reads it. Each step is its own pull request and its own migration.

## 3. Keep locks short

Every session has `lock_timeout = 5s` and `statement_timeout = 15min` (MIG-FR-11). An `ALTER TABLE` that waits for its `ACCESS EXCLUSIVE` lock queues every later query on that table behind it, so the Job fails fast instead. The Job retries twice, and the next sync tries again.

- Keep each transactional file short. One `ALTER TABLE` per hot table per file is easiest to retry.
- The hot tables are `user_campaign_state_transitions`, `identity_graph`, and `user_metrics`. The Flink jobs write them all the time.
- For a long backfill, update in batches by key range, or raise the timeout for that file only, with `SET LOCAL statement_timeout = '1h';` at its top. Flyway runs every pending file on one connection, and a plain `SET` outlasts its transaction, so it would carry into every later file of the run. `SET LOCAL` ends with the file's transaction. CI checks that a later file still sees 15 minutes.
- Never raise `lock_timeout` in a transactional file. The one exception is a `CONCURRENTLY` file, in section 4.

## 4. Put `CREATE INDEX CONCURRENTLY` in its own file

`CREATE INDEX CONCURRENTLY` and `DROP INDEX CONCURRENTLY` cannot run in a transaction. Put them in a file with no other statement except the `SET`s below, and mark the file non-transactional in a `.sql.conf` beside it (MIG-FR-12). `mixed = false` rejects any other file that mixes the two kinds.

`CREATE INDEX CONCURRENTLY` waits for every transaction that started before it, and that wait is a lock wait, so the 5 second `lock_timeout` cancels it whenever a Flink sink batch, a studio query, or a CDC snapshot runs longer. A failed build leaves an `INVALID` index and a failed history row, and the sync stays stuck until someone cleans up by hand. So raise `lock_timeout` at the top of the file, and set it back at the end, because the file runs without a transaction and a plain `SET` lasts for the rest of the run. The wait is safe here: the build holds `SHARE UPDATE EXCLUSIVE`, which does not block the jobs' reads or writes.

```sql
-- V0004__idx_campaigns_status.sql
SET lock_timeout = '10min';
CREATE INDEX CONCURRENTLY idx_campaigns_status ON campaigns (status);
SET lock_timeout = '5s';
```

```properties
# V0004__idx_campaigns_status.sql.conf
executeInTransaction=false
```

The `.sql.conf` file is required. Without it, Flyway infers the file's mode from its statements, sees a `SET` beside `CONCURRENTLY`, and `mixed = false` rejects the file. List both files in `infra/db/kustomization.yaml`.

Check `statement_timeout` too. It stays 15 minutes, and it covers the wait and the build together. For a table whose build may take longer, raise it the same way, with `SET statement_timeout` at the top and `SET statement_timeout = '15min';` at the end. CI runs this file shape behind a 12 second transaction and checks that the next file sees 5 seconds again.

Leave out `IF NOT EXISTS`. A failed concurrent build leaves an `INVALID` index, and `IF NOT EXISTS` would then skip it silently. To recover, see [When a migration fails on the live database](#when-a-migration-fails-on-the-live-database). CI's `test-migrations.sh` runs that recovery on a unique index that fails over duplicate rows.

### When a migration fails on the live database

The Job fails, the sync stops, and the previous release keeps running. Every later sync fails on the same file until it is fixed.

1. Read the Job log (`kubectl -n cdp logs job/db-migrate`). It names the file and the Postgres error.
2. Look at the history: `SELECT version, success FROM flyway_schema_history ORDER BY installed_rank DESC LIMIT 5;`. A transactional migration rolls back and leaves no row. A failed `CONCURRENTLY` build leaves a row with `success = false` and an `INVALID` index.
3. A transactional file that failed for a transient cause, such as the 5 second `lock_timeout`, left nothing behind. Sync again.
4. A `CONCURRENTLY` file that failed, for any cause, left an `INVALID` index and a row with `success = false`, and Flyway refuses every later run until both are gone. As `cdp`, over stdin, run `DROP INDEX CONCURRENTLY IF EXISTS <name>;` and then `DELETE FROM flyway_schema_history WHERE NOT success;`. If the cause was transient, sync again with no change to the file.
5. If the file itself is wrong, fix it in a pull request with the label `migration-fix`, after step 4 for a `CONCURRENTLY` file, and re-run the `db-migrations` check after you add the label. The label lets CI accept an edit, never a delete or a rename, of a file on the deploy branch. The reviewer confirms from the history that the version has no successful row before approving.

A plain `CREATE INDEX` on a busy table blocks its writes for the whole build. Use `CONCURRENTLY` for any table the jobs write.

## 5. Size the WAL

Every CDC slot holds the WAL the whole database writes. [Decision 0039](../../../docs/internal/architecture/decisions/0039-shorten-the-cdc-restore-window.md) caps a slot at 8 GB (`max_slot_wal_keep_size`), and Postgres shares its disk with Kafka. A slot past the cap is invalidated, and CDC stops (MIG-NFR-01).

A statement that rewrites a table writes about the table's size plus its indexes in WAL: `ALTER COLUMN ... TYPE`, a column with a volatile default such as `now()` or `gen_random_uuid()`, `VACUUM FULL`, `CLUSTER`, or an `UPDATE` of every row. Before you ship one, measure the table on the live database:

```sql
SELECT pg_size_pretty(pg_total_relation_size('user_metrics'));
```

Above about 1 GB, split the change across several migrations or releases, or plan it with the owner. A new index writes about its own size in WAL.

## 6. Keep every object owned by `cdp`

The Job runs as `cdp`, so `cdp` owns what a migration creates (MIG-FR-09). Before every run, a callback fails the run if any table, view, sequence, function, or publication belongs to another role, and names each one (MIG-FR-10). The callback skips the members of an extension. Create an extension in a migration, as `cdp`, and only one that `cdp` may create. An extension that needs a superuser is a change to plan with the owner.

Never apply DDL by hand as `postgres`. On 2026-11-08, V3-02's tables were created by hand as `postgres` in the `cdp-pg-1` container. `cdp` could not alter `journey_drafts` or `journey_publishes`, and the first migration run would have failed until a superuser ran `ALTER TABLE ... OWNER TO cdp`. `/tmp` in that container is read-only, so that SQL had to come over stdin. If an emergency does need DDL by hand, hand each object to `cdp` in the same session.

A table that a CDC source reads joins its publication in the migration and gets `REPLICA IDENTITY FULL` (MIG-FR-15). The publication is owned by `cdp` like the rest.

## 7. Change everything else in the same commit

One commit holds:

- The migration, and its line in `infra/db/kustomization.yaml`.
- The same change in `infra/db/schema.sql`, with a comment on what the table or column is for. CI builds both from an empty database and fails when `pg_dump --schema-only` differs (MIG-FR-14).
- The `DSL.name(...)` fields in `event-processor/src/main/java/com/cdp/platform/shared/db/repositories/`. Grep the repositories for an old name after a rename.
- The queries in `studio/` and `shared/` that read or write the table. If `studio` reads a new table, add it to the tables `ensureDbInitialized` in `shared/lib/db.ts` checks.
- [docs/internal/architecture/data-model.md](../../../docs/internal/architecture/data-model.md), and the contract that owns the table.

## 8. Test it without the cluster

`infra/db/test-migrations.sh` runs the Job's own Flyway image and command against a throwaway Postgres. It checks names, the kustomization list, a run on an empty database, ownership, a second run, drift from `schema.sql`, the baseline, checksums, and session timeouts. CI runs it as the check `db-migrations`. Run it before you push:

```bash
docker run -d --name mig-pg -p 5432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16
BASE_REF=origin/deploy/aws-free-plan bash infra/db/test-migrations.sh
docker rm -f mig-pg
```

The script uses `--network host`, which works on Linux. On Docker Desktop, turn on host networking first. This is a test target, not the app stack, so it is allowed under the repo's rule against local runs. Also run the Java and studio tests, because they read `schema.sql`:

```bash
./event-processor/mvnw -f event-processor/pom.xml clean test
pnpm --filter studio test
```

## 9. Review checklist

- [ ] The name matches `V<NNNN>__<snake_case>.sql`, and the version is the next free one on the deploy branch.
- [ ] The file is listed in `infra/db/kustomization.yaml`.
- [ ] The diff only adds files under `infra/db/migrations/`. No applied migration is edited, renamed, or deleted. A `migration-fix` pull request edits only a version whose history has no successful row.
- [ ] The change is an expand step, or a contract step whose old shape no running image reads.
- [ ] No statement waits on a lock for long. A transactional file raises only `statement_timeout`, and only with `SET LOCAL`.
- [ ] Each `CONCURRENTLY` statement sits in a file with only such statements and its timeout `SET`s, has a `.sql.conf` with `executeInTransaction=false`, raises `lock_timeout` at the top and sets every raised timeout back at the end, and has no `IF NOT EXISTS`.
- [ ] The WAL it writes is sized and under about 1 GB, or the owner signed off.
- [ ] A new CDC table joins its publication and has `REPLICA IDENTITY FULL`.
- [ ] `schema.sql`, the jOOQ `DSL.name` fields, the studio queries, and `data-model.md` change in the same commit.
- [ ] The CI check `db-migrations` is green.
