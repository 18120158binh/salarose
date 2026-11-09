# Deployment

GitHub Actions builds the Flink jobs image and the studio image, and Argo CD rolls them out. Agents deploy with the `deploy` skill in [.agents/skills/deploy](../../../.agents/skills/deploy/SKILL.md), which covers GitHub, AWS, a k3s cluster on an [AWS Free Plan account](aws-free-plan.md), and the local k3d cluster.

## Pipeline

[The CI/CD section of the AWS Free Plan page](aws-free-plan.md#cicd) lists every workflow, what it checks, and how a merged change reaches the cluster.

## Images

**Flink image** (`event-processor/Dockerfile`). Base `flink:2.2.0-java21`, with JARs added to `/opt/flink/lib`: the Postgres driver, Parquet, Hadoop client, commons-logging, OSHI, and JNA. The image does not contain the job JAR. The deployment loads the JAR from S3.

The connectors live only in the job JAR ([decision 0025](../architecture/decisions/0025-bundle-connectors-in-the-job-jar.md)). Don't add a Kafka, JDBC, or CDC connector JAR to the image. Flink resolves `org.apache.flink.*` classes from `/opt/flink/lib` before the job JAR (`classloader.parent-first-patterns.default`), so a copy in the image would replace the bundled one. The Postgres driver is the exception. Flink's class loading guide keeps JDBC drivers in `lib`, so the JAR leaves it out. Its version in `pom.xml` and in the Dockerfile must match, and a unit test fails when they differ.

**Admin image** (`studio/Dockerfile`). A four-stage build (base, deps, builder, runner) on `node:22-bookworm-slim` with pnpm 9.15.4. It produces a Next.js standalone server that listens on port 3000. Locally, the dev server uses 3001.

## Database

The Job `db-migrate` applies the schema on every Argo CD sync ([schema migrations](../architecture/components/schema-migrations.md), [decision 0043](../architecture/decisions/0043-apply-schema-changes-as-migrations-on-every-sync.md)). It is a `Sync` hook in wave 1, after the Postgres cluster in wave 0 and before the apps in wave 20 and up. It runs `flyway migrate` as `cdp`, with the database name, user, and password from the secret `cdp-pg-app`. A failed run fails the sync, and no app rolls.

| Object | Source | Holds |
|---|---|---|
| ConfigMap `db-migrations-<hash>` | [infra/db/kustomization.yaml](../../../infra/db/kustomization.yaml) | `flyway.toml` and every file in `infra/db/migrations/`. The hash changes with the content. |
| Job `db-migrate` | [infra/k8s/data/db-migrate.yaml](../../../infra/k8s/data/db-migrate.yaml) | The Flyway image pinned by digest, and the command that copies the ConfigMap's files to `/work` and runs `flyway migrate` |

`infra/k8s/data/kustomization.yaml` includes `infra/db`, so the ConfigMap lands in the namespace `cdp` next to the Job. A deployment managed from another Argo CD repo includes `infra/db` and the Job the same way.

The CloudNativePG bootstrap only gives `cdp` the `REPLICATION` attribute. It creates no table.

To read the last run's log, run `kubectl -n cdp logs job/db-migrate`. Argo CD deletes the Job only when the next sync creates it again. To see which migrations a database has, run `SELECT version, type, success FROM flyway_schema_history ORDER BY installed_rank;`.


## Build details

| Item | Value |
|---|---|
| Java | 21 |
| Flink | 2.2.0 |
| Thrift | 0.20.0. `CollectorPayload.java` is generated and checked in. `event-processor/scripts/download-thrift.sh` fetches the upstream definition. |
| Bundled in the JAR | Kafka connector 5.0.0-2.2 with Kafka client 4.2.0, JDBC connector 4.1.0-2.2, Postgres CDC 3.6.0-2.2, jOOQ 3.20.18, libthrift, Jackson, HikariCP, Caffeine |
| Provided by the image | Flink core with `flink-connector-base`, the Postgres driver 42.7.3, Parquet, Hadoop client, and the other JARs listed under Images |

The shade plugin writes `event-processor/dependency-reduced-pom.xml` on every package. Git ignores it.

## Upgrade notes

A first deploy creates the database from the migrations, starts every job without a savepoint, and needs none of the notes below. They describe changes between versions for a deployment that already runs. A note older than [Schema migrations on every sync](#schema-migrations-on-every-sync) may give SQL to run by hand. From that note on, a schema change ships as a migration, and its note says only what the migration changes and whether it is an expand or a contract step.

### Schema migrations on every sync

A schema change now ships as a migration file in `infra/db/migrations/`, and the Job `db-migrate` applies it on the next Argo CD sync, before any app rolls ([decision 0043](../architecture/decisions/0043-apply-schema-changes-as-migrations-on-every-sync.md)). Nobody runs DDL by hand. The CloudNativePG bootstrap no longer applies `schema.sql` or hands the objects to `cdp`, and the ConfigMaps `postgres-init-scripts` and `cdp-pg-schema-owner` are gone.

On the live database the first run finds tables and no `flyway_schema_history`. It writes a baseline row at version 1, the schema before V3-02, and applies `V0002__journey_drafts_and_preview.sql`. Every statement in `V0002` uses `IF NOT EXISTS`, so it changes nothing where V3-02 was applied by hand.

Before the run applies anything, it checks that `cdp` owns every table, view, sequence, function, and publication in `public`. V3-02 was applied by hand as `postgres`, so `journey_drafts` and `journey_publishes` belong to `postgres`, and the first sync would fail on them. Do these steps once, before the first sync of this change:

1. List the objects that `cdp` does not own. Connect as the superuser, the default in the `cdp-pg-1` container:

   ```bash
   kubectl -n cdp exec -i cdp-pg-1 -- psql -X -v ON_ERROR_STOP=1 -d auroracy <<'SQL'
   SELECT c.relkind, c.relname, pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S') AND pg_get_userbyid(c.relowner) <> 'cdp'
   UNION ALL SELECT 'publication', pubname, pg_get_userbyid(pubowner) FROM pg_publication WHERE pg_get_userbyid(pubowner) <> 'cdp';
   SQL
   ```

   Expect `journey_drafts` and `journey_publishes`, owned by `postgres`. Hand any other object in the list to `cdp` in step 2 as well.

2. Hand the tables to `cdp`. `/tmp` in the `cdp-pg-1` container is read-only, so send the SQL over stdin, not as a file:

   ```bash
   kubectl -n cdp exec -i cdp-pg-1 -- psql -X -v ON_ERROR_STOP=1 -d auroracy <<'SQL'
   ALTER TABLE journey_drafts OWNER TO cdp;
   ALTER TABLE journey_publishes OWNER TO cdp;
   SQL
   ```

3. Merge. The sync runs the Job in wave 1. If it fails, read `kubectl -n cdp logs job/db-migrate`. An ownership failure names each object and its owner. Hand them to `cdp` and sync again.

4. Check the history. `SELECT version, type, success FROM flyway_schema_history ORDER BY installed_rank;` returns `1 | BASELINE | t` and `2 | SQL | t`.

The baseline trusts that the live database already holds the schema of `V0001__baseline.sql`. An earlier upgrade note that was never run on it, such as [Studio v2 read indexes](#studio-v2-read-indexes), leaves a gap that no migration fills. Before the merge, compare the live schema with `schema.sql`, for example with `pg_dump --schema-only --no-owner --no-privileges` of both. This check is advice from reading the design, not something CI runs.

To ship a schema change from now on, follow the `db-migration` skill in [.agents/skills/db-migration/](../../../.agents/skills/db-migration/SKILL.md). The migration must keep the previous release working, because the old pods run against the new schema until the apps roll.

To roll back, revert the commit. The bootstrap change affects only a new cluster. `flyway_schema_history` stays and nothing reads it. A schema change that a migration applied stays too, because migrations are forward only.

### Segment membership conditions

Customer decision now reads `segments` through `segments_pub` and evaluates `segment_membership` conditions from each segment's current row (DEC-FR-30). `studio` keeps every metric that a segment names `LIVE` while the segment exists (CMP-FR-03, SEG-FR-06). The schema does not change. The publication already exists.

The job opens one more replication slot, `flink_decision_segments_slot`, so the jobs keep 8 slots. A savepoint rollout needs 9 at once, because the new source opens one temporary slot while it reads its first snapshot. A start without saved state needs 16. Check before the rollout:

```sql
SELECT current_setting('max_replication_slots') AS max_slots,
	current_setting('max_wal_senders') AS max_senders,
	(SELECT count(*) FROM pg_replication_slots) AS used_slots;
```

All slots read one WAL stream, so the extra slot holds the same WAL as the others, about 2 GB at the measured peak, under the 8 GB cap of [decision 0039](../architecture/decisions/0039-shorten-the-cdc-restore-window.md).

Roll out in this order:

1. Deploy `studio`. From the next segment save or delete, or campaign publish, pause, resume, or delete, every segment's metrics are `LIVE`.
2. Make the metrics of the segments that exist `LIVE` now, without waiting for such a save. The statement only raises a retention period, so the next save sets each one exactly:

	```sql
	WITH segment_windows AS (
		SELECT condition->>'metric_id' AS id,
			max((condition->'window'->>'value')::bigint * CASE condition->'window'->>'unit'
				WHEN 'SECONDS' THEN 1000 WHEN 'MINUTES' THEN 60000 WHEN 'HOURS' THEN 3600000
				WHEN 'DAYS' THEN 86400000 WHEN 'WEEKS' THEN 604800000 WHEN 'MONTHS' THEN 2592000000 END) AS window_ms
		FROM segments,
			jsonb_array_elements(conditions_json->'groups') AS grp,
			jsonb_array_elements(grp->'conditions') AS condition
		WHERE condition->>'type' = 'behavior' AND condition ? 'metric_id'
		GROUP BY 1
	)
	UPDATE user_metric_definitions AS d
	SET processing_mode = 'LIVE',
		retention_ms = GREATEST(d.retention_ms, w.window_ms),
		updated_at = CURRENT_TIMESTAMP
	FROM segment_windows AS w
	WHERE d.id = w.id
		AND d.processing_mode IN ('LIVE', 'PAUSED')
		AND (d.processing_mode <> 'LIVE' OR d.retention_ms IS DISTINCT FROM GREATEST(d.retention_ms, w.window_ms));
	```

3. Upgrade customer decision from a savepoint, without `allowNonRestoredState`. The new segments source has no state, so it reads every row of `segments` when it starts. The other operator ids and state do not change. A test restores the job from a snapshot that the previous version wrote.
4. Check that `flink_decision_segments_slot` exists and is `active`, with the query in [Durable CDC slots](#durable-cdc-slots).
5. Run the acceptance check on the cluster: a person who meets a segment takes `yes` at a check that tests it, one who does not takes nothing, and an edit of the segment changes the answer at the next event. Only then does the integrator add the `segment_membership` condition to the runtime registry.

A metric that turns `LIVE` here counts events from that moment, so a segment's behavior condition sees a full window only once that window has passed, as [segments](../features/segments.md#segment-size) says.

To roll back, restore the previous version from the savepoint of step 3, then drop the slot it no longer reads, or it holds WAL until the cap invalidates it: `SELECT pg_drop_replication_slot('flink_decision_segments_slot');`. A savepoint that the new version took holds the segments source's state, so the previous version restores it only with `allowNonRestoredState`. That restore has not been tested.

### Shorter CDC restore window

Each CDC source now confirms to its slot the log position of the checkpoint 10 completed checkpoints back, down from 120, and Postgres caps the WAL a slot holds at 8 GB, up from 3 GB. The restore window shrinks from about one hour to about 5 minutes, and from about two hours to about 10 minutes for the outbox job ([decision 0039](../architecture/decisions/0039-shorten-the-cdc-restore-window.md)). Before, a slot held the WAL of 120 checkpoints, and at peak writes that passed the 3 GB cap within minutes. Postgres then invalidated every slot, and the jobs kept running without reading CDC (#320).

The count is not in the source's state. The connector's reader builds it in memory when it starts and checkpoints only its splits, so the source counts completed checkpoints from 0 in every run. So operator ids and state do not change, and each job restores from a savepoint as usual. This was read in the connector's bytecode, version 3.6.0-2.2. It has not been run.

On the [AWS Free Plan](aws-free-plan.md) environment the two settings reach the cluster in two separate commits:

1. Merging this change to the deploy branch changes only Postgres. Argo CD applies the cluster at sync wave 0, and the operator reloads its configuration. `max_slot_wal_keep_size` takes effect without a restart, because Postgres reads it on reload. The merge also makes CI build a new Flink jobs image, because it changes `event-processor/`, but the overlay still names the old image tag, so the jobs keep running the old image.
2. A second commit sets the new image tag that CI printed in the overlay's `images` entry for `cdp/flink-jobs`. Argo CD's sync of that commit rolls each Flink job through a savepoint, and from then on its sources confirm 10 checkpoints back.

Between the two commits the jobs still hold 120 checkpoints of WAL, about 22 GB at the measured peak, so a burst still invalidates every slot under the 8 GB cap. Run no load test until the image commit has rolled out and every job is RUNNING on the new tag. On another deployment the order is the same: apply the Postgres change first, then upgrade each Flink job from a savepoint.

After the upgrade, the savepoint taken before it stays restorable only until the new run completes 10 checkpoints. Roll back within that, or follow [Rolling back to an older savepoint](#rolling-back-to-an-older-savepoint). The previous version holds 120 checkpoints of WAL again, so at peak writes its slots pass the 8 GB cap in about 22 minutes. Roll back only at low load. This is inferred from the measured WAL rate, not run.

### CDC restore window

Every CDC source is now the connector's incremental snapshot source, on one subtask, and keeps its log position in a different state. No savepoint or checkpoint from before this change restores a CDC log position, so each job that reads CDC needs a fresh start. Nothing is deployed yet, so the first deploy's fresh start is the only step.

### Trigger branch names

Before this change, customer decision sent `yes` for every node. Since the fix, a setup node completes on `next`, a watch node on `success`, and a check on `yes` or on the key of the branch it matched.

State machine state from before the fix holds setup nodes, watch nodes, and multi-branch checks that completed on `yes`. A node completes once, and a child follows its parent only on the branch it was saved under. So each journey with such a node stays blocked. `STATE_MACHINE_JOURNEY_STATE_TTL_MS` resets on every read and write, so the state of an active customer never expires. Old `yes` triggers still in the trigger topic have the same effect. This is inferred from the code, not run.

The state machine resumes the trigger topic from its consumer group's committed offset, so a fresh start still reads old triggers it had not consumed. Deploy in this order:

1. Stop the decision job.
2. Let the state machine consume the trigger topic until its lag is 0.
3. Stop the state machine.
4. Deploy the new decision job, and start the new state machine without restoring a savepoint or checkpoint taken before this change.

Journeys that were in progress then start again from their setup node on the next matching event. A node the person had already reached writes no second transition, because the transition insert skips an existing person, campaign, and node. So the outbox sends no second notification for it, and `campaign_node_stats` does not count the restart. This is inferred from the code, not run.

### Profile writer sink

The profile writer's Postgres sink no longer has a committer operator. The old graph had one, named `Sink Committer: postgres-user-metric-sink`. A savepoint taken before this change holds state for that operator, so restoring it fails unless the job allows non-restored state. Set `allowNonRestoredState: true` in the Flink operator's job spec, or pass `--allowNonRestoredState` to `flink run`. The impact is low. The job keeps only its Kafka offsets, and those restore as before.

The sink reports the rows it skips in the `numRowsSkipped` metric of its writer operator.

### Behavior versions

Mutations on `customer-profile-mutations` now carry a behavior version, for the mutation and for each occurrence.

- Deploy the customer decision job and the profile writer together. The new profile writer drops a mutation without a version. A profile writer from before [Profile writer tolerant decoding](#profile-writer-tolerant-decoding) rejects the new field.
- You can restore the customer decision job from a savepoint taken before this change. Restored occurrences have version 0. The job gives them the current version when it next updates their series, so no mutation carries a 0.
- Before you start the customer decision job without a savepoint, let the profile writer catch up on `customer-profile-mutations`. The job continues each person's version from `user_metrics`. A mutation still in the topic can carry a higher version, and the writer then ignores the person's next changes to that metric until the new counter passes it.
- A start without a savepoint of a version before [Customer decision series lookup](#customer-decision-series-lookup) also makes `INACTION` conditions fire wrongly for a while. See [Customer decision metric snapshot](#customer-decision-metric-snapshot) for the campaigns to pause first.

### Identity graph sink

The event parse job now writes `identity_graph` through its own upsert sink, keyed by `domain_userid`. The stitcher, the sink, and the steps between them have fixed operator ids. Only this job changes, so there is no deploy order.

- A savepoint taken before this change holds state for the old sink and for the stitcher under a generated id. Restore it with `allowNonRestoredState: true` in the Flink operator's job spec, or pass `--allowNonRestoredState` to `flink run`.
- The stitcher's state does not carry over. It rebuilds from `identity_graph` one device at a time, so expect one lookup per active device after the deploy. Until [Identity lookups off the stream's thread](#identity-lookups-off-the-streams-thread), the lookups blocked the stream (IDS-KI-12), so the job lagged for a while. A fresh start has the same effect.
- If the Kafka source's state does not restore either, it resumes from the offsets its consumer group committed.
- The job is now named `event-parse-job`.
- The schema does not change. A row keeps the `updated_at` of its insert until its device sends another event.
- Before this change, an anonymous event cleared the stored `user_id`. Those rows stay null until the device logs in again. The table holds nothing to restore them from.
- The sink skips a row the database rejects for its data, and counts it in the `numRowsSkipped` metric of its writer operator. The old sink failed the job.

### Identity stitcher lookups

The event parse job changes in three ways. Only this job changes, so there is no deploy order.

- A failed or timed-out `identity_graph` read no longer looks like "no row". The event is published with a `canon_id` from state, and neither the stitcher's state nor `identity_graph` keeps it. `IDENTITY_LOOKUP_TIMEOUT`, default `1s`, bounds each lookup.
- A login on a device already in state now reads `identity_graph` for the `user_id`, so the device joins the user's stored `canon_id`. Expect one lookup per new `user_id` on a known device.
- The stitcher now writes the `identity_graph` rows itself, through a side output. The operators `events-with-a-device` and `identity-graph-rows` are gone. They kept no state.

Restore from a savepoint or checkpoint taken before this change. The stitcher keeps its operator id, `identity-stitcher`, and its state. It now runs as a keyed process function instead of a map, which Flink restores by operator id. This is inferred from the code, not run. If the restore fails, start without the savepoint. The stitcher then rebuilds from `identity_graph`, as the identity graph sink note describes.

Devices whose `canon_id` a failed lookup overwrote before this change keep the derived id in `identity_graph`. The table holds nothing to restore them from.

### Unique event system names

`user_events.event_name` is now unique, and `user_events.display_name` is no longer unique. A database created before this change has the opposite constraints and may already hold two events with the same system name. Adding the new constraint fails until each system name has one row. Run these steps on each existing database. They can run before or after the new `studio` is deployed. Until step 5 runs, `studio` still accepts a duplicate system name and still rejects a duplicate display name with a raw database error.

1. Find the duplicates and what uses each row:

   ```sql
   SELECT ue.event_name, ue.id, ue.display_name, ue.created_at,
          (SELECT count(*) FROM user_event_fields f WHERE f.user_event_id = ue.id) AS attributes,
          (SELECT count(*) FROM user_metric_definitions m WHERE m.user_event_id = ue.id) AS metric_definitions,
          (SELECT count(*) FROM campaign_nodes cn
            WHERE cn.aggregation_json IS NOT NULL
              AND COALESCE(cn.aggregation_json::jsonb ->> 'user_event_id',
                           cn.aggregation_json::jsonb ->> 'event_id') = ue.id) AS campaign_nodes
   FROM user_events ue
   WHERE ue.event_name IN (
     SELECT event_name FROM user_events GROUP BY event_name HAVING count(*) > 1
   )
   ORDER BY ue.event_name, ue.created_at, ue.id;
   ```

2. For each system name, pick the row to keep. Prefer the row that metric definitions and campaign nodes use.
3. Delete each other row whose `metric_definitions` and `campaign_nodes` counts are 0. Its attributes go with it.

   ```sql
   DELETE FROM user_events WHERE id = '<duplicate id>';
   ```

4. A duplicate row that metric definitions or campaign nodes use needs a person. Deleting it also deletes its metric definitions and their `user_metrics` rows. Open each campaign that uses the row in the builder, point its metric conditions at the kept event, and publish it. Then run step 1 again and delete the row as in step 3.
5. Add the new constraint and drop the old one:

   ```sql
   BEGIN;
   ALTER TABLE user_events ADD CONSTRAINT user_events_event_name_key UNIQUE (event_name);
   ALTER TABLE user_events DROP CONSTRAINT user_events_display_name_key;
   COMMIT;
   ```

   `studio` turns a violation into the message "An event with the system name ... already exists" only when the violated constraint is named `user_events_event_name_key`, so keep that name. If the `DROP` fails because the constraint has another name, the transaction rolls back. List the unique constraints on the table, then run the block again with the name of the one on `display_name`:

   ```sql
   SELECT conname, pg_get_constraintdef(oid)
   FROM pg_constraint
   WHERE conrelid = 'user_events'::regclass AND contype = 'u';
   ```

Deleting an event now deletes only its `user_events` row and relies on the foreign keys to delete its attributes and metric definitions. Check that each foreign key to `user_events` cascades, that is, that `confdeltype` is `c`:

```sql
SELECT conrelid::regclass AS table_name, conname, confdeltype
FROM pg_constraint
WHERE confrelid = 'user_events'::regclass AND contype = 'f';
```

If one does not cascade, deleting an event that has rows in that table fails with a foreign key error and deletes nothing.

### Multi-branch check conditions

`studio` now saves a multi-branch check's own event condition under `condition`, next to `branches`, and saves the branches even when the check has no condition of its own. See the [saved format](../features/journey-builder.md#saved-format). Before, it put the condition's keys at the top level, and saved `condition_json` as null when the check had no condition. The customer decision job read the old shape as a check with no event condition, so the check fired on every event.

Deploy in this order:

1. Deploy the customer decision job. It reads the old and the new shape. The job graph and the state layout do not change, so restore from a savepoint as usual.
2. Deploy `studio`.

The old decision job already reads the new shape. Deploying the job first means that rows the old `studio` still writes before step 2 are read correctly too.

The job keeps each parsed node in broadcast state and reads a `campaign_nodes` row again only when the row changes, or on a start without a savepoint, when the change stream takes a new snapshot. So after a restore, an active multi-branch check published before this change still fires on every event. A check that had no condition of its own still has no branches, and its children never run. Rewrite the rows of each active campaign with a multi-branch check: after step 2, pause it and resume it in `studio`. Resume saves the node rows again from the stored journey. It also renames End nodes once, as [Stable End node ids](#stable-end-node-ids) describes. This is inferred from the code, not run.

### Stable End node ids

`studio` used to give each End node a new random `node_id`, such as `end-goal_default-k3x9a2b1c`, every time it saved the node rows. Publish and resume both save them. An End node's `node_id` is now its parent's `node_id`, its branch, and `end`, for example `node_1712345678901-yes-end`. See the [saved format](../features/journey-builder.md#saved-format). Other nodes already kept their ids.

The change takes effect for a campaign the next time its node rows are saved. A campaign published before this change gets its new End ids when it is paused and resumed, and keeps them after that. A new campaign gets them on its first publish. There is no deploy order, no schema change, and no Flink restart.

The new ids stay stable only while the tree above an End node stays the same. Editing a draft can still rename one: adding a parallel sibling renames `check_1-yes-end` to `check_1-yes-0-end`, and inserting a node above it renames it after the new parent. Active and paused campaigns open read-only, so a running journey keeps its ids.

- **Counts.** Each End node's count in `campaign_node_stats` starts again from zero under its new id, as it did after every publish and resume before. The old rows stay. To remove rows that no node uses, run this after resuming the campaigns you want to keep counting:

  ```sql
  DELETE FROM campaign_node_stats s
  WHERE NOT EXISTS (
    SELECT 1 FROM campaign_nodes n
    WHERE n.campaign_id = s.campaign_id AND n.node_id = s.node_id
  );
  ```

  Once the [node stats view](#node-stats-view) is in place, `campaign_node_stats` is a view and this `DELETE` fails. The counts under old ids then stay in the view, and the builder does not show them.

- **Journeys in progress.** They are not affected, and you do not need a quiet period. The state machine completes an End node in the same step as its parent, and no node has an End node as its parent. So no person waits at an End node, and the state machine never reads a completed End node's state again. A person who completed the old End node does not complete the new one, because the state machine ignores a second trigger for its already completed parent. This is inferred from the code, not run.

### Customer decision uids and RocksDB

The customer decision job now gives each of its operators and table sources a fixed uid, and keeps its state in RocksDB. The job sets the state backend itself, so a `state.backend.type` in the cluster configuration does not change it. The Flink distribution in the image includes RocksDB. This is inferred, not run.

Heap state and RocksDB state have different native formats. Only a savepoint in canonical format can move between them. A checkpoint or a native savepoint taken before this change does not restore.

RocksDB keeps state on the task manager's local disk and uses Flink managed memory. Check both on the task managers before you deploy. The state TTL now also removes expired entries during RocksDB compaction.

### Customer decision event dedup

The customer decision job now forgets remembered event ids in the order it accepted them, through a ring of 512 slots per person. The operator `apply-behavior-state` adds two keyed states, `recent-user-event-id-slots` and `recent-user-event-id-next-slot`. The existing `recent-user-event-ids` state keeps its name and type. The job graph and the operator uids do not change.

- Restore from the last savepoint or checkpoint as usual. You do not need `allowNonRestoredState`. The new states start empty.
- No remembered id is dropped. Ids remembered before this change are in no slot, so the ring never forgets them. They still drop a replayed event, and they expire with the state TTL, at most 31 days after the job last wrote them, or 32 days before [Customer decision settings, mutations, and IN lists](#customer-decision-settings-mutations-and-in-lists). Until then a person can hold up to 1024 ids: up to 512 from before the change and 512 in the ring.
- There is no deploy order with other jobs.
- A rollback to the previous version restores from a savepoint taken by this version. The previous version ignores the two new states and reads `recent-user-event-ids` as before. This is inferred from Flink's state handling, not run.

### State machine watermark

The state machine's watermark now advances. Before this change it never did, so the state machine dropped no trigger as late or unreachable, and buffered triggers stayed in state until the TTL. Now `lateMatchedEvents` and `unreachableMatchedEvents` count drops for the first time. A watch timeout that arrives behind the watermark is still applied. Alert on `lateMatchedEvents`. If customer decision falls more than the allowed out-of-orderness behind, its backlog is dropped as late, as [decision 0008](../architecture/decisions/0008-one-trigger-watermark-for-both-producers.md) proposes, and that counter is the only sign. [Monitoring](monitoring.md) has the reporter settings and the alert rule.

The job graph changed. The `campaign_nodes` stream has a new watermark operator, and the state machine operator has the fixed uid `journey-state-machine`. Its old id was derived from the graph, so no savepoint or checkpoint taken before this change restores into it. Flink refuses such a restore. Do not pass `allowNonRestoredState`. The sources would then resume their Kafka offsets and CDC position without the broadcast campaign graphs, and the graphs would not load again until each node row changes. This is inferred from Flink's operator id rules, not run.

Only the state machine changes. Customer decision and the outbox job keep running. Deploy in this order:

1. Let the old state machine consume the trigger topic until its lag is 0.
2. Stop the state machine.
3. Start the new state machine without a savepoint or checkpoint.

The fresh start reads a new snapshot of `campaign_nodes` and resumes the trigger topic from the committed offsets. Journey progress is lost, as [decision 0005](../architecture/decisions/0005-keep-live-state-in-flink.md) describes. A journey in progress starts again from its setup node on the next matching event. A node the person had already reached writes no second transition, so the outbox sends no second notification for it. A trigger read before its campaign's graph loads from the snapshot waits for the graph, for up to the [graph-load allowance](#state-machine-graph-load-allowance). Since [graph loads on a fresh start](#graph-loads-on-a-fresh-start), the allowance also runs in real time from the start, so a backlog cannot outrun the snapshot.

### Old OR-rooted event conditions

Builds of `studio` before the event condition editor fix saved the event name row and the catalog default rows inside the marketer's root group. With an OR root, a setup, check, or watch node then matched any event that satisfied one row, whatever its name. `studio` now joins the event name and catalog default rows with AND to the marketer's group whenever it saves a campaign's node rows: on publish, on publish from the campaign list, and on resume. The stored journey is not rewritten.

Existing rows change only when they are saved again:

1. An active campaign keeps its old rows, and keeps matching any event with a matching attribute, until someone pauses and resumes it. Pause and resume each active campaign to apply the fix. Resume also renames End nodes once, as [Stable End node ids](#stable-end-node-ids) describes.
2. A paused campaign picks up the fix when it is resumed. Expect it to match fewer events than before: only events with its own name.

A flat AND root saved by older builds changes shape but not meaning. This is inferred from the code, not run.

### Profile writer tolerant decoding

The profile writer now ignores mutation fields it does not know. It writes each `user_metrics` row once per batch, and it chooses the value array from the metric's `valueType`. Only the profile writer changes. Its job graph and operator uids do not.

- Restore from the last savepoint or checkpoint as usual. You do not need `allowNonRestoredState`.
- Deploy this profile writer before any customer decision release that adds a field to mutations. An older profile writer drops every mutation that has a field it does not know.
- A row that stopped updating after its metric changed value type updates again on the person's next change to that metric. The writer stores a value of the old type as null.
- A `NUMBER`, `STRING`, or `BOOLEAN` row whose series has no values now holds an array of nulls in its value column, where it held null before. A query that tests the value column with `IS NULL` sees the difference.
- The writer skips and logs a metric without `valueType` or with an unknown one. Customer decision always sends `PRESENCE`, `NUMBER`, `STRING`, or `BOOLEAN`, so no current message is skipped. This is inferred from the code, not run.

### Campaign ownership checks

`studio` now checks `campaigns.created_user` before it publishes, pauses, resumes, or deletes a campaign. The schema does not change, and only `studio` changes, so there is no deploy order.

- A campaign whose `created_user` is null has no owner. Only an admin can pause, resume, or delete it, and nobody can publish a draft over its id. An admin's campaign list shows it, marked "No owner". To let an editor manage one, give it an owner:

  ```sql
  SELECT id, name, status FROM campaigns WHERE created_user IS NULL;
  UPDATE campaigns SET created_user = '<system_users.id>' WHERE id = '<campaign id>';
  ```

- New campaign ids are `CAMP-` and 16 hexadecimal digits. Existing ids such as `CAMP-0001` keep working. Nothing parses the id, and the column is free text.
- Resume now rebuilds a campaign's node rows from the tree stored in `campaigns.root`. If the stored tree and the node rows differ, for example after a manual edit, the next resume writes rows that match the tree.
- Publish and resume now reject a malformed tree: a root that is not a setup node, a second setup node, a repeated node id, a multi-branch check with no branches or with a branch key outside the saved format, a time limit of zero or less, or more than 200 levels. A paused campaign whose stored tree breaks one of these rules stays paused, and the error names the place in the tree. Clone it, fix the journey in the builder, and activate the copy.

### Customer decision metric snapshot

Metric conditions in the customer decision job now see every series the job holds in state for the person, not only the series the current event changed. A series the person does not have counts as empty, so `INACTION` conditions can pass. This version does not load a series that is missing from state, for example after a start without a savepoint. [Customer decision series lookup](#customer-decision-series-lookup) adds that load. To carry the series, the records passed between the job's operators changed type. The Kafka messages do not change: mutations on `customer-profile-mutations` and triggers on `journey-engine-matched-events` keep their format. The schema does not change, and no other job is affected, so there is no deploy order.

The profile lookup operator keeps the records waiting for a profile in its state, typed by its input. Flink cannot restore that state into the new type and fails the restore with `StateMigrationException`. A throwaway operator test checked this. So the lookup has a new uid, `profile-lookup`, and no longer carries the old id `f051b02e14e9b72ba38c4237eeb05281`. The other operators keep their uids and their state.

1. Stop the customer decision job with a savepoint, as usual.
2. Start the new job from it with `allowNonRestoredState: true` in the Flink operator's job spec, or pass `--allowNonRestoredState` to `flink run`.
3. Check the job manager log. Flink writes `Skipping savepoint state for operator <id>.` for each state it drops. The only id should be the old lookup's: `5beed7aa6a4bf5563e4f9b1859a5aeba` for a savepoint taken with uids, or `f051b02e14e9b72ba38c4237eeb05281` for a savepoint from before them. Any other id means other state did not map.

Events that waited for a profile when the savepoint was taken are lost from the decision path, so they emit no trigger. A subtask holds at most `CAMPAIGN_LOOKUP_CAPACITY` of them, 1000 by default. Their mutations are not affected, because the job emits a mutation before the lookup. Take the savepoint when traffic is low to lose fewer.

A rollback to the previous version needs `allowNonRestoredState` too, for the same operator. This is inferred from Flink's state handling, not run.

After any start of the decision job without a savepoint or checkpoint, `INACTION` conditions fire wrongly for a while. The job then has no series in state. It reads a person's series from `user_metrics` only when an event updates that series, not when a condition needs it. So `INACTION(m_purchase_count) = 0` passes for a person whose purchase is stored only in `user_metrics`, and the journey sends a message to someone who did buy. Before this change `INACTION` never passed, so this wrong result is new. Several notes on this page start the decision job without a savepoint, and so does a restore that fails. Until [Customer decision series lookup](#customer-decision-series-lookup) is deployed, do this around each such start of the decision job. A start of that version or a later one does not need it:

1. Before the start, list the active campaigns with an `INACTION` condition:

   ```sql
   SELECT c.id, c.name, n.node_id, n.aggregation_json
   FROM campaigns c
   JOIN campaign_nodes n ON n.campaign_id = c.id
   WHERE lower(c.status) IN ('active', 'live')
     AND n.aggregation_json ILIKE '%inaction%'
   ORDER BY c.id, n.node_id;
   ```

   The text match also lists a node whose metric id or threshold contains `inaction`. Read `aggregation_json`, and keep the nodes with `"function": "INACTION"` in any comparison. A `COUNT` condition such as `< 1` or `= 0` also passes on an empty series. Look for those in the same rows.
2. Pause those campaigns in `studio` before the start. A pause stops the whole campaign, not only the node.
3. Resume each campaign once its longest `INACTION` window has passed since the start. By then no occurrence from before the start is inside the window, so an empty series gives the right answer. A condition with no window counts all history, and so does one with the unit `WEEKS` or `MONTHS` before [Metric window units and truncated series](#metric-window-units-and-truncated-series). Resume its campaign after `USER_METRICS_STATE_RETENTION_DAYS` plus 1 days, 32 by default, when state from before the start would have expired anyway.

A person's series also rebuilds sooner, from `user_metrics`, when they do the counted event again. That does not help the people an `INACTION` rule targets, so wait out the window. This is inferred from the code, not run.

Each event now carries the person's series from the metric update to candidate selection, where the job used to send only the series the event changed. Candidate selection passes on only the series its candidate rules reference. The metric update also reads every series of the person from RocksDB on each event. Measured serialized sizes of one record on that edge: 122 bytes with no series, 3.3 KiB with 5 series of 10 occurrences, 58 KiB with 10 series of 100, and 745 KiB with 128 series of 100 `PRESENCE` occurrences, 857 KiB for `NUMBER`. The last case is the state limit per person in DEC-NFR-01 and DEC-NFR-02. A later change moved candidate selection into the metric update, which now reads and sends only the series that candidate rules reference.

### Node stats view

`campaign_node_stats` is now a view over `user_campaign_state_transitions`, and the trigger that filled the old table is gone. See [decision 0009](../architecture/decisions/0009-compute-node-stats-as-a-view.md). The view keeps the table's name and columns, so `studio` needs no change. No Flink job changes. There is no deploy order and no restart. Run these steps on each existing database, at any time.

1. Create the index that the view reads. `CONCURRENTLY` does not block the state machine's inserts, but it cannot run inside a transaction.

   ```sql
   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ucst_campaign_node
   ON user_campaign_state_transitions (campaign_id, node_id, canon_id);
   ```

   A failed build leaves an invalid index, and `IF NOT EXISTS` then skips it. Check that this returns `t`. If it returns `f`, run `DROP INDEX CONCURRENTLY idx_ucst_campaign_node;` and step 1 again.

   ```sql
   SELECT indisvalid FROM pg_index WHERE indexrelid = 'idx_ucst_campaign_node'::regclass;
   ```

2. Replace the trigger and the table with the view, in one transaction. The transaction scans nothing, so it is short. Until it commits, `DROP TRIGGER` makes the state machine's sink wait, and the rename makes the builder's read wait. `DROP TRIGGER` needs an exclusive lock on `user_campaign_state_transitions`; behind a long query it would queue every sink insert and outbox read, so the block gives up after 5 seconds. If it fails with `lock timeout`, run it again.

   ```sql
   BEGIN;
   SET LOCAL lock_timeout = '5s';
   DROP TRIGGER IF EXISTS trg_stmt_campaign_stats ON user_campaign_state_transitions;
   DROP FUNCTION IF EXISTS trg_update_campaign_node_stats();
   ALTER TABLE campaign_node_stats RENAME TO campaign_node_stats_before_view;
   CREATE VIEW campaign_node_stats (campaign_id, node_id, user_count) AS
   SELECT campaign_id, node_id, COUNT(DISTINCT canon_id)
   FROM user_campaign_state_transitions
   GROUP BY campaign_id, node_id;
   COMMIT;
   ```

   If `DROP FUNCTION` fails because another trigger still uses the function, the transaction rolls back. A deployed database may have a trigger under another name. List the triggers on the table, then run the block again with that name in `DROP TRIGGER`. After the commit, the list must be empty.

   ```sql
   SELECT tgname FROM pg_trigger
   WHERE tgrelid = 'user_campaign_state_transitions'::regclass AND NOT tgisinternal;
   ```

The view computes each count from the transitions, so the old counter rows do not carry over:

- Each count is the number of people with a transition on the node, on any branch.
- Nodes that completed on `no` now show counts. The old trigger never recorded them.
- A count also differs from its old row when transitions were written before the trigger existed, or were deleted or changed by hand.
- Counts under old End node ids stay in the view while their transitions exist. See [Stable End node ids](#stable-end-node-ids).

To see which counts changed, compare the old table with the view:

```sql
SELECT campaign_id, node_id, o.user_count AS before_view, v.user_count AS view
FROM campaign_node_stats_before_view o
FULL JOIN campaign_node_stats v USING (campaign_id, node_id)
WHERE o.user_count IS DISTINCT FROM v.user_count
ORDER BY campaign_id, node_id;
```

When you no longer need the old counts, run `DROP TABLE campaign_node_stats_before_view;`. To roll back before that, drop the view, rename the table back, and create the function and the trigger from `infra/db/schema.sql` as it was before this change. The old table then lacks the transitions written since step 2.

### State machine graph-load allowance

A buffered trigger whose node, or a node above it, is missing from its campaign's graph now waits at most the graph-load allowance after the watermark passes it. Then the state machine drops it as unreachable and counts it in `unreachableMatchedEvents`. Before this change such a trigger stayed buffered until the journey state expired, which never happens while the journey is active. Expect `unreachableMatchedEvents` to rise after a marketer deletes a watch node or a campaign with journeys in progress.

`STATE_MACHINE_GRAPH_LOAD_ALLOWANCE_MS` sets the allowance, 5 minutes by default. See [Configuration](configuration.md#journey-execution).

The job graph, the operator uids, and the state layout do not change, so the state machine restores from a savepoint or checkpoint of the previous version. Only the state machine changes, so there is no deploy order. A trigger that the previous version left waiting for a missing node has no graph-load timer. It is dropped the next time a timer of the same journey fires, or it expires with the journey state. This is inferred from the code, not run.

### Notification request format

The outbox job changes the request it publishes on `journey-engine-outbound-noti`. The sender outside this repo reads that topic, so check it against this list before you deploy:

- `context` is now present. It is the transition's context as a JSON object, for example `{"event.name": "add_to_cart"}`. Before, the key was never written.
- `metadata` and `profile` no longer write null fields. A profile without an email has no `email` key. Before, it had `"email": null`.
- `profile` no longer has `loyalty_point_balance`, `loyalty_monetary_value`, or `loyalty_expired_at`. They were always null.
- A webhook request's `content` has `method`: `GET`, `POST`, `PUT`, `PATCH`, or `DELETE`. A node without a method sends `POST`. Other channels have no `method`.
- A webhook node saved with any other method no longer publishes. The outbox logs it and drops it.
- Profiles are cached for 5 minutes, so a profile change can reach a request up to 5 minutes late.

Deploy in this order:

1. Deploy a sender that accepts the new `context` object and `content.method`.
2. Deploy the outbox job.

The profile lookup is now an async operator with the id `outbox-profile-lookup`. The outbox's other operators have generated ids, and the new operator changes the job graph, so a savepoint taken before this change may not restore. Restore with `allowNonRestoredState: true` in the Flink operator's job spec, or pass `--allowNonRestoredState` to `flink run`. Prefer this. The timer flow's operator ids do not change, so its pending watches and their timers restore. Start without a savepoint only if the restore fails. That discards the timer flow's state, so every watch timer in flight is lost. Those watches complete only on `success`, when the person does the watched event. Their `timeout` branch never fires, and a delay never moves on. In both cases the CDC source may read a new snapshot and send old requests again ([OUT-NFR-01](../architecture/components/notification-outbox.md#non-functional-requirements)). The sender deduplicates on `execution_id`. This is inferred from the code, not run.

### Customer decision failed reads

A failed or timed-out `user_metrics` read in the customer decision job now fails the event, and the job restarts from its last checkpoint. Before, a failed read of a series counted as an empty series. The new occurrence then carried a higher behavior version than the stored row, so the profile writer replaced the stored series with that one occurrence. `USER_METRICS_READ_TIMEOUT`, default `5s`, bounds each read.

- The job graph, its state, and its messages do not change. Restore from a savepoint or checkpoint as usual. Only this job changes, so there is no deploy order.
- A Postgres outage, or `user_metrics` reads slower than the timeout, now restarts the decision job until the reads succeed. Triggers and mutations stop meanwhile, and the job catches up from Kafka after. Watch the job's restarts after the deploy. The jobs set no restart strategy, so the cluster's applies. A limit on restart attempts there can fail the job for good during a long outage.
- A restart replays events from the last checkpoint. Journey execution deduplicates triggers, and the profile writer ignores a mutation whose version is not above the stored row's.
- Series that a failed read replaced before this change stay replaced. Nothing stores the lost occurrences.

### Metric definition value types and modes

`studio` now writes `user_metric_definitions.value_type` from the attribute's catalog type, follows the [metric definition rules](../features/campaign-management.md#metric-definitions) in **Manage Properties**, and counts a segment node's metric as used. The schema does not change, and only `studio` changes, so there is no deploy order. Deploy `studio` after the profile writer from [Profile writer tolerant decoding](#profile-writer-tolerant-decoding), which stores a value of another type as null.

Definitions created before this change have `value_type` `PRESENCE`, so their attribute is never stored. The new code fixes a definition only when a publish rewrites it. To fix them all at once, list them first:

```sql
SELECT id, agg_operator, agg_field, processing_mode
FROM user_metric_definitions
WHERE value_type = 'PRESENCE' AND COALESCE(agg_field, '') <> '';
```

Then set each type from the catalog. An attribute matches a catalog path exactly, or else by its last segment, as in `studio`:

```sql
UPDATE user_metric_definitions AS d
SET value_type = CASE
      WHEN lower(f.data_type) IN ('number', 'integer', 'float', 'double', 'decimal', 'numeric') THEN 'NUMBER'
      WHEN lower(f.data_type) = 'boolean' THEN 'BOOLEAN'
      ELSE 'STRING'
    END,
    updated_at = CURRENT_TIMESTAMP
FROM user_metric_definitions AS m
LEFT JOIN LATERAL (
  SELECT data_type
  FROM user_event_fields
  WHERE user_event_id = m.user_event_id
    AND (field_path = m.agg_field
      OR regexp_replace(field_path, '^.*\.', '') = regexp_replace(m.agg_field, '^.*\.', ''))
  ORDER BY field_path = m.agg_field DESC
  LIMIT 1
) AS f ON TRUE
WHERE d.id = m.id
  AND d.value_type = 'PRESENCE'
  AND COALESCE(d.agg_field, '') <> '';
```

What the backfill changes for a metric that is already `LIVE`:

- Customer decision reads the new type through CDC. From the next event, each new occurrence stores the attribute's value. This is inferred from the code, not run.
- The series in state and in `user_metrics` keep their older occurrences, which have no value. So a series mixes those with typed values until they leave the retention period. `SUM`, `AVG`, `MIN`, `MAX`, and `LATEST` read a missing value as 0. `MEDIAN`, `DIFF`, and `PRICE_DROP` skip it. `DISTINCT_COUNT` ignores it. Until then, conditions on these functions can fire early or late.
- The profile writer stores the older occurrences as null in the new value column, so its writes keep working.
- A `NUMBER` metric now stores 1 when the event lacks the attribute, and a `BOOLEAN` metric stores `false`. [Missing metric values](#missing-metric-values) changes both to an occurrence with no value.

Other changes:

- A definition that **Manage Properties** created as `LIVE`, and that no active campaign uses, stays `LIVE` until the next publish, pause, resume, or delete of any campaign, or the next metric created in **Manage Properties**. Each of these sets every definition's mode.
- A metric used only by a segment node of an active campaign turns `LIVE` at that same point.
- **Manage Properties** now rejects an id that exists, a definition without a catalog event, a change to the event, function, or attribute of a metric that a campaign uses, and a delete of such a metric. Publish rejects a metric condition that asks for another function or attribute than a definition with that id that another campaign uses. The modal shows each refusal and keeps what was typed.

### Metric definition conditions

Customer decision reads `default_properties` and `filter_conditions` only as `{}` or a condition tree of `and`, `or`, and `comparison` nodes. Since PR #144, it loads a definition whose condition does not parse as disabled. Before this change, publish wrote the catalog's default values as a flat map such as `{"screen_location": "checkout"}`, and **Manage Properties** stored any JSON object. So every metric with such a condition has been disabled since #144. Its series have not changed, and conditions on it see stale values.

`studio` now writes a condition tree, and publish no longer rewrites the names or conditions of a definition that exists. Only `studio` changes, so there is no deploy order. Deploy it first, so that no new flat maps are written, then fix the stored rows.

List the definitions whose conditions the job cannot load. A flat map can have an attribute named `type`, so a row counts as a condition tree only when its `type` is `and`, `or`, or `comparison`:

```sql
SELECT id, processing_mode, default_properties, filter_conditions
FROM user_metric_definitions
WHERE jsonb_typeof(default_properties) NOT IN ('object', 'null')
   OR (jsonb_typeof(default_properties) = 'object'
     AND default_properties <> '{}'::jsonb
     AND COALESCE(default_properties->>'type', '') NOT IN ('and', 'or', 'comparison'))
   OR jsonb_typeof(filter_conditions) NOT IN ('object', 'null')
   OR (jsonb_typeof(filter_conditions) = 'object'
     AND filter_conditions <> '{}'::jsonb
     AND COALESCE(filter_conditions->>'type', '') NOT IN ('and', 'or', 'comparison'));
```

Convert each flat map whose values are all scalars into the condition that each key equals its value. Run it once for `default_properties` and once with `filter_conditions` in place of `default_properties`:

```sql
UPDATE user_metric_definitions
SET default_properties = jsonb_build_object(
      'type', 'and',
      'expressions', (
        SELECT jsonb_agg(jsonb_build_object('type', 'comparison', 'left', key, 'op', '=', 'right', value #>> '{}'))
        FROM jsonb_each(default_properties)
      )),
    updated_at = CURRENT_TIMESTAMP
WHERE jsonb_typeof(default_properties) = 'object'
  AND default_properties <> '{}'::jsonb
  AND COALESCE(default_properties->>'type', '') NOT IN ('and', 'or', 'comparison')
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_each(default_properties)
    WHERE jsonb_typeof(value) IN ('object', 'array', 'null')
  );
```

Publish wrote each key as the last segment of the attribute path, such as `channel` for `order.channel`. A converted key like that matches only a top-level attribute. Set the full path with SQL, or run the list query again and reset what is left. To set the full path, write the condition tree with each key as its full attribute path:

```sql
UPDATE user_metric_definitions
SET default_properties = '{"type":"and","expressions":[{"type":"comparison","left":"order.channel","op":"=","right":"web"}]}'::jsonb,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'm_example';
```

 A reset removes the condition, so the metric counts every event of its name:

```sql
UPDATE user_metric_definitions
SET default_properties = '{}'::jsonb, updated_at = CURRENT_TIMESTAMP
WHERE id = ANY('{m_example}'::text[]);
```

Customer decision reads each fixed row through CDC and enables the definition from the next event. Occurrences while it was disabled are not counted. This is inferred from the code, not run.

### Storefront tables removed

`studio` no longer reads, writes, or creates the `mailbox` and `event_logs` tables, and `schema.sql` no longer creates them. They held data from the removed storefront app. Only `studio` changes, so there is no deploy order.

An existing database keeps both tables. Nothing reads them, so you can drop them after the new `studio` is running:

```sql
DROP TABLE IF EXISTS mailbox;
DROP TABLE IF EXISTS event_logs;
```

Browsers may still hold a `session_id` cookie from the storefront. `studio` ignores it, and it expires within a week.

### Predicate evaluation

The customer decision job now evaluates event and profile conditions with one evaluator. Saved conditions can match differently after the deploy. The job graph, its state, and its messages do not change. Restore from a savepoint or checkpoint as usual. Only this job changes, so there is no deploy order.

`LIKE` now treats every character except `%` and `_` as itself. `IN` reads its list the same way on event and profile fields.

| In a `LIKE` pattern | Matches |
|---|---|
| `%` | Any run of characters, none included. Line breaks included. |
| `_` | Exactly one character |
| Any other character, such as `.`, `(`, `[`, `+`, `$`, or `\` | Itself |

There is no escape, so a pattern cannot match only a literal `%` or `_`. An `IN` list is split on commas. Every `(`, `)`, `'`, and `"` in the list is removed, and each item and the field value are trimmed. Then the value must equal an item. `%` and `_` in an item are plain characters.

| Condition | Before | Now |
|---|---|---|
| `add_to_cart LIKE add.to.cart` | Matched | Does not match. `.` is literal. |
| `iphone 15 pro LIKE iphone 15 (pro)` | Matched | Does not match |
| `c++ LIKE c++`, `$5 LIKE $5` | Did not match | Matches |
| `a(b LIKE %(b` | Threw, and the job restarted in a loop | Matches |
| Event `addXto_cart IN add_to_cart,purchase` | Matched | Does not match |
| Event `add_to_cart IN add_%` | Matched | Does not match |
| Profile `Da Nang IN (Hanoi, 'Da Nang')`, profile `" Hanoi" IN Hanoi` | Did not match | Matches |
| Profile `O'Brien IN O'Brien,Smith`, profile `(x) IN (x)` | Matched | Does not match. [Customer decision settings, mutations, and IN lists](#customer-decision-settings-mutations-and-in-lists) makes the first match again. |
| A comparison with a blank `left` or `op` | Threw when evaluated | The row fails to parse and is logged. |

A rule row that fails to parse leaves the decision job's rules, so its node never fires. The journey graph in the state machine still holds the node, so people who reach it wait there. A metric definition that fails to parse loads disabled and stops counting. A job that already holds such a row in its checkpoint evaluates the comparison as false.

Before the deploy, list the conditions that can change. The query needs Postgres 16 or later for `pg_input_is_valid`. On an older server, replace each `pg_input_is_valid(x, 'jsonb')` with `btrim(x) LIKE '{%'`.

```sql
WITH conditions AS (
    SELECT 'campaign_nodes.condition_json' AS source, campaign_id || ':' || node_id AS row_id,
           'event' AS kind, condition_json::jsonb AS doc
    FROM campaign_nodes WHERE pg_input_is_valid(condition_json, 'jsonb')
    UNION ALL
    SELECT 'campaign_nodes.profile_condition_json', campaign_id || ':' || node_id,
           'profile', profile_condition_json::jsonb
    FROM campaign_nodes WHERE pg_input_is_valid(profile_condition_json, 'jsonb')
    UNION ALL
    SELECT 'user_metric_definitions.default_properties', id, 'event', default_properties
    FROM user_metric_definitions
    UNION ALL
    SELECT 'user_metric_definitions.filter_conditions', id, 'event', filter_conditions
    FROM user_metric_definitions
),
comparisons AS (
    SELECT source, row_id, kind, c
    FROM conditions, jsonb_path_query(doc, 'strict $.** ? (@.type == "comparison")') AS c
),
found AS (
    SELECT source, row_id, c,
           CASE
               WHEN coalesce(btrim(c ->> 'left'), '') = '' OR coalesce(btrim(c ->> 'op'), '') = ''
                   THEN 'missing left or op'
               WHEN upper(c ->> 'op') = 'LIKE' AND c ->> 'right' ~ '[.()\[\]{}+*?^$|\\]'
                   THEN 'LIKE with a regex metacharacter'
               WHEN upper(c ->> 'op') = 'IN' AND kind = 'event' AND c ->> 'right' ~ '[%_]'
                   THEN 'event IN with % or _'
               WHEN upper(c ->> 'op') = 'IN' AND kind = 'profile' AND c ->> 'right' ~ '[''"()]'
                   THEN 'profile IN with a quote or a parenthesis'
           END AS reason
    FROM comparisons
)
SELECT f.source, f.row_id, cn.status, f.reason, f.c::text AS comparison
FROM found f
LEFT JOIN campaigns cn ON f.source LIKE 'campaign_nodes.%' AND cn.id = split_part(f.row_id, ':', 1)
WHERE f.reason IS NOT NULL
ORDER BY f.source, f.row_id;
```

`strict $.**` visits every level of the condition, so the query finds comparisons inside nested groups and inside the branches of a multi-branch check. A row with `condition_json` that is a bare event name holds no comparison and is skipped. The query cannot see a change that depends on the data, such as a profile value with a leading space.

For each row it returns:

1. Read the comparison and decide what the marketer meant.
2. Active and paused campaigns open read-only in `studio`. Clone the campaign, rewrite the condition in the copy, and activate the copy before the deploy. Then pause the original. A `user_metric_definitions` row belongs to the campaign whose metric condition created it, so fix it in that campaign.
3. Some conditions match more people after the deploy, such as `c++ LIKE c++` or a profile `IN` list with quotes. If a campaign must not reach those people, pause it before the deploy and resume it once its condition is rewritten.
4. A row with a missing `left` or `op` has likely kept the decision job restarting already, unless no event ever reached it. Rewrite it like the others.

This is inferred from the code and the unit tests. The query was not run against a database.

### Customer decision series lookup

A metric condition in the customer decision job now sees a series that state lacks. The asynchronous lookup that loads profiles also loads, from `user_metrics`, each series that a candidate rule references and state does not hold. So after a start without a savepoint, `INACTION(m_purchase_count) = 0` no longer passes for a person whose purchase is stored only in `user_metrics`. From this version on, a start without a savepoint does not need the campaign pause in [Customer decision metric snapshot](#customer-decision-metric-snapshot). The profile lookup also stops caching a failed lookup, and a lookup that found no profile. That change is in the shared profile repository, so the notification outbox gets it too.

- The job graph, the operator uids, and the ids the job carries from before the uids do not change. The lookup operator `profile-lookup` is renamed from `Async Profile Lookup` to `Async Profile and Series Lookup`, which changes the operator name in its metrics.
- The records the lookup holds in flight gained two fields. Restore from the last savepoint or checkpoint as usual, without `allowNonRestoredState`. Flink adds the fields to the restored records, and each restored record gets its profile looked up as before. A throwaway operator test restored a lookup snapshot from the previous version into this one, and one from this version into the previous one. A rollback restores without `allowNonRestoredState` too. The previous version drops the new fields, so an event that waited for a series sees it as empty.
- The Kafka messages and the schema do not change. There is no deploy order with other jobs. The outbox gets the profile cache change on its next deploy, with no change to its graph or state.
- Each subtask of the decision job opens a second pool of 5 Postgres connections for the series loads, on top of the 10 for profiles and the 5 for metric updates. The pools keep their connections open. Check `max_connections` against the job's parallelism before the deploy.
- Postgres gets one more read per person and series that a condition needs and state lacks, at most once per `USER_METRICS_CACHE_TTL_MINUTES` on each subtask while reads succeed. Right after a start without a savepoint, each active person with a metric condition pays it once per series. A profile lookup that finds no profile now reads `customer_profiles` on every candidate event that needs the profile, for example for visitors without a `user_id`. Watch the read rate on both tables after the deploy.
- A series load that fails or times out fails the event, and the job restarts from its last checkpoint, as [Customer decision failed reads](#customer-decision-failed-reads) describes for the other `user_metrics` reads. `CAMPAIGN_LOOKUP_TIMEOUT_MS` also bounds the load. Keep it above twice `USER_METRICS_READ_TIMEOUT`.
- A candidate that needs both a profile and a missing series fails the event when the lookup times out, even if the series load finished and only the profile lookup was slow.
- The series loads cannot pile up past the lookup timeout. A read fails after at most twice `USER_METRICS_READ_TIMEOUT`, 10 seconds by default. In 30 seconds, `CAMPAIGN_LOOKUP_TIMEOUT_MS`, each of the 5 threads finishes at least 3 such reads, one running and 2 waiting. So the pool queues at most 5 x (30 / 10 - 1) = 10 loads, and the queue length follows those two settings. When the 5 threads are busy and the queue is full, the subtask thread runs the next load itself. The subtask then takes no events until that read ends, at most 10 seconds, and Kafka lag grows instead of loads timing out. A load that still waited past the lookup timeout skips its query.
- The pool sustains 5 loads per average read time per subtask: about 33 loads a second at 150 ms, 250 at 20 ms. Right after a start without a savepoint, or after any restart, the cache is empty, and each active person with a metric condition needs one load per series. Above that rate the job slows down rather than restarting. Expect consumer lag on the decision job until the cache warms, and watch it after the deploy.
- The series cache holds up to `USER_METRICS_CACHE_MAX_ENTRIES` series per subtask, 5000 by default. One series can hold up to `max_retention_value` occurrences, 100 by default. Check the task manager heap if you raise the limit.

### Watch deadlines and timer state

Both the state machine and the outbox job change.

- The state machine ignores a `success` for a watch whose event time is after the watch's deadline. The watch completes on `timeout` when its timer fires. Before, whichever trigger arrived first completed it. The deadline uses the limit that the watch's parent listed when it completed, which is also the limit the timer fires at.
- The timer runs on processing time and fires when the wall clock reaches the deadline. A `success` with an event time just before the deadline that is still in the pipeline when the timeout arrives loses to the timeout. A `success` at exactly the deadline and the timeout go to whichever reaches the state machine first.
- Both jobs check a watch's time limit. The number must be above zero, and the unit must be seconds, minutes, hours, or days. A missing number is 15 and a missing unit is minutes, as before. Before, an invalid limit got a 15 minute timer without a log, a limit of zero or less fired at once, and a limit over about 24,855 days overflowed. Now the state machine logs `Ignoring watch node` and does not load the node, so the node gets no timer and triggers for it are dropped as unreachable. Studio's publish already rejects such limits, so only rows written before that check, or by hand, have them. Re-save such a campaign with a valid limit.
- The timer flow keeps its pending watches in a new state, `watch-timeouts`, with one entry per journey and watch node. A transition that the CDC source reads again replaces its watch instead of adding a second one, so a replay no longer sends a second timeout. Each entry is removed when its timer fires. The state has no TTL, so a watch or delay of any length still fires.

The job graphs and operator ids do not change. The outbox job's generated operator ids were computed from its stream graph before and after the change, and all 14 are equal. The outbox job keeps its watches in the `watch-timeouts` state.

The transition row and the trigger keep their format, so there is no deploy order.

### Durable CDC slots

The CDC sources for `campaigns`, `campaign_nodes`, and `user_campaign_state_transitions` now keep their replication slots when they close. The `user_metric_definitions` source already did. Every CDC source also sets the Debezium heartbeat to 30 seconds, down from the connector's default of 5 minutes. Before, Debezium dropped these slots whenever the source closed: on a stop, a cancel, or a task restart after a failure. The restored job then created a new slot at the current log position and skipped every change between its checkpoint and that moment. A node deleted while the state machine was down still completed, and a transition written while the outbox job was down never started its watch timer.

| Slot | Job |
|---|---|
| `flink_decision_campaigns_slot` | Customer decision |
| `flink_decision_campaign_nodes_slot` | Customer decision |
| `flink_state_machine_nodes_slot` | State machine |
| `flink_outbox_transitions_slot` | Outbox |

The slot names, job graphs, operator ids, state, and messages do not change. Restore each job from a savepoint as usual, without `allowNonRestoredState`. A connector option is not part of an operator id.

No SQL is needed to switch. The previous version drops each of these slots when its job stops, and the new version creates the slot again when it starts. Changes made between the two are skipped one last time. Deploy in this order so that the gap holds no changes:

1. Ask marketers not to save, publish, pause, or resume campaigns until step 6.
2. Stop the state machine with a savepoint: `flink stop --savepointPath <dir> <job id>`, or `job.state: suspended` on its `FlinkDeployment` with `upgradeMode: savepoint`. It writes no transitions while it is stopped. Customer decision keeps running, and its triggers wait in Kafka.
3. Wait a minute, so that the outbox reads the last transitions the state machine wrote. Then upgrade the outbox job from a savepoint.
4. Start the new state machine from the savepoint of step 2.
5. Upgrade customer decision from a savepoint.
6. Check that every slot exists and is in use, then lift the freeze of step 1.

```sql
SELECT slot_name, active
FROM pg_replication_slots
WHERE slot_name LIKE 'flink\_%';
```

Expect the four slots in the table and `flink_decision_metric_defs_slot`, each with `active` true.

After this change:

- A slot keeps Postgres from removing WAL until its job confirms it. A stopped job confirms nothing. Until the [CDC heartbeat table](#cdc-heartbeat-table) change, a running job confirmed a position only when its own table changed, because on Postgres 15 and later the heartbeat carried no newer position. The campaign and node slots could therefore hold WAL from busy tables for as long as no campaign changed. Watch the WAL each slot holds at all times, and on RDS alarm on `OldestReplicationSlotLag` and `FreeStorageSpace`:

	```sql
	SELECT slot_name, active,
		pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS held_wal
	FROM pg_replication_slots
	WHERE slot_name LIKE 'flink\_%';
	```

- A running job's slot holds on purpose the WAL of its last 10 checkpoints and of the one in progress. That is about 5 minutes, or 10 for the outbox job ([CDC restore window](#rolling-back-to-an-older-savepoint)). Keep `max_slot_wal_keep_size` well above that much WAL at the database's peak write rate, and set the `OldestReplicationSlotLag` alarm above the same amount. On the cluster of [the AWS free plan](aws-free-plan.md), a load run of 3,000 events per second wrote about 6 MB/s of WAL (#320). The outbox slot then holds 11 × 60 s × 6 MB/s, about 4 GB, and the other slots 11 × 30 s × 6 MB/s, about 2 GB. The cap is 8 GB, twice the outbox's hold. The WAL is shared, so all slots together hold at most 8 GB more than Postgres keeps anyway. If you change `CDC_CONFIRM_DELAY_CHECKPOINTS` or `CHECKPOINT_INTERVAL`, check the product against the cap again.
- That hold assumes checkpoints complete on schedule. The source counts only completed checkpoints, and it keeps the count in memory, so a restart after a failure starts at 0 and confirms nothing until 10 more checkpoints complete. A checkpoint that fails or expires does not count either. A job that restarts more often than every 10 checkpoints, or whose checkpoints keep failing, holds WAL like a stopped job, and at peak its slot passes the 8 GB cap in about 22 minutes. This is inferred from the connector's bytecode and from the recovery of PLT-KI-15, where an expired checkpoint restarted `event-parse-job`. It has not been run. Alert on job restarts and failed checkpoints as well as on the slots' `wal_status`.
- Postgres's volume is a directory on `data-1`'s 30 GB root disk, shared with Kafka, and neither claim's size is enforced. After one load run the disk had 15 GB used, Kafka's share 6.5 GB. With a full 8 GB of slot WAL that is 23 GB, about 77%. Kafka keeps 72 hours of data with no byte limit, so a second load run within 72 hours adds about another 6.5 GB, and with a full slot cap leaves about 0.5 GB free. That is an estimate from the measured numbers, not run. Until Kafka has a byte limit, leave 72 hours between load runs, or delete the load run's topics first.
- If `max_slot_wal_keep_size` is set and a slot passes it, Postgres invalidates the slot (`wal_status` is `lost`), and the job fails to stream from it. Suspend the job, drop the slot, and resume the job from its state. It creates a new slot at the current position, and the changes in between are skipped, as before this change. Read the job's checkpoint history before you suspend it. A job that waits for a lost slot can stop completing checkpoints, and then a stop with a savepoint times out and the Flink operator retries it without end. If the job's checkpoints fail or expire, suspend it with `upgradeMode: last-state`, which restores its last completed checkpoint. After the resume, write one row to `cdc_heartbeat` for one of the job's slots, because a source restored from state streams nothing until a change reaches its publication. The recovery for PLT-KI-15 ran these steps on 2026-11-08 and lists them in full.

	```sql
	SELECT pg_drop_replication_slot('flink_outbox_transitions_slot');
	```

- To remove a job for good, stop it and drop each of its slots the same way. Postgres refuses to drop a slot that a running job uses.
- Run one copy of each job per database. A second copy cannot take a slot that the first holds, and it fails on start after Debezium's retries.
- A job that starts without a savepoint or checkpoint still reads a snapshot of its tables. The slot does not change that. For the outbox, every past request goes out again and the sender deduplicates ([OUT-NFR-01](../architecture/components/notification-outbox.md#non-functional-requirements)).

To roll back, restore the previous version from a savepoint, in the same order. It finds each slot by name and uses it, and drops it again when it stops. This is inferred from the connector's code, not run.

#### Rolling back to an older savepoint

Each CDC source confirms to its slot the log position of the checkpoint `CDC_CONFIRM_DELAY_CHECKPOINTS` completed checkpoints back in its run, 10 by default. So the slot keeps the changes after the savepoint until a run of the job completes more than 10 checkpoints after it. A stop with a savepoint counts as a checkpoint. At the default checkpoint interval that is about 5 minutes, and 10 for the outbox job. The window is short so that a running slot stays under `max_slot_wal_keep_size` at peak writes ([decision 0039](../architecture/decisions/0039-shorten-the-cdc-restore-window.md)). This is the CDC restore window ([JEX-NFR-10](../architecture/components/journey-execution.md#non-functional-requirements)).

Within the window, restore the previous version from the savepoint taken before the deploy, as usual. The restored job reads every CDC change made since the savepoint, some of them for the second time, which every consumer tolerates ([decision 0006](../architecture/decisions/0006-at-least-once-delivery-with-idempotent-writes.md)). Nothing else is needed.

To check the window, read the completed checkpoints of each run of the new version, one run per Flink job id, before you stop it:

```bash
curl -s http://<jobmanager>:8081/jobs/<job id>/checkpoints | jq '.counts.completed'
```

A count of 9 or less in every run, with the default of 10, means the slot still holds every change after the savepoint, even after the run is stopped with a savepoint, which adds one. The count also includes the checkpoints of a run before it restarted after a failure, and savepoints that did not stop the job. Neither moves the slot, so they only make the check stricter. Past the window, the restored job resumes at the slot's newer position and skips the changes in between. For a rollback that may fall past the window:

- Freeze campaign edits from the moment you take a savepoint you may roll back to until the rollback is done. Then the rule tables have no changes to skip.
- Otherwise, apply the missed edits again after the restore. Re-save each campaign edited since the savepoint. Since [campaign saves as one change](#campaign-saves-as-one-change), the state machine replaces a campaign's whole graph on a save, so a node deleted since the savepoint leaves its restored graph too. Customer decision still applies each row on its own, and a save deletes only the rows that exist, so a node deleted since the savepoint stays in its restored rules. Remove it with an insert and a delete in one transaction, which sends both changes. The delete also takes the campaign's graph down in the state machine, so save the campaign again afterwards:

	```sql
	BEGIN;
	INSERT INTO campaign_nodes (campaign_id, node_id, node_type, campaign_node_count, graph_version)
	VALUES ('<campaign id>', '<node id>', '<node type>', 1, 0);
	DELETE FROM campaign_nodes WHERE campaign_id = '<campaign id>' AND node_id = '<node id>';
	COMMIT;
	```

- For the outbox job, transitions written after the savepoint up to the slot's position are skipped. Their requests were already published by the version you roll back from, but their watches get no timer in the restored job.

### Campaign saves as one change

A save reaches the state machine as one change. Studio writes `campaign_node_count`, the number of nodes in the save, on every `campaign_nodes` row. The state machine takes a campaign's graph down at the first delete row of a save, and puts it live again when all inserted rows of the save have arrived. See [decision 0013](../architecture/decisions/0013-apply-a-campaign-save-as-one-change.md).

Deploy in this order:

1. Add the column. The old studio leaves it null.

	```sql
	ALTER TABLE campaign_nodes ADD COLUMN campaign_node_count integer;
	```

2. Deploy studio.
3. Fill the column for the rows that exist, and make it required. The update sends one change per row, which the running state machine applies as before.

	```sql
	BEGIN;
	UPDATE campaign_nodes n
	SET campaign_node_count = c.node_count
	FROM (SELECT campaign_id, count(*)::integer AS node_count FROM campaign_nodes GROUP BY campaign_id) c
	WHERE n.campaign_id = c.campaign_id AND n.campaign_node_count IS NULL;
	ALTER TABLE campaign_nodes
		ALTER COLUMN campaign_node_count SET NOT NULL,
		ADD CONSTRAINT campaign_nodes_campaign_node_count_check CHECK (campaign_node_count > 0);
	COMMIT;
	```

4. Deploy the state machine. Take a savepoint and restore from it. The operator uids do not change. The state machine keeps its old state and adds a broadcast state, `campaign-graph-loads`, which starts empty. Its CDC source now reads one more column. That changes no operator id, so the source keeps its log position. This is inferred from how Flink assigns ids, not run. If the restore fails on the source, restore with `allowNonRestoredState`. The source then reads a new snapshot of `campaign_nodes`, which rebuilds the graphs. The state machine drops and logs a row without `campaign_node_count`, so do not deploy it before step 3.

Customer decision does not read the new column and needs no change.

After this change, a delete row outside a save, such as one run by hand, takes the campaign's graph down until the next save. Change node rows only through studio. An `UPDATE` of a row applies at once.

To roll back, take a savepoint of this version and restore the previous state machine from it with `allowNonRestoredState`, which drops `campaign-graph-loads`. A campaign whose save was in progress at the savepoint then has no graph until it is saved again. The column can stay. The previous studio does not write it, so drop the `NOT NULL` before you roll studio back: `ALTER TABLE campaign_nodes ALTER COLUMN campaign_node_count DROP NOT NULL;`.

### Event parser: GET hits and standard Base64

The event parse job's graph, state, and `snowplow-parsed` format do not change. Restore it from a savepoint as usual. The other jobs need no change, so there is no deploy order. Only events read after the deploy are affected. Hits dropped before it are not recovered.

Downstream behavior changes after the deploy:

- GET hits, such as a pixel or a tracker set to GET, used to be dropped. They now reach `snowplow-parsed`, so they update metrics and can move customers through journeys.
- An event whose `ue_px` or `cx` used the standard Base64 alphabet (`+` and `/`) was published with `event_name` set to the raw type, `ue`, and a null `event_json`. It now gets its schema's event name and its data. Rules and metrics on that name start to count it, and anything that matched `ue` stops.
- For those events, `domain_userid` moves from `duid` to the `userId` of the `client_session` context in `cx`. Identity stitching can then give the customer a new `canon_id`. Metrics recorded under the old `canon_id` stay there, so that customer's metric history splits. This is inferred from the code, not run.

Find the affected trackers before the deploy:

- GET traffic: count GET requests to the collector in the ingress or load balancer access log. Look for the pixel path `/i` and for GET on `/com.snowplowanalytics.snowplow/tp2`. A web tracker configured with `eventMethod: 'get'` sends GET.
- Standard Base64: events that were published as `ue` show the problem. On POST hits, look for `+` or `/` in the raw `ue_px` and `cx` values on `snowplow-good`. Thrift stores the JSON body as plain bytes, so a text search works:

  ```bash
  rpk topic consume snowplow-parsed -o start --num 10000 -f '%v\n' | grep -c '"event_name":"ue"'
  rpk topic consume snowplow-good -o start --num 10000 -f '%v\n' | grep -aEo '"(ue_px|cx)":"[^"]*[+/][^"]*"' | head
  ```

  The `app_id` and `platform` of the `ue` events name the trackers. These commands were not run.

What to expect after the deploy:

- Metric counts rise for the event names that affected trackers send.
- Customers can enter journeys on events that were dropped or misnamed before. Only new events count, so there is no burst from old traffic.
- The TaskManager log shows a WARN line for each payload or `ue_px`, `ue_pr`, `cx`, or `co` field that still does not decode. The line names the field and the exception class, never the content.
- A customer with a new `canon_id` starts its metrics from zero under that id.

If the affected traffic is large, warn the marketers who own campaigns on those event names before the deploy. Pause a campaign whose entry would send unwanted notifications, or set its metric definitions to `PAUSED`, then resume after you check the new counts.

### Customer decision rule index

Candidate selection in the customer decision job now reads only the rules that can fire on an event, through an index by event name and by metric id. It no longer scans every rule and every campaign on each event. The evaluation step reuses the branches that selection matched, instead of evaluating each candidate's event condition a second time. Which rules fire does not change.

- The job graph, the operator uids, and the ids the job carries from before the uids do not change. The Kafka messages and the schema do not change. There is no deploy order with other jobs.
- The broadcast state of campaigns and rules does not change. Each subtask of `filter-lookup-candidates` builds the index in memory from that state on its first event after a start or restore, and keeps it in step with each rule and campaign change after that.
- The records that `profile-lookup` holds in flight gained one field, the branches each rule matched. Restore from the last savepoint or checkpoint as usual, without `allowNonRestoredState`. A restored record has no branches, so the evaluation step evaluates its rules' event conditions, as before. A test restores a lookup snapshot taken with the previous version. A rollback also restores without `allowNonRestoredState`: a throwaway operator test restored a snapshot from this version into the previous one, which drops the field. Both restores ran in the test harness on the heap backend, not on the cluster.
- A rule that changes while an event is between selection and evaluation now fires with the branches that selection matched against the rule before the change. Before, evaluation used the changed event condition. The change applies from the next event, as before.
- A rule whose event condition does not limit the event name, for example one on `page.url` alone, is still checked on every event.
- An `and` or `or` without `expressions` now fails to parse, in any condition of a rule or a metric definition. The job skips and logs such a rule, and disables and logs such a metric definition. Before, a metric condition with such a group could fail the events of an active campaign and restart the job, and with the index it would fail every event. Studio always writes `expressions`, so only rows written by hand or by other tools are affected. A rule already in the restored broadcast state reads such a group as empty until its row changes: an empty `and` passes and an empty `or` fails. To find such rows before the deploy (not run):

  ```sql
  SELECT n.campaign_id, n.node_id
  FROM campaign_nodes n
  CROSS JOIN LATERAL (VALUES (n.condition_json), (n.profile_condition_json), (n.aggregation_json)) AS c(json)
  WHERE jsonb_path_exists(
    CASE WHEN ltrim(c.json) LIKE '{%' THEN c.json::jsonb END,
    'lax $.** ? ((@.type == "and" || @.type == "or") && !(exists(@.expressions)))');

  SELECT id
  FROM user_metric_definitions
  WHERE jsonb_path_exists(default_properties,
      'lax $.** ? ((@.type == "and" || @.type == "or") && !(exists(@.expressions)))')
    OR jsonb_path_exists(filter_conditions,
      'lax $.** ? ((@.type == "and" || @.type == "or") && !(exists(@.expressions)))');
  ```

  Add `"expressions": []` to each group the queries find.

### Identity stitcher state format

The stitcher now writes its keyed state in a format of its own instead of Kryo. Each value carries a format version, so a later change to the stitcher's structure can still read the state written before it. Only the event parse job changes, so there is no deploy order.

- Restore from a savepoint or checkpoint taken before this change. The operator id, `identity-stitcher`, and the state name do not change, so `allowNonRestoredState` is not needed. On restore, Flink reads the old values with Kryo once and writes them in the new format. On RocksDB it rewrites every key of a subtask while the stitcher opens, so the first start takes longer the more devices the state holds. The operator test harness restored state written the old way on RocksDB and on heap, and then restored again with Kryo turned off. This was not run on a cluster.
- If the restore fails, start without the savepoint. The stitcher then rebuilds from `identity_graph`, as the [identity graph sink](#identity-graph-sink) note describes.
- The previous version cannot read state written by this one. This is inferred from the code. To roll back, start the previous JAR from the savepoint taken before this deploy, or without state.
- Keep a savepoint or checkpoint taken after this deploy. A later version may stop reading the Kryo format.

### Event parser: placeholder ids and drop counts

The event parse job's graph, state layout, and `snowplow-parsed` format do not change. Restore it from a savepoint as usual. The other jobs need no change, so there is no deploy order. This is inferred from the code, not run.

Placeholder ids. The parser now treats `user_id`, `domain_userid`, and `network_userid` as absent when they equal `unknown`, `undefined`, or `null`, after trimming and ignoring case. `EVENT_PARSE_PLACEHOLDER_IDS` changes the list. Before, only `undefined` was absent, so every device that sent `uid=unknown` or `uid=null` stitched into one set and shared one `canon_id`.

- A device seen for the first time after the deploy gets its own `canon_id`.
- A device already stitched through a placeholder keeps the shared `canon_id`. Its stitcher state still holds the set, and the state's TTL resets on each event. Without that state, the stitcher reads the device's `identity_graph` row, which still has the shared `canon_id`. The upsert keeps the stored `user_id` when an event has none, so the row keeps `user_id = 'unknown'`.
- When a merged device later logs in for real, the upsert replaces its `user_id` but writes the set's `canon_id`, which is still the shared one. So some merged rows no longer show the placeholder.
- So the change stops new merges but does not split old ones. Metrics and journey state under the shared `canon_id` stay there. This is inferred from the code, not run.

Find the affected rows. Use your configured list in place of the default:

```sql
-- Rows whose own id is a placeholder.
SELECT domain_userid, user_id, canon_id
FROM identity_graph
WHERE lower(btrim(user_id)) IN ('unknown', 'undefined', 'null')
   OR lower(btrim(domain_userid)) IN ('unknown', 'undefined', 'null');

-- Every device under a canon_id that a placeholder merged, largest first.
-- A device that has since logged in no longer shows the placeholder, so
-- count all rows under the canon_id, not only the placeholder rows.
SELECT canon_id, count(*) AS devices
FROM identity_graph
WHERE canon_id IN (
    SELECT canon_id
    FROM identity_graph
    WHERE lower(btrim(user_id)) IN ('unknown', 'undefined', 'null')
)
   -- The stitcher's derived canon_id for the placeholders unknown, undefined, null.
   OR canon_id IN ('3c0c6246-a80e-37fe-9003-6cfecef03caa',
                   '62feb3d7-2f36-3264-985d-56125c070a9f',
                   'e611a687-df8d-30b7-89ed-74d0796c1b04')
GROUP BY canon_id
ORDER BY devices DESC;
```

The fixed ids are `UUID.nameUUIDFromBytes("canon:" + value)`, the `canon_id` the stitcher derives when a placeholder `user_id` is the root of a set. They find a merged set whose rows have all lost the placeholder. For a custom list, derive them the same way.

A `canon_id` with many devices is one merged "person". Its `user_metrics` rows and journey state mix many visitors. This change does not repair them, and splitting them is a separate decision. These queries were not run.

Drop counts. The parser now counts each payload and event it drops in the operator counter `droppedEvents`, with a `reason` variable: `payload_not_decoded`, `event_not_decoded`, `invalid_event_id`, or `no_timestamp`. The repo configures no metrics reporter, so the counts show in the Flink web UI until one is set. The Prometheus reporter turns `reason` into a label.

Each subtask logs the first drop of each reason at WARN, then at most one line per reason per minute, with the number dropped since its last line for that reason. A line names the exception class or the field, never the content. Before, a payload that did not decode logged one line each, and a bad `eid` or a missing timestamp logged nothing. Expect `invalid_event_id` and `no_timestamp` lines that were not there before.

### Identity lookups on the primary

The stitcher's `identity_graph` lookups now connect to `DB_HOST` instead of `DB_READ_HOST`. The event parse job no longer reads `DB_READ_HOST`. Each stitcher subtask moves its one lookup connection from the replica to the primary, so the primary needs one more connection per subtask. The job already writes `identity_graph` through `DB_HOST`, so its user needs no new grant.

The job graph, the operator ids, and the state do not change. Restore from the last savepoint or checkpoint as usual. Only this job changes, so there is no deploy order.

### Identity stitcher: events without a device

An event with a `user_id` and no `domain_userid` no longer keeps stitcher state. It reads `identity_graph` for its `user_id` on every event and takes the `canon_id` of the user's newest row. See [decision 0012](../architecture/decisions/0012-resolve-events-without-a-device-from-the-durable-copy.md). Only the event parse job changes, so there is no deploy order.

- The job graph, the key, the operator ids, and the state name and format do not change. Restore from the last savepoint or checkpoint as usual. `allowNonRestoredState` is not needed. This is inferred from the code, not run.
- State stored under a user's key before this change is no longer read or written. It expires through its 7-day TTL. Until then it takes space in the stitcher's state.
- The first event without a device after the deploy can publish a different `canon_id` than the one before it, when a device merged the user while the old state held the earlier one. Metrics and journey state under the old `canon_id` stay there, as for any merge.
- Expect one read of the primary per event without a `domain_userid`, on the stitcher's one lookup connection per subtask. Before the deploy, sample `snowplow-parsed` for records with `user_id` set and `domain_userid` null to size that load.

### Events without any identifier

An event with neither `domain_userid` nor `user_id` now skips the identity stitcher. Before, the event parse job keyed every such event under one literal placeholder string, so they all went to one stitcher subtask. Their `canon_id` stays null, as before, and `snowplow-parsed` still gets them with a null key. Customer decision drops them, as before, because it accepts only events with a `canon_id`.

A journey trigger now carries the event's `event_name` unchanged. Before, customer decision replaced a blank `event_name` with a placeholder string. Only events with a blank `event_name` that fire a rule are affected.

Deploy order: the two jobs are independent. Deploy either one first.

Event parse job:

- The graph gains two filter operators before the stitcher, with uids `events-with-identifier` and `events-without-identifier`. They keep no state. The uids `identity-stitcher` and `postgres-identity-graph-sink`, the stitcher's state name, and the operator id of the Kafka source do not change, so the source offsets and the stitcher state restore. A throwaway test compared the operator ids of the old and the new graph.
- The operator ids of the `snowplow-parsed` Kafka sink writer and committer change, because the planner gives them no uid. Restore from a savepoint with `--allowNonRestoredState` so Flink drops their old state. The sink is at-least-once, and its writer snapshots no state, so nothing is lost. This is inferred from the connector code, not run.
- No event reaches the placeholder key any more. The current stitcher keeps no state for an event without a `domain_userid`, so the key should hold none. Any state an older version wrote under it is never read again and expires through its 7-day TTL.
- To roll back, start the previous JAR from the savepoint taken before this deploy. A savepoint taken after this deploy also restores into the previous JAR with `--allowNonRestoredState`, which drops the new sink state and the two filters, which keep no state.

Customer decision: the graph, the uids, and the state do not change. Restore from the last savepoint or checkpoint as usual.

### Condition operators, thresholds, and windows

Customer decision now checks more of each condition when it loads a `campaign_nodes` or `user_metric_definitions` row.

- A metric comparison needs a metric id in `left` and an operator of `>`, `>=`, `<`, `<=`, `=`, or `!=`. `==` still means `=`, and a missing operator still means `>=`. Its `right` must be a finite number, and its window, if it has one, must have a value above 0. Before, a threshold that was not a number, such as `three`, `3,5`, or an empty string, read as 0, so `COUNT >= three` fired for every person. Any other operator, such as `LIKE`, read as `>=`. A window of 0 or less counted all history.
- An event or profile comparison needs an operator from the [predicate language](../architecture/components/customer-decision.md#condition-language), in any case. Before, another operator such as `CONTAINS` loaded and evaluated as false.
- A metric definition needs a value type of `PRESENCE`, `NUMBER`, `STRING`, or `BOOLEAN`, in any case. The column's check already allows only these.

The job skips and logs a rule row that fails, and loads a metric definition that fails as disabled, as it does for other parse failures. In this version a window with an unknown unit, such as `WEEKS`, still loads and counts all history. [Metric window units and truncated series](#metric-window-units-and-truncated-series) fixes that.

`studio` now refuses to publish or resume a journey with such a comparison, and names the comparison in the error. The builder wrote one only when a marketer cleared a metric threshold, which saved an empty string.

Restore and deploy order:

- The job graph, the operator uids, the state layout, and the Kafka messages do not change. Restore from a savepoint or checkpoint as usual. A test restores the decision operator's broadcast state from a snapshot taken with the previous version, on the heap backend in the test harness.
- The job does not parse a rule in the restored broadcast state again until its row changes. If its metric condition fails the new checks, the evaluation step logs it once per subtask after each start, and the rule fires for no one. An event or profile comparison with an unknown operator keeps evaluating as false. A start without a savepoint reads every row again and skips such rules.
- The profile writer now reads value types through the same list as customer decision. Its behavior does not change.
- There is no deploy order. Deploy `studio` and the decision job in either order.

Before the deploy, list the comparisons that the job will reject (not run). A threshold with an exponent above 308, such as `1e400`, passes the query but fails to load. A threshold such as `3d` or `0x1p3` is listed but loads. The query skips a `campaign_nodes` column that is not valid JSON. The job already fails to load such a row.

The query needs Postgres 16 or later for `pg_input_is_valid`. On an older server, first create this function, then replace each `pg_input_is_valid(x, 'jsonb')` with `pg_temp.is_jsonb(x)`:

```sql
CREATE FUNCTION pg_temp.is_jsonb(text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
    PERFORM $1::jsonb;
    RETURN $1 IS NOT NULL;
EXCEPTION WHEN others THEN
    RETURN false;
END $$;
```

```sql
WITH conditions AS (
    SELECT 'campaign_nodes.aggregation_json' AS source, campaign_id || ':' || node_id AS row_id,
           'metric' AS kind, aggregation_json::jsonb AS doc
    FROM campaign_nodes WHERE pg_input_is_valid(aggregation_json, 'jsonb')
    UNION ALL
    SELECT 'campaign_nodes.condition_json', campaign_id || ':' || node_id, 'field', condition_json::jsonb
    FROM campaign_nodes WHERE pg_input_is_valid(condition_json, 'jsonb')
    UNION ALL
    SELECT 'campaign_nodes.profile_condition_json', campaign_id || ':' || node_id, 'field',
           profile_condition_json::jsonb
    FROM campaign_nodes WHERE pg_input_is_valid(profile_condition_json, 'jsonb')
    UNION ALL
    SELECT 'user_metric_definitions.default_properties', id, 'field', default_properties
    FROM user_metric_definitions
    UNION ALL
    SELECT 'user_metric_definitions.filter_conditions', id, 'field', filter_conditions
    FROM user_metric_definitions
),
comparisons AS (
    SELECT source, row_id, kind, c
    FROM conditions, jsonb_path_query(doc, 'strict $.** ? (@.type == "comparison")') AS c
),
found AS (
    SELECT source, row_id, c,
           CASE
               WHEN kind = 'field' AND coalesce(btrim(c ->> 'op'), '') <> ''
                    AND upper(c ->> 'op') NOT IN ('=', '!=', '>', '>=', '<', '<=', 'LIKE', 'IN')
                   THEN 'unknown operator'
               WHEN kind = 'metric' AND coalesce(btrim(c ->> 'left'), '') = ''
                   THEN 'no metric id'
               WHEN kind = 'metric' AND coalesce(btrim(c ->> 'op'), '') <> ''
                    AND c ->> 'op' NOT IN ('>', '>=', '<', '<=', '=', '==', '!=')
                   THEN 'unknown metric operator'
               WHEN kind = 'metric'
                    AND NOT coalesce(btrim(c ->> 'right') ~ '^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$', false)
                   THEN 'threshold is not a number'
               WHEN kind = 'metric' AND jsonb_typeof(c -> 'window') = 'object'
                    AND CASE jsonb_typeof(c -> 'window' -> 'value')
                            WHEN 'number' THEN trunc((c -> 'window' ->> 'value')::numeric) <= 0
                            ELSE true
                        END
                   THEN 'window is not above 0'
           END AS reason
    FROM comparisons
)
SELECT f.source, f.row_id, cn.status, f.reason, f.c::text AS comparison
FROM found f
LEFT JOIN campaigns cn ON f.source LIKE 'campaign_nodes.%' AND cn.id = split_part(f.row_id, ':', 1)
WHERE f.reason IS NOT NULL
ORDER BY f.source, f.row_id;
```

For each row it returns:

1. Until the deploy, a metric threshold that is not a number reads as 0, so a condition such as `COUNT >= three` fires for every person. Pause such a campaign now if that matters.
2. Active and paused campaigns open read-only in `studio`, and resume now refuses a journey with such a comparison. Clone the campaign, fix the condition in the copy, and activate the copy. Then delete the original or leave it paused.
3. A `user_metric_definitions` row belongs to the campaign whose metric condition created it. Publish never writes an unknown operator, so such a row came from another tool. Fix its condition with SQL, as in the `UPDATE user_metric_definitions` step above, or delete the row and publish the campaign again. Publish derives the definition again from the campaign's behavior condition.

### Metric window units and truncated series

Two changes to how customer decision evaluates metric conditions. Both are in the [metric functions](../architecture/components/customer-decision.md#metric-functions) of the contract.

Window units:

- A metric window's unit must be `SECONDS`, `MINUTES`, `HOURS`, `DAYS`, `WEEKS`, or `MONTHS`, in upper case. A week is 7 days and a month is 30 days.
- Before, `WEEKS` and `MONTHS` read as no window, so the condition counted all history. A window of 2 `WEEKS` now counts 14 days. A `COUNT >=` rule on such a window passes for fewer people, and an `INACTION = 0` or `COUNT <` rule passes for people who acted only before the window.
- Before, the job also read `S`, `M`, `H`, `D`, the singular names, and any case. `M` meant minutes. Any other unit, or a window without a unit, read as no window. Now each of these fails to parse. The job skips and logs the rule row, and the rule fires for no one. `studio` refuses to publish or resume a journey with such a window and names the comparison. `studio` writes only `MINUTES`, `HOURS`, `DAYS`, `WEEKS`, and `MONTHS`, so a rejected row came from a manual edit or another tool.

Truncated series:

- A series that reached its cap is truncated. Before, every comparison on a truncated series failed.
- Now `COUNT` and `INACTION` read the stored number of occurrences as a lower bound. `>=` and `>` pass when the stored number passes them, and `!=` passes when the stored number is above the threshold. `<`, `<=`, and `=` still never pass. Every other function, such as `SUM`, `AVG`, or `LATEST`, uses the stored occurrences.
- Nothing is backfilled. A rule on a truncated series starts to pass at the person's next event that makes the rule a candidate. A rule whose only condition is a metric condition is a candidate when one of its metrics changes. So a person whose series is truncated can enter a journey on their next counted event, and a journey with such a rule can see more entries right after the deploy.

Restore and deploy order:

- The job graph, the operator uids, the state layout, and the Kafka messages do not change. Restore from a savepoint or checkpoint as usual. Broadcast state keeps each rule's condition as it was read, window unit included, and the job parses it once per rule on the first evaluation after a start. A test restores the decision operator's broadcast state from a snapshot taken before typed metric conditions, with `DAYS` windows, and its rules evaluate.
- A restored rule whose window unit fails the new check logs once per subtask after each start and fires for no one. This is inferred from the same parse path that the restore test covers for a bad threshold, not run with a bad unit.
- There is no deploy order. Deploy `studio` and the decision job in either order.

Before the deploy, run this query (not run). It lists each metric window in the node rows and in the stored journeys that the job or `studio` will now reject, and each `WEEKS` or `MONTHS` window whose meaning changes. It needs Postgres 16 or later for `pg_input_is_valid`. On an older server, use the `pg_temp.is_jsonb` function from [Condition operators, thresholds, and windows](#condition-operators-thresholds-and-windows).

```sql
WITH conditions AS (
    SELECT 'campaign_nodes.aggregation_json' AS source, campaign_id, node_id AS row_id,
           aggregation_json::jsonb AS doc
    FROM campaign_nodes WHERE pg_input_is_valid(aggregation_json, 'jsonb')
    UNION ALL
    SELECT 'campaigns.root', c.id, NULL, n -> 'metricsCondition'
    FROM campaigns c, jsonb_path_query(c.root, 'strict $.** ? (@.metricsCondition.type() == "object")') AS n
),
windows AS (
    SELECT source, campaign_id, row_id, c -> 'window' AS w
    FROM conditions, jsonb_path_query(doc, 'strict $.** ? (@.type == "comparison")') AS c
    WHERE jsonb_typeof(c -> 'window') = 'object'
)
SELECT w.source, w.campaign_id, w.row_id, ca.status, w.w::text AS window,
       CASE WHEN coalesce(w.w ->> 'unit', '') IN ('WEEKS', 'MONTHS') THEN 'now counts only the window'
            ELSE 'rejected' END AS change
FROM windows w
JOIN campaigns ca ON ca.id = w.campaign_id
WHERE coalesce(w.w ->> 'unit', '') NOT IN ('SECONDS', 'MINUTES', 'HOURS', 'DAYS')
ORDER BY change, w.campaign_id, w.row_id;
```

For each `rejected` row in an active or paused campaign, clone the campaign, set the window in the copy, and activate the copy. Then delete the original or leave it paused. For each `now counts only the window` row, check that the campaign's audience after the deploy is what its marketer meant.

To see how many series are truncated today, and so which metrics' rules start to pass, run this (not run). `user_metrics` can lag the job's state by the profile writer's delay:

```sql
SELECT metric_id, count(*) AS truncated_series
FROM user_metrics
WHERE truncated
GROUP BY metric_id
ORDER BY truncated_series DESC;
```

A rollback to the previous version needs no state step. It reads `WEEKS` and `MONTHS` as all history again, fails every comparison on a truncated series again, and loads rows with unknown units again.

### Segment nodes as metric conditions

A segment node is now a check on metrics only, as the [journey builder](../features/journey-builder.md#node-types) describes. `studio` saves its property, operator, and value as a metric condition in `aggregation_json`, and leaves `condition_json` empty. The customer decision job loads segment rows and fires `yes` when an event changes one of the segment's metrics and the condition holds. Before, `studio` saved only `{"property_key": ...}` in `condition_json`, the job skipped segment rows, and a journey stopped at every segment.

Deploy in this order:

1. Deploy the customer decision job. The job graph, the operator uids, and the state layout do not change: the broadcast state holds the same rule type, which now can be a segment. Restore from a savepoint as usual, without `allowNonRestoredState`. A rollback restores the same way. The previous version keeps a restored segment rule but emits no branch for it. This is inferred from the code, not run.
2. Deploy `studio`.

The job reads a `campaign_nodes` row again only when the row changes, or on a start without a savepoint. The old job drops a segment row when it reads one. So if `studio` goes first, a segment published before the new job runs stays unknown to it. Pause and resume each such campaign after step 1.

The state machine and the outbox do not change. They need no redeploy.

Segments saved before this change lost their operator and value, so they cannot be repaired automatically. List them before the deploy (not run):

```sql
SELECT c.id AS campaign_id, c.name, c.status, n.node_id, n.condition_json
FROM campaign_nodes n
JOIN campaigns c ON c.id = n.campaign_id
WHERE n.node_type = 'segment'
  AND n.aggregation_json IS NULL
ORDER BY c.id, n.node_id;
```

`condition_json` shows the property each one used. After the deploy:

- The new job logs `Ignoring invalid campaign node` for such a row when it reads it, and skips it. A journey still stops there, as before.
- Resume refuses a campaign that has such a segment. Its stored journey has no metric condition for it, and the error names the segment's place in the tree.
- A metric that only such a row used turns `PAUSED` at the next publish, pause, resume, or delete of any campaign.
- A draft in a browser that has such a segment opens with no property set, and publish refuses it until the marketer picks one.

For each campaign the query lists:

1. Open it and click **Clone to Edit**. The clone is a draft with a new campaign id.
2. Open each segment of the clone and set its property, operator, and value again. The query shows the property. Ask the marketer who built it for the operator and value.
3. Publish the clone.
4. Pause or delete the old campaign.

People who were waiting at the old segment do not move to the clone. The clone starts them again from its setup node.

### Publish keeps metric functions and ids

Before this change, publish had two defects in the metric conditions it wrote:

- It wrote `COUNT` for a comparison that asked for `LATEST`, `PRICE_DROP`, or `DIFF`, in the node row and in the metric definition.
- It replaced a metric id that does not start with `m_` with an id made from the event, the function, and the attribute, and created that definition if it was missing.

The stored tree in `campaigns.root` kept what the marketer asked for, and only `studio` changes, so there is no deploy order and no schema change. The bad node rows and definitions stay until each campaign publishes again.

Before the deploy, list the comparisons in stored trees that were hit. Run it as a read:

```sql
SELECT c.id AS campaign_id, c.status,
       COALESCE(m->>'user_event_id', m->>'event_id') AS user_event_id,
       e->>'left' AS metric_id,
       upper(e->>'function') AS function,
       e->>'field' AS field,
       CASE WHEN upper(e->>'function') IN ('LATEST', 'PRICE_DROP', 'DIFF')
            THEN 'function' ELSE 'id' END AS defect
FROM campaigns c
CROSS JOIN LATERAL jsonb_path_query(c.root, 'strict $.**.metricsCondition') AS m
CROSS JOIN LATERAL jsonb_path_query(m, 'strict $.** ? (@.type == "comparison")') AS e
WHERE upper(e->>'function') IN ('LATEST', 'PRICE_DROP', 'DIFF')
   OR (e->>'left' NOT LIKE 'm\_%' AND EXISTS (
         SELECT 1 FROM user_metric_definitions d
         WHERE d.id = e->>'left'
           AND d.user_event_id = COALESCE(m->>'user_event_id', m->>'event_id')))
ORDER BY c.id;
```

A `function` row means the campaign's node row computes `COUNT`, and the definition `metric_id` may now say `COUNT`. An `id` row means the node row reads a generated metric, which has no history from before its campaign was published. The query was not run against a live database.

After the deploy, repair each campaign the query lists:

1. For a `function` row, check that every campaign that references `metric_id` asks for the same function in its stored tree, and then set it back on the definition. The decision job applies the function from the node row, and the series it keeps does not depend on the definition's function, so no history is lost.

   ```sql
   UPDATE user_metric_definitions
   SET agg_operator = '<function from the query>', updated_at = CURRENT_TIMESTAMP
   WHERE id = '<metric_id>';
   ```

   Skip this step when those campaigns ask for different functions. One definition cannot serve both, and publish refuses the second. Ask the owners which one keeps the metric, and point the other campaign at a new metric.
2. For an active campaign, pause it and resume it in the list. Resume rebuilds the node rows from the stored tree, with the function and the metric id it asks for. A paused campaign is rebuilt the same way when it is next resumed.
3. While the campaign is paused, its metrics that no other active campaign uses turn `PAUSED` and miss the events in between. Resume right after the pause.
4. An `id` row leaves a generated definition behind, such as `m_purchase_count`. It turns `PAUSED` once no active campaign uses it. When no campaign references it, delete it with SQL. The foreign key removes its `user_metrics` rows too:

   ```sql
   DELETE FROM user_metric_definitions WHERE id = '<metric_id>';
   ```

   The metric made by hand was `PAUSED` while no active campaign named it, so it has no occurrences from that time.

### Event schema gate

Each catalog event gets a schema gate, off by default, and each attribute a Required flag, off by default. While an event's gate is on, the event parse job drops each event of that name that misses a required attribute or has a value of the wrong type, and counts it under the drop reason `schema_invalid`. See [decision 0014](../architecture/decisions/0014-gate-events-on-their-catalog-schema-at-ingestion.md). With every gate off, which is the state after the upgrade, every event flows as before.

Deploy in this order:

1. Change the database. Both columns have a constant default, so on Postgres 11 or later the `ALTER`s do not rewrite the tables. The old studio does not read them.

	```sql
	ALTER TABLE user_events ADD COLUMN IF NOT EXISTS enforce_schema boolean NOT NULL DEFAULT false;
	ALTER TABLE user_event_fields ADD COLUMN IF NOT EXISTS required boolean NOT NULL DEFAULT false;
	ALTER TABLE user_events REPLICA IDENTITY FULL;
	ALTER TABLE user_event_fields REPLICA IDENTITY FULL;
	CREATE PUBLICATION user_events_pub FOR TABLE user_events, cdc_heartbeat;
	CREATE PUBLICATION user_event_fields_pub FOR TABLE user_event_fields, cdc_heartbeat;
	```

	The publications include `cdc_heartbeat`, so this needs the [CDC heartbeat table](#cdc-heartbeat-table) first. Each catalog source upserts its slot's row there on every heartbeat, which keeps a quiet catalog slot from holding WAL.

	The event parse job reads the catalog as the `DB_USER` it already uses for `identity_graph`. If that user is not the one the other CDC jobs use, grant it what they have: the `REPLICATION` attribute, `SELECT` on both tables, and `SELECT, INSERT, UPDATE` on `cdc_heartbeat`.

2. Deploy studio. The event list gains a Schema gate switch per event, and the attribute list a Required box.
3. Deploy the event parse job. Take a savepoint, and restore from it with `allowNonRestoredState`:
	- The job gained two CDC sources, `catalog-events-source` and `catalog-attributes-source`, and the operator `catalog-schema-gate` between the parser and the identity stitcher. They start without state. Each source creates its slot, `flink_event_parse_catalog_events_slot` or `flink_event_parse_catalog_fields_slot`, and reads a snapshot of its table.
	- The Kafka source now has the uid `snowplow-good-source` and carries the id it had before, `cbc357ccb763df2852fee8c4fc7d55f2`, so it keeps its offsets. `EventParseJobGraphTest` checks the id at parallelism 1, 2, and 8.
	- `identity-stitcher` and `postgres-identity-graph-sink` keep their uids and state.
	- The planner builds the Kafka sink of `snowplow-parsed` and gives it no uid. Its operator ids changed with the graph, so the savepoint's entries for its writer and committer match nothing. That is why the restore needs `allowNonRestoredState`. The sink is at least once, its writer saves no records, and it flushes at each checkpoint, so nothing is lost. This is inferred from the connector code, not run on a cluster.
	- Events read before the catalog snapshot arrives pass unchecked. With every gate off, that changes nothing.
4. Customer decision, the profile writer, the state machine, and the outbox need no change. The `snowplow-parsed` format does not change.

Before turning a gate on, check how much traffic would fail. Sample the event's recent payloads on `snowplow-parsed` and compare them with its attributes, or turn the gate on and watch the `droppedEvents` counter with `reason` `schema_invalid` and the WARN lines from `DroppedEvents`, which name the first failing attribute and its type. Turning the gate off again takes effect within seconds. Since the [dead-letter topic](#event-parser-dead-letters-and-typed-events), each dropped event is also kept there with the parsed event.

To roll back, take a savepoint of this version and restore the previous job from it with `allowNonRestoredState`, which drops the catalog sources and the gate's broadcast state. Then drop the two slots, which no job reads any more and which hold WAL ([PLT-KI-13](../known-issues/platform.md#plt-ki-13-a-quiet-captured-table-keeps-its-slot-from-releasing-wal)):

```sql
SELECT pg_drop_replication_slot('flink_event_parse_catalog_events_slot');
SELECT pg_drop_replication_slot('flink_event_parse_catalog_fields_slot');
```

The columns and publications can stay. The previous studio neither reads nor writes them.

### CDC heartbeat table

On Postgres 15 and later, a slot streams nothing for a transaction that changes no table of its publication. Debezium moves its position only on what the slot streams. So a slot whose table was quiet confirmed no newer position at a checkpoint, and held every byte of WAL that other tables wrote. A long quiet spell in `campaigns` or `campaign_nodes` could fill the disk, or make Postgres invalidate the slot when `max_slot_wal_keep_size` is set.

Now every CDC source upserts its slot's row in the new table `cdc_heartbeat` on each 30-second heartbeat. Every CDC publication covers the table, so the write reaches every slot, and the next checkpoint confirms the newer position. Each source still reads only its own table: Debezium drops the changes to `cdc_heartbeat` before they become records, so no heartbeat row reaches a job's parser.

The job graphs, operator ids, state, slot names, and messages do not change. A connector option and a publication's table list are not part of an operator id. Restore each job from a savepoint as usual, without `allowNonRestoredState`.

A source fails when its heartbeat write fails. Debezium raises the error, and the job restarts under its restart strategy. So run the SQL before any job runs the new version. Old jobs keep working while it runs: their Debezium drops the new table's changes the same way.

1. Create the table, as the owner of the other tables:

	```sql
	CREATE TABLE IF NOT EXISTS cdc_heartbeat (
	    slot_name text primary key,
	    beat_at TIMESTAMP WITH TIME ZONE NOT NULL
	);
	```

2. If the jobs' `DB_USER` does not own the table, grant it the rights the upsert needs:

	```sql
	GRANT SELECT, INSERT, UPDATE ON cdc_heartbeat TO <DB_USER>;
	```

3. Add the table to every CDC publication, as the owner of the publications. Also add it to any other publication a CDC source reads. The [event schema gate](#event-schema-gate) creates `user_events_pub` and `user_event_fields_pub` with it. The primary key is the replica identity that Postgres needs to publish an update.

	```sql
	ALTER PUBLICATION campaigns_pub ADD TABLE cdc_heartbeat;
	ALTER PUBLICATION campaign_nodes_pub ADD TABLE cdc_heartbeat;
	ALTER PUBLICATION metric_defs_pub ADD TABLE cdc_heartbeat;
	ALTER PUBLICATION outbox_transitions_pub ADD TABLE cdc_heartbeat;
	```

4. Upgrade each job from a savepoint, in any order.
5. A minute after each job runs, check that each slot has a recent row and that `held_wal` stays small:

	```sql
	SELECT h.slot_name, h.beat_at, s.active,
		pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), s.restart_lsn)) AS held_wal
	FROM pg_replication_slots s
	LEFT JOIN cdc_heartbeat h USING (slot_name)
	WHERE s.slot_name LIKE 'flink\_%';
	```

A source sends heartbeats while idle only once it has read one transaction from its slot since it last started without a saved position. Every heartbeat write reaches every slot, so one busy source, such as the outbox, starts the others. If a slot still has no row after two minutes, write one row by hand, which reaches every slot:

```sql
INSERT INTO cdc_heartbeat (slot_name, beat_at) VALUES ('manual', now())
ON CONFLICT (slot_name) DO UPDATE SET beat_at = now();
```

The start-up condition and the error on a failed write are read from the bytecode of Postgres CDC 3.6.0-2.2 and Debezium 1.9.8. None of this was run against a live database.

To roll back, restore the previous version of each job from a savepoint, in any order. It ignores the table. Leave the table in the publications, or remove it after no job runs the new version. A new-version job that runs after the drop fails on its next heartbeat.

```sql
ALTER PUBLICATION campaigns_pub DROP TABLE cdc_heartbeat;
ALTER PUBLICATION campaign_nodes_pub DROP TABLE cdc_heartbeat;
ALTER PUBLICATION metric_defs_pub DROP TABLE cdc_heartbeat;
ALTER PUBLICATION outbox_transitions_pub DROP TABLE cdc_heartbeat;
DROP TABLE cdc_heartbeat;
```

### Missing metric values

Customer decision now records an occurrence with no value when an event lacks the metric's attribute, or when the value cannot be read as the metric's type. The [metric functions](../architecture/components/customer-decision.md#metric-functions) of the contract say how each function reads such an occurrence. The owner decided this on 2026-10-18. The empty-window rule below, where a value function has no value instead of 0, is pending owner review.

Before this change:

- A `NUMBER` metric stored 1 when the event lacked the attribute, and a `BOOLEAN` metric stored `false`. A `STRING` metric already stored no value.
- A `NUMBER` value that was not a finite number, such as `"abc"`, and a `BOOLEAN` value other than `true` or `false`, were not counted at all.
- `SUM`, `AVG`, `MIN`, `MAX`, and `LATEST` read an occurrence with no value, or a value that is not a number, as 0.
- With no value in the window, every function gave 0.

How live metrics change after the deploy:

- `SUM` on a `NUMBER` metric no longer adds 1 for each event without the attribute. Such sums go down.
- `COUNT` and `INACTION` on a `NUMBER` or `BOOLEAN` metric now count events whose value cannot be read. Such counts go up.
- `AVG`, `MIN`, and `LATEST` leave out occurrences with no value instead of reading them as 0. An average can go up, a minimum can go up, and `LATEST` returns the newest number instead of 0.
- `AVG`, `MIN`, `MAX`, `MEDIAN`, and `LATEST` with no value in the window, and `PRICE_DROP` and `DIFF` with fewer than 2 values, now have no value, and every comparison with them fails. Before, they gave 0. So a rule such as `MAX < 100`, `AVG <= 50`, or `PRICE_DROP = 0` stops passing for a person with no values in the window. An absent series and an empty window count as no values.
- `DISTINCT_COUNT` on a `BOOLEAN` metric no longer counts a missing attribute as `false`.

Nothing is backfilled. Occurrences stored before the deploy as 1 or `false` for a missing attribute stay in state and in `user_metrics` until they leave the retention period or the cap. They cannot be told apart from a real 1 or `false`. A rule changes its result at the person's next event that makes it a candidate.

Restore and deploy order:

- The job graph, the operator uids, the state layout, and the Kafka messages do not change. A series could already hold occurrences with no value, for presence and `STRING` metrics. Restore from a savepoint or checkpoint as usual, without `allowNonRestoredState`. A test takes a savepoint of a `NUMBER` series that holds an occurrence with no value, restores it, and counts the next event.
- The profile writer already stores an occurrence with no value as null in its value array, and reads it back as no value. It needs no redeploy.
- There is no deploy order. Only the customer decision job changes.
- A rollback restores the same way. The previous version reads an occurrence with no value as 0 in `SUM`, `AVG`, `MIN`, `MAX`, and `LATEST`, and stores 1 or `false` again for a missing attribute. This is inferred from the code, not run.

Before the deploy, list the comparisons whose result can change for people with no values in the window (not run). It needs Postgres 16 or later for `pg_input_is_valid`:

```sql
WITH conditions AS (
    SELECT campaign_id, node_id, aggregation_json::jsonb AS doc
    FROM campaign_nodes WHERE pg_input_is_valid(aggregation_json, 'jsonb')
)
SELECT c.campaign_id, c.node_id, ca.status, e ->> 'left' AS metric_id, upper(e ->> 'function') AS function,
       e ->> 'op' AS op, e ->> 'right' AS threshold
FROM conditions c
JOIN campaigns ca ON ca.id = c.campaign_id
CROSS JOIN LATERAL jsonb_path_query(c.doc, 'strict $.** ? (@.type == "comparison")') AS e
WHERE upper(e ->> 'function') IN ('AVG', 'MIN', 'MAX', 'MEDIAN', 'LATEST', 'PRICE_DROP', 'DIFF')
ORDER BY ca.status, c.campaign_id, c.node_id;
```

For each row in an active campaign whose operator is `<`, `<=`, `=`, or `!=`, check with its marketer that a person with no values should not pass it.

### Truncated series in a covered window

A truncated series now gives an exact `COUNT` or `INACTION` in a window when its oldest stored occurrence is at or before the window start. Before, a truncated series read every count as a lower bound, so `<`, `<=`, and `=` never passed on it. See the [metric functions](../architecture/components/customer-decision.md#metric-functions) of the contract.

Rules that start passing:

- `INACTION = 0`, `COUNT = n`, `COUNT < n`, and `COUNT <= n` on a truncated series, when the stored history reaches back past the window. A rule such as "added to cart often, then nothing for 7 days" now fires for the heaviest users.
- `COUNT != n` in the same case, when the count in the window is below `n`.
- No rule stops passing. `>=` and `>` compare the same number as before.
- A comparison with no window, or one whose window reaches back past the oldest stored occurrence, is unchanged.
- Nothing is backfilled. A rule starts to pass at the person's next event that makes it a candidate. A journey with such a rule can see more entries right after the deploy.

Late events on a truncated series:

- A late event older than the oldest stored occurrence of a truncated series is no longer counted. This keeps the exact count above correct after a definition's `max_retention_value` is raised, or its retention period or the job's allowed out-of-orderness is lengthened.
- Such an event is dropped silently, as an event older than the retention cutoff is. No metric counts it.
- Before, when the series was full, such an event was dropped at once by the cap, but the job still emitted a mutation with an unchanged series and a new behavior version. Now it emits no mutation for that series. This is inferred from the code, not run.
- A series stored below its cap, after a cap raise from before this change, may already hold such an occurrence. Its windowed counts can read low until that occurrence leaves the retention period. No query finds these series, because the dropped occurrences are not stored.

Restore and deploy order:

- The job graph, the operator uids, the state layout, and the Kafka messages do not change. Restore from a savepoint or checkpoint as usual.
- Only the customer decision job changes, so there is no deploy order.
- A rollback needs no state step. It reads every count on a truncated series as a lower bound again, and counts late events older than a truncated series again.

To list the metrics whose rules may start to pass, run the `truncated_series` query in [Metric window units and truncated series](#metric-window-units-and-truncated-series) (not run).

### Event parser: dead letters and typed events

The event parse job now writes every payload and event it drops to a dead-letter topic, `snowplow-parsed-dead-letters` by default (`KAFKA_EVENT_DEAD_LETTER_TOPIC`). Each record carries the drop reason, the time of the drop, and the content. A collector payload is written once in a `payload` record, cut to `EVENT_PARSE_DEAD_LETTER_PAYLOAD_LIMIT` bytes (512 KiB by default) and flagged `payload_truncated` when longer. Each dropped event is an `event` record that refers to the payload by `payload_id`. [Event ingestion](../architecture/components/event-ingestion.md#interfaces) lists the fields, and [decision 0017](../architecture/decisions/0017-keep-dropped-ingestion-input-in-a-dead-letter-topic.md) gives the reasons. The counters and the WARN lines do not change.

The owner decided on 2026-10-17 to add a dead-letter topic after the counters and logs. The scope (every drop reason, `schema_invalid` included), the topic name, the record shape, the payload limit, the 7-day retention below, and the access rule were chosen during the fix. They are pending owner review.

Deploy in this order:

1. Create the topic, before the new job starts. The job writes it with the `EVENT_PARSE_SINK_` brokers and security settings, and fails while it cannot. Brokers that create topics on first use would create it with their defaults, which can keep personal data for longer than you want, so create it by hand either way:

	```bash
	rpk topic create snowplow-parsed-dead-letters -p 3 -r 3 \
	  -c retention.ms=604800000 -c cleanup.policy=delete
	```

	- Retention: 7 days, the time for on-call to notice a drop, fix the cause, and replay. The records hold raw tracker payloads: IP addresses, user agents, user ids, and event attributes. Keep retention as short as replay allows, and add `retention.bytes` if a broken tracker release could fill the disk. A release that drops every event writes about as much here as it used to write to `snowplow-parsed`.
	- Access: grant `WRITE` to the event parse job's principal and `READ` only to the operators who replay. Do not let other consumers read it.
	- Use one replica on a single-broker local stack.

2. Take a savepoint of the event parse job, and restore the new version from it with `allowNonRestoredState`. Do not restore from a retained checkpoint: the records between operators changed type, and an unaligned checkpoint can hold some of them.
	- The parser is now a DataStream operator, `parse-snowplow-events`, in place of the planner's `Correlate` and `Calc`. A map, `parsed-event-rows`, turns events back into rows for the `snowplow-parsed` sink. The dead-letter sink is `dead-letter-sink`. All of them start without state. The planner's operators they replace kept none.
	- `snowplow-good-source`, both catalog sources, `catalog-schema-gate`, `identity-stitcher`, and `postgres-identity-graph-sink` keep their operator ids, so the Kafka offsets, the catalog, and the stitcher's state restore. `EventParseJobGraphTest` checks each id against the value it had before this change.
	- The planner's `snowplow-parsed` writer and committer get new ids again, as in the [event schema gate](#event-schema-gate) upgrade. That is why the restore needs `allowNonRestoredState`. The sink is at least once and flushes at each checkpoint, so nothing is lost. This is inferred from the connector code, not run on a cluster.
3. Customer decision, the profile writer, the state machine, and the outbox need no change.

The `snowplow-parsed` format keeps its fields, types, and key. A few values change:

- `app_id`: an `aid` that is blank or a placeholder id (`EVENT_PARSE_PLACEHOLDER_IDS`, by default `unknown`, `undefined`, `null`) now gives `auroracy-ecommerce`. Before, a blank or `undefined` `aid` gave null, and `unknown` or `null` was published as the `app_id`. Using the placeholder list for `app_id` was chosen during the fix. It is pending owner review.
- `collector_timestamp`: when the collector time is unset or 0, it is now null instead of 0. Customer decision's event time falls back to `event_timestamp`, so such an event is no longer read as a 1970 event and dropped as late. Publishing null was chosen during the fix. It is pending owner review.
- `network_userid` now passes through as the collector wrote it. Before, it was trimmed, and a placeholder id such as `unknown` became null. The collector sets this cookie, so expect no change on most traffic.
- An event without `ttm` from a payload whose collector time is unset or 0 is now dropped as `no_timestamp`. Before, it was published with a negative `event_timestamp`.
- `domain_userid` now comes only from the Snowplow `client_session` context, `iglu:com.snowplowanalytics.snowplow/client_session/...`, or else from `duid`. A vendor context whose schema only contains `client_session` no longer supplies it.
- `SNOWPLOW_LEGACY_CONTEXT_SCHEMA_PREFIX` is now read where the job is submitted, like the other settings, and a value that does not start with `iglu:` and end with `/` stops the job from starting. Set it in the environment of the process that submits the job.

To replay a dropped payload, take its `payload` record, check that `payload_truncated` is false, decode `payload` from Base64 and produce the bytes, with no key, to the collector's topic. Its other events are published again, and consumers deduplicate them on `event_id`. Fix the cause first: a payload that still fails is dropped again. Nothing replays automatically.

To roll back, take a savepoint and restore the previous job from it with `allowNonRestoredState`, which drops the new operators. The topic can stay, or be deleted once nobody needs its records.

### Segment checks on arrival

A segment is now checked when a person reaches it, as [decision 0015](../architecture/decisions/0015-check-a-segment-when-a-person-reaches-it.md) records. When a node completes, the state machine sends a segment check for each segment child to the new topic `journey-engine-segment-checks`, keyed by `canon_id`. Customer decision reads it and answers with a `yes` trigger on `journey-engine-matched-events` when the person meets the condition. The trigger format, the schema, `studio`, and the outbox do not change. [Customer decision](../architecture/components/customer-decision.md#interfaces) shows the new message.

Before step 1, create `journey-engine-segment-checks`, even on a broker that creates topics on first use. Customer decision reads the topic before anything writes to it, and its Kafka source looks the topic up through the admin client, which never creates one. Without the topic, the source fails with `Failed to get metadata for topics` and the job restarts again and again. Give it at least as many partitions as customer decision's parallelism. If you set `KAFKA_SEGMENT_CHECK_TOPIC`, set the same value on both jobs.

Deploy in this order:

1. Deploy customer decision. A new Kafka source, uid `segment-checks-source`, feeds the operator `apply-behavior-state`, which now takes events and checks. That operator's keyed state does not change, and every other operator keeps its uid and state. Stop the job with a canonical savepoint and restore from it without `allowNonRestoredState`. The new source has no state in the savepoint. Its consumer group has no offset on the new topic, so it starts at the earliest offset. This is inferred from Flink's operator id rules, not run.
2. Deploy the state machine. It gains a Kafka sink, uid `segment-check-sink`, and its state machine operator keeps its uid and state. Restore from a savepoint without `allowNonRestoredState`. The transitions sink had no uid, and the new sink changes the id Flink generates for its committer, from `43afce22915d2b59ca28b835a428866d` to `cae35ed458d6b95504e9d4a37a7462e3`. The transitions sink now has the uid `transition-sink` and carries the ids it had before: `99bf186e8bb5d3054d391ce0ef242107` for the writer and `43afce22915d2b59ca28b835a428866d` for the committer. `StateMachineJobGraphTest` checks that the job carries them. Those ids were generated from the graph before this change, and are the same at parallelism 1, 2, and 8. The restore itself is inferred from Flink's id rules, not run.

Customer decision goes first so that it reads each check as soon as the state machine sends it. A check that waits in the topic is still read later. Its answer carries the parent's completion time, and the new state machine applies a segment trigger at that time even behind its watermark, so the person still moves on.

The trigger message does not change: the state machine recognizes an answer by its time, not by a field. So neither job needs the other to understand a new field, and either one can run against the previous version of the other. A previous state machine drops an answer behind its watermark as late. The state layout does not change.

People who reached a segment before the deploy get no check, because the check is sent only when the parent completes. They move on at their next change to one of the segment's metrics.

To roll back, restore the previous version of each job with `allowNonRestoredState`. Flink then drops the state of the new source in customer decision, or of the new sink in the state machine. Check that the log names only those operators. Checks left in the topic are not read.

### Campaign status checks

A campaign is now active only when `campaigns.status` is exactly `active`. Studio and customer decision used to treat `ACTIVE` and `LIVE`, in any case, as active too. Studio has only ever written `active` and `paused`, so only a row edited by hand can hold another value. Studio also refuses to pause a campaign that is not `active` or to resume one that is not `paused`, and leaves a row with any other status out of the campaign list. The schema does not change.

1. Before the deploy, list the rows that change meaning:

   ```sql
   SELECT id, name, status FROM campaigns WHERE status NOT IN ('active', 'paused');
   ```

2. Set each one to `active` or `paused`. A row left as `LIVE` or `ACTIVE` stops matching events once customer decision runs the new version, and its metrics turn `PAUSED` at the next publish, pause, resume, or delete in studio.

   ```sql
   UPDATE campaigns SET status = 'active' WHERE id = '<campaign id>';
   ```

3. Deploy studio and customer decision in either order. Customer decision's job graph and state do not change, so restore it from its savepoint as usual.

### Outbox operator ids and senders that deduplicate across history

The outbox job's operators that keep state now have fixed uids. They keep their state through a later change to the job graph:

| uid | Operator | State |
|---|---|---|
| `transitions-source` | CDC source for `user_campaign_state_transitions` | Log position |
| `watch-timers` | Timer flow | `watch-timeouts` and the timers |
| `notification-sink`, `Sink Committer: notification-sink` | Kafka sink for `journey-engine-outbound-noti` | Writer and committer state |
| `watch-timeout-sink`, `Sink Committer: watch-timeout-sink` | Kafka sink for timeouts | Writer and committer state |

`outbox-profile-lookup` already had its uid. Before, every other id was derived from the shape of the graph. A graph change could drop the source's log position, and the next start then read the whole table again.

Each of these operators also carries the id Flink generated for it at parallelism 2 or more before this change. [`outbox-operator-ids-before-uids.tsv`](../../../event-processor/src/test/resources/outbox-operator-ids-before-uids.tsv) lists them. So a savepoint or checkpoint of the previous version restores into this one, with the source's log position and every pending watch. The old ids of the timer operator and the two sinks depend on which flows the job ran, so the job picks them from `ENABLE_OUTBOX` and `ENABLE_TIMER` when it builds its graph. The file lists the ids for both flows, for the outbox only, and for the timer only. Keep both flags as they were when you take the savepoint. A test checks, for each of the three, that the job carries each id. Another test checked that Flink generated each one for the graph without the new uids, at parallelism 2 and 8, until the [CDC restore window](#cdc-restore-window) change replaced the CDC source and the graph's shape. Since that change, no savepoint from before it restores the source's log position. This is inferred from Flink's operator id rules, not run on a cluster.

At parallelism 1, Flink's default `parallelism.default`, the timer flow chained differently, and the ids of `watch-timers` and `watch-timeout-sink` differ. A savepoint of a job that ran at parallelism 1 does not map onto the timer flow. The [AWS deploy guide](../../../.agents/skills/deploy/references/aws.md) runs the job at parallelism 2.

A start without the source's saved position still reads a snapshot of the table, and publishes a request again for every past engagement transition. That is now the contract: the sender must deduplicate on `execution_id` across all the requests it has ever received ([OUT-NFR-01](../architecture/components/notification-outbox.md#non-functional-requirements)). The timer flow also restarts a watch for every transition, and the state machine ignores the timeout of a watch that completed.

Deploy in this order:

1. Check that the sender keeps every `execution_id` it has delivered, with no expiry, and drops a request whose id it has seen. If it keeps ids only for a window, extend it before you start the outbox job without a savepoint.
2. Upgrade the outbox job from a savepoint, without `allowNonRestoredState`. Only this job changes.

If Flink refuses the restore because some state does not map, the running job was built from another graph or ran at parallelism 1. Restoring with `allowNonRestoredState: true` then drops the state that does not map. If that includes the timer flow, every watch timer in flight is lost: those watches complete only on `success`, their `timeout` branch never fires, and a delay never moves on. If it includes the source, the source reads a snapshot and every past request goes out again, so do this only after step 1.

Once a savepoint taken by this version exists and no older savepoint is kept, a later change can delete the carried ids, the id file, and its test. The uids stay.

### Outbox request node id and device id

The notification request on `journey-engine-outbound-noti` changes in two ways:

- `metadata` has `node_id`, the engagement node that sent the request. A sender no longer needs to parse `execution_id`, whose node part can hold `_`.
- `profile.domain_user_id` is left out when the transition has no `domain_userid`. Before, it held the `canon_id`, an id from another id space.

`execution_id` does not change, so a sender's deduplication keeps working across the deploy. The job graph and state do not change. Restore from a savepoint as usual.

Deploy in this order:

1. Deploy a sender that ignores unknown `metadata` fields and handles a `profile` without `domain_user_id`. A sender that relied on the `canon_id` there must read it from elsewhere.
2. Deploy the outbox job.

### Outbox profile lookups that time out

The outbox job now cancels a profile lookup that its 10 second timeout gave up on. A lookup still waiting for a thread then skips its query. Its lookup pool lets wait only as many lookups as its 5 threads finish within that timeout, which is none at the default connection timeout of 5 seconds. When every thread is busy, the subtask runs the lookup itself, so the outbox reads transitions more slowly instead of sending requests without contact fields. Before, the queue had no bound, and lookups that had already timed out kept the threads busy while Postgres was slow.

A profile read now waits at most the connection timeout, 5 seconds, for its result. Before, a read on a dead connection waited until the operating system closed it. This applies to the customer decision job's profile lookups too. A profile read that takes between 5 and 30 seconds now fails there and counts as an empty profile, where before it succeeded within the lookup timeout.

The job graphs, state, and messages do not change. Restore both jobs from a savepoint as usual. There is no deploy order. Expect the outbox to lag behind `user_campaign_state_transitions` while Postgres is slow. The slot holds the changes it has not read yet.

### Customer decision settings, mutations, and IN lists

This change touches the customer decision job and the outbox job. The outbox change only names the trigger's `schema_version`, which stays 3. `studio` reads `IN` lists of event names with the new rule below, and gives the same answers for event names, which hold no quotes. There is no schema change and no deploy order.

**Job graph.** The decision job no longer has the stateless operator `map-mutation-events`. The mutation sink reads the mutations from a side output of `apply-behavior-state` instead. Every operator that keeps state keeps its uid. Stop the job with a savepoint and start the new version from it as usual, without `allowNonRestoredState`. Flink skips the empty state that a savepoint holds for the removed operator, and logs `Skipping empty savepoint state for operator <id>.` This is inferred from Flink's restore code, not run. A rollback restores the same way.

**Mutations.** The job no longer writes a mutation for an event that changed no series. The profile writer wrote nothing for those, so `user_metrics` does not change. Expect fewer messages on `customer-profile-mutations`.

**State TTL.** Metric state, the behavior version, and the remembered event ids now expire `USER_METRICS_STATE_RETENTION_DAYS` days after their last write, 31 by default. Before, they lived one day longer. A restore keeps each entry's write time, so entries written 31 to 32 days before the start expire at once. A person whose state expired is read again from `user_metrics` on their next event.

**Settings.** The job now checks each setting when it builds its graph. A value it cannot use fails the start, and the message names the variable. Before, such a value fell back to the default without a log line, was capped, or failed later inside Flink. Check the job's environment before you deploy:

| Variable | Fails the start when |
|---|---|
| `CHECKPOINT_INTERVAL` | It is not a duration above 0. `1h` and `1d` now work. |
| `USER_METRICS_MAX_OUT_OF_ORDERNESS_MS` | It is not a whole number of 0 or more |
| `USER_METRICS_STATE_RETENTION_DAYS`, `USER_METRICS_MAX_METRICS_PER_CUSTOMER`, `USER_METRICS_MAX_STRING_VALUE_BYTES`, `USER_METRICS_MAX_EVENT_CONTEXT_BYTES`, `CAMPAIGN_LOOKUP_TIMEOUT_MS`, `CAMPAIGN_LOOKUP_CAPACITY`, `PROFILE_LOOKUP_THREADS`, `USER_METRICS_LOOKUP_THREADS` | It is not a whole number above 0 |
| `PROFILE_CACHE_MAX_ENTRIES`, `USER_METRICS_CACHE_MAX_ENTRIES` | It is not a whole number from 1 to 20000. A larger value was capped before. |
| `PROFILE_CACHE_TTL_MINUTES`, `USER_METRICS_CACHE_TTL_MINUTES` | It is not a whole number from 1 to 60. A larger value was capped before. |

`PROFILE_LOOKUP_THREADS` and `USER_METRICS_LOOKUP_THREADS` are new. Their defaults, 10 and 5, are the counts the job used before. Each thread holds its own Postgres connection.

**State-miss reads.** A person whose state lacks series reads all the series an event updates in one query, where the job ran one query per series before. The pool for those reads holds one connection per subtask, down from 5, because the subtask thread makes one read at a time.

**Metric definitions without an event name.** A definition whose `event_name` is blank or `*` now fails to parse. The job logs it and stops counting it. Such a definition never counted anything before. List them:

```sql
SELECT id, name, event_name
FROM user_metric_definitions
WHERE btrim(coalesce(event_name, '')) IN ('', '*');
```

**IN lists.** The job reads an `IN` list with a new rule. Commas separate the items. One pair of parentheses around the whole list is removed, and so is one pair of matching quotes around an item. Every other quote or parenthesis is part of the item. Before, every `(`, `)`, `'`, and `"` in the list was removed.

| Condition | Before | Now |
|---|---|---|
| `Hanoi IN (Hanoi, 'Da Nang')`, `Da Nang IN 'Hanoi', "Da Nang"` | Matched | Matches |
| Profile `O'Brien IN O'Brien,Smith`, event `Sale (50%) IN 'Sale (50%)', Clearance` | Did not match | Matches |
| Profile `OBrien IN O'Brien,Smith` | Matched | Does not match |
| `b IN (a), (b)`, `b IN a, b)` | Matched | Does not match. Only a pair of parentheses around the whole list is removed, so the items hold the others. |

To find the conditions whose answer can change, run the query in [Predicate evaluation](#predicate-evaluation) with the `found` step below. It lists every `IN` comparison whose list holds a quote or a parenthesis. Read each one. A list wrapped in one pair of parentheses with quoted items keeps its answer.

```sql
found AS (
    SELECT source, row_id, c, 'IN with a quote or a parenthesis' AS reason
    FROM comparisons
    WHERE upper(c ->> 'op') = 'IN' AND c ->> 'right' ~ '[''"()]'
)
```

This is inferred from the code and the unit tests. The queries were not run against a database.

### Identity stitcher state per entry

The stitcher now keeps each device's structure entry by entry, in the keyed states `identity-parent-links`, `identity-root-priorities`, `identity-entry-count`, and `identity-written-at`, instead of one `identity-dsu-state` value. An event reads and writes only the entries it touches. A device's state expires 7 days after its last write through a processing-time timer, which fires on the first hour boundary after that. Only the event parse job changes, so there is no deploy order.

- The operator id, `identity-stitcher`, does not change, and the job keeps `identity-dsu-state` with its old serializer and TTL. Restore from the last savepoint or checkpoint as usual. `allowNonRestoredState` is not needed.
- A device moves to the new states on its first event after the deploy, and `identity-dsu-state` is cleared for it. A device that sends no event expires from `identity-dsu-state` through its old 7-day TTL. The operator test harness restored the old value on RocksDB and on heap, moved it, and restored again with Kryo turned off. This was not run on a cluster.
- A moved device gets 7 days from its first event after the deploy, even if its last write was earlier.
- The previous version does not read the new states. To roll back, start the previous JAR from the savepoint taken before this deploy. A savepoint taken after it restores into the previous JAR, but every device that sent an event since the deploy rebuilds from `identity_graph`. This is inferred from the code, not run.
- Keep `identity-dsu-state` in the code until no savepoint from before this deploy is needed. A later version can drop it 7 days after this deploy.

### Identity lookups off the stream's thread

The stitcher now reads `identity_graph` on a pool of lookup threads. An event that needs a read waits in the keyed state `identity-pending-events`, with the later events of its key behind it, and a processing-time timer publishes them when the read completes. Events of other keys go on. Only the event parse job changes, so there is no deploy order.

- Each stitcher subtask now opens up to `IDENTITY_LOOKUP_CONCURRENCY` connections to the primary, default 4, instead of 1. Check that the primary's `max_connections` has room for 4 per subtask, or set the variable lower.
- The operator id and the existing states do not change. Restore from the last savepoint or checkpoint as usual. `allowNonRestoredState` is not needed.
- Stop the job with a savepoint, without `--drain`. A checkpoint or savepoint holds the waiting events and their timers, and the restored job reads again for them. The operator test harness restored waiting events on RocksDB and on heap. This was not run on a cluster.
- To roll back, start the previous JAR from a savepoint. Events that waited in that savepoint are not published, because the previous version does not read `identity-pending-events`. Take the savepoint while Postgres is healthy, so few events wait. This is inferred from the code, not run.

### Identity rechecks and joined roots

A device whose set holds a `user_id` now reads `identity_graph` again once its last read is `IDENTITY_RECHECK_INTERVAL` old, default 1 minute, and joins the roots on the user's rows. So a merge on one device reaches the user's other devices. Each lookup now reads the device's row and up to 10 of the user's newest rows in one query, and an event without a device takes the root those rows join into instead of the newest row's. See [decision 0021](../architecture/decisions/0021-recheck-a-users-rows-to-carry-merges-to-the-users-devices.md). Only the event parse job changes, so there is no deploy order.

- The stitcher adds the keyed state `identity-checked-at`. The operator id and the other states do not change. Restore from the last savepoint or checkpoint as usual. `allowNonRestoredState` is not needed.
- Expect about one more read of the primary per active logged-in device per interval. Every logged-in device rechecks on its first event after the deploy, because no device has a last read yet. Size the load from the number of distinct `domain_userid` values with a `user_id` per minute.
- Users whose devices hold different roots today converge on the root that sorts first, within one interval of each device's next event. Events from then on carry that root. Metrics and journey state under the other root stay there, as for any merge. The devices' `identity_graph` rows are rewritten with the joined root.
- The schema does not change. The lookup still uses the index on `(user_id, updated_at desc)`.
- To roll back, start the previous JAR from a savepoint. It ignores `identity-checked-at`. This is inferred from the code, not run.

### Rule columns of campaign nodes

`campaign_nodes` saves a node's rule in `trigger_json`, `conditions_json`, and `paths_json`, in the [saved format](../features/journey-builder.md#saved-format). `condition_json`, `profile_condition_json`, and `aggregation_json` are gone, and so is the view `campaign_steps`, which had no reader. A profile and a behavior condition can now share a group, so either one passes it. `IN` takes a JSON array. See [decision 0029](../architecture/decisions/0029-model-a-rule-as-a-trigger-and-person-conditions.md).

No deployment holds campaigns in the old columns, so there is no migration. `studio`, customer decision, and the state machine must run the same version:

1. Apply `schema.sql`. It drops and creates `campaign_nodes`, so every published campaign is gone. Publish them again in `studio` after step 3.
2. Start customer decision and the state machine without restoring a savepoint taken before this change. The customer decision broadcast state holds the rule type, whose fields changed. Restoring it is not verified.
3. Deploy `studio`.

The outbox job does not change.

### State machine settings

The state machine now stops at startup when a numeric `STATE_MACHINE_` setting is not a whole number above 0, and the error names the variable. Before, `0` was accepted, so `STATE_MACHINE_MAX_PENDING_MATCHES_PER_JOURNEY=0` dropped every buffered trigger, and a negative or unparseable value silently took the default. Check the job's environment before the deploy. A blank variable still takes the default. See [Configuration](configuration.md#journey-execution).

The job graph, the operator ids, and the state do not change. `StateMachineJobGraphTest` checks the ids of every operator that keeps state. Restore from a savepoint as usual. There is no deploy order.

### Transition columns

`user_campaign_state_transitions` loses its `parents` column. Nothing ever wrote a value to it. The state machine no longer writes it, and the outbox job no longer reads it through CDC. `transitioned_at` stays: the database fills it with the time the row was written.

The job graphs, the operator ids, and the state do not change. `StateMachineJobGraphTest` and `CampaignOutboxJobGraphTest` check the ids. Deploy in this order:

1. Upgrade the state machine and the outbox job from a savepoint.
2. Drop the column. An older job still names it, so do not drop it before step 1.

	```sql
	ALTER TABLE user_campaign_state_transitions DROP COLUMN parents;
	```

To roll back the jobs, add the column back first: `ALTER TABLE user_campaign_state_transitions ADD COLUMN parents jsonb;`.

### Legacy Postgres engine removed

`infra/db/state_machine.sql` is gone, and the `postgres-init-scripts` ConfigMap holds only `schema.sql`. That file installed the trigger `trg_evaluate_state_transitions` on `user_events_log`, the journey engine before it moved to Flink ([decision 0001](../architecture/decisions/0001-run-the-journey-engine-in-flink.md)). Nothing has written to `user_events_log` since then, so the trigger never ran. `schema.sql` no longer creates the table, its indexes, or `cleanup_user_events_log`.

Before you sync the ConfigMap, check that nothing in the Argo CD repo mounts or runs the `state_machine.sql` key. A fresh database no longer gets the old objects. An existing database keeps them until you drop them. Check that the table is empty or holds only rows you do not need, then run:

```sql
BEGIN;
DROP TRIGGER IF EXISTS trg_evaluate_state_transitions ON user_events_log;
DROP FUNCTION IF EXISTS evaluate_state_transitions();
DROP FUNCTION IF EXISTS get_transition_watch_children(VARCHAR, VARCHAR, VARCHAR);
DROP FUNCTION IF EXISTS cleanup_user_events_log(INTERVAL, INT);
DROP TABLE IF EXISTS user_events_log;
COMMIT;
```

No Flink job reads or writes these objects, so there is no deploy order and no restart.

### Graph loads on a fresh start

A trigger that waits for its campaign's graph, or for its node, is now dropped only when two things hold: the watermark has passed its event time plus the graph-load allowance, and the state machine has run for the allowance in real time since its first record after the start. Before, only the watermark counted. On a start without a savepoint, the trigger backlog moves the watermark hours ahead in seconds while the `campaign_nodes` snapshot still loads, so triggers for campaigns not loaded yet were dropped as unreachable. The CDC source does not say when its snapshot ends, so the real-time wait stands in for it. A snapshot that takes longer than the allowance still drops such triggers. Raise `STATE_MACHINE_GRAPH_LOAD_ALLOWANCE_MS` for that start.

After any start, a trigger for a deleted node is now dropped up to one allowance later than before, 5 minutes by default. It completes nothing in the meantime.

The job graph, the operator ids, and the state layout do not change. The state machine now also sets processing-time timers, which Flink keeps in the timer state it already has. Restore from a savepoint as usual. Only the state machine changes, so there is no deploy order. `CampaignGraphArrivalTest` runs the backlog case in the test harness. It did not run on the cluster.

### Buffered triggers on a campaign delete

When the first delete row of a change takes a campaign's graph down, the state machine now drops every buffered trigger for a node of that graph and counts it in `unreachableMatchedEvents`. Before, such a trigger waited and could complete a node of the next graph, such as a campaign deleted and published again under the same ids. A save does the same, so a trigger that waited for its parent across a pause and resume is dropped too. Customer decision emits nothing for a paused campaign, so such a trigger could only apply if its parent's trigger arrived late. A buffered trigger for a node the graph does not hold yet still waits for the save that adds it.

The job graph, the operator ids, and the state do not change. Restore from a savepoint as usual. Only the state machine changes, so there is no deploy order.

### Studio checks the schema instead of creating tables

`studio` no longer creates `system_users`, `system_user_id_tokens`, `campaigns`, or `campaign_nodes` at start-up. `infra/db/schema.sql` is the only DDL source ([decision 0019](../architecture/decisions/0019-keep-schema-sql-the-only-ddl-source.md)), and the `postgres-init-scripts` ConfigMap and `pnpm db:reset` already apply it. On the first database call, `studio` checks that every table it reads exists. If one is missing, every call fails with `Postgres has no <tables>. Apply infra/db/schema.sql before starting studio.` Only `studio` changes, so there is no deploy order and no SQL to run on a database that `schema.sql` created.

- Before the deploy, check that the database has every table `studio` reads: `system_users`, `system_user_id_tokens`, `campaigns`, `campaign_nodes`, `campaign_node_stats`, `user_events`, `user_event_fields`, and `user_metric_definitions`. A database that only an older `studio` ever touched lacks some of them. Apply `schema.sql` to it first. `schema.sql` drops the tables at its top, so on a database with data, run only the `CREATE` statements that are missing.
- A rollback needs no SQL. The older `studio` creates its tables only when they are missing.

### State machine trigger decoding

The state machine now reads the trigger topic with a Kafka source that decodes each message in the job. A message that is not a JSON object, or has a field of the wrong type, is now logged and counted in `invalidMatchedEvents`. Before, the JSON format skipped it with no log or count. Valid triggers decode as before, and the trigger watermark is the same: per partition, the latest event time less the allowed out-of-orderness in whole seconds, with the same idle timeout.

The job graph changed. The trigger source has the uid `journey-trigger-source` and carries the id Flink generated for the old trigger table source, so its Kafka offsets restore from a savepoint taken before this change. The table conversion and parser operators after the old source are gone. They kept no state. The broadcast campaign graphs, the journey state, and both sinks keep their ids. This is inferred from Flink's operator id rules and from the Kafka connector, which builds the same Kafka source for a table. Not run on the cluster.

Only the state machine changes. Deploy in this order:

1. Stop the state machine with a savepoint.
2. Start the new state machine from that savepoint. It needs no `allowNonRestoredState`.

`invalidMatchedEvents` moves from the parser operator to the trigger source's `deserializer` group, so its Prometheus name gains `deserializer_`. Apply the updated `JourneyTriggersInvalid` rule in [journey-engine-alerts.yaml](../../../infra/monitoring/journey-engine-alerts.yaml) to the Argo CD repo before the deploy. It matches both names. The counter starts again at 0, like after any restart.

### Metric definition broadcast state fields

Customer decision keeps each metric definition in the broadcast state `metric-config-broadcast-state`. Six fields that nothing read are gone from the stored value: the metric kind, the definition version, the storage strategy, the bucket width, the chunk width, and the occurrences per chunk. Flink stores the value with its POJO serializer, which drops removed fields on restore. The job graph and the operator ids do not change. Only customer decision changes, so there is no deploy order.

1. Stop customer decision with a savepoint.
2. Start the new customer decision from that savepoint. It needs no `allowNonRestoredState`. The restored definitions keep their value type, retention, and enabled flag.

The operator test harness restored a RocksDB snapshot written with the old fields into the new code, and a snapshot written by the new code into the previous version, so a rollback can start from a savepoint taken after this deploy. This was not run on a cluster. If a restore fails, start the previous version from the same savepoint. A start without a savepoint does refill the definitions, because the CDC source reads `user_metric_definitions` again. But it also drops the job's keyed state, so follow [Customer decision metric snapshot](#customer-decision-metric-snapshot) if you take that path.

### Database settings read where the job is submitted

Every lookup pool now opens from the database settings that the job reads when it is submitted: the stitcher's `identity_graph` lookups, the customer decision `user_metrics` reads and profile lookups, and the outbox profile lookups. Before, each pool read `DB_HOST`, `DB_READ_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USER`, and `DB_PASSWORD` again on each task manager when it opened. The CDC sources and the sinks already used the settings read at submission, so every job already needed the `DB_` variables there, except `DB_READ_HOST`. The variable names, defaults, and hosts are unchanged.

Check `DB_READ_HOST` before the deploy. A deployment that sets it only on the task managers now sends the metric and profile lookups to the primary. Set it where the job is submitted: on the job manager in application mode. The example `FlinkDeployment` in the deploy skill sets its variables in the pod template, which both the job manager and the task managers use. The local compose file sets no `DB_READ_HOST`.

The job graphs keep every operator id and every state, and no Kafka message changes. Only the functions' serialized settings change, which a savepoint does not hold. This is inferred from the job graph tests, which pass with the same ids. Not run on the cluster. Deploy in any order:

1. Stop each job with a savepoint.
2. Start the new job from that savepoint. It needs no `allowNonRestoredState`.

### Trigger graph versions

Each publish now writes its graph at a version, `campaign_nodes.graph_version`, taken from the sequence `campaign_graph_version_seq`. A resume keeps the version. Customer decision copies the version into each trigger, the state machine lists it with each watch child of a transition, and the timer flow copies it into the timeout. The trigger message carries it as `graph_version`, schema version 4. The state machine drops, as unreachable, a trigger decided against an older version than the live graph's, and buffers one decided against a newer version until that graph goes live. A trigger without a version applies as before. See [decision 0022](../architecture/decisions/0022-version-each-published-graph.md).

Every job must know a campaign's version before studio writes a new one. A job that restores its state reads version 0 for each graph it holds, so the rows that exist get 0 too, and studio is deployed last. Deploy in this order:

1. Create the sequence and add the column. The default fills the rows that exist with 0 and keeps the old studio's inserts working. On Postgres 11 and later the column is added without a table rewrite, so CDC sends no change.

	```sql
	BEGIN;
	CREATE SEQUENCE IF NOT EXISTS campaign_graph_version_seq;
	ALTER TABLE campaign_nodes ADD COLUMN graph_version bigint NOT NULL DEFAULT 0;
	COMMIT;
	```

2. Deploy the state machine. Stop it with a savepoint and start the new version from it. The operator uids do not change. The graphs restore at version 0. The trigger buffer moves to new state, `pending-triggers-by-event-time`. The CDC source reads one more column, which changes no operator id, so it keeps its log position. This is inferred from how Flink assigns ids, not run. If the restore fails on the source, restore with `allowNonRestoredState`. The source then reads a new snapshot of `campaign_nodes`, which rebuilds the graphs with the stored versions.
3. Deploy the outbox job from a savepoint. The watches restore without a version, and their timeouts apply as before.
4. Deploy customer decision from a savepoint. Its rules restore at version 0. Its CDC source reads one more column, as in step 2. `MetricConditionDecisionTest` restores rules saved by an earlier version.
5. Deploy studio. From now on each publish writes a new version.
6. Make every writer set the column:

	```sql
	ALTER TABLE campaign_nodes ALTER COLUMN graph_version DROP DEFAULT;
	```

Until step 5, a campaign published again keeps version 0, and the state machine treats it as before this change.

A trigger in flight across a publish is now dropped as unreachable and counted in `unreachableMatchedEvents`. That includes the triggers customer decision decides against the old graph while it reads the publish later than the state machine, and the timeouts of watches started before the publish. A published campaign is read-only in studio, so this happens only when a campaign is deleted and published again under the same id. A pause and resume keeps the version and drops none of them. A buffered trigger with a version now survives a resume and applies, where [Buffered triggers on a campaign delete](#buffered-triggers-on-a-campaign-delete) dropped it.

To roll back studio, put the default back first: `ALTER TABLE campaign_nodes ALTER COLUMN graph_version SET DEFAULT 0;`. A campaign the old studio publishes then gets version 0, below the version it replaces, so the triggers in flight for it wait for a newer graph and are dropped after the graph-load allowance. The previous outbox job and customer decision can restore a savepoint of this version: Flink's POJO serializer drops the field they do not know. The previous state machine likely cannot, because the new buffer names a class it does not have. This was not run. Roll it back from the savepoint taken before step 2, as [Rolling back to an older savepoint](#rolling-back-to-an-older-savepoint) describes.

### State machine TTL cleanup on access only

The state machine now cleans up expired heap state only when a record or timer reads or writes the state, not each time it selects a key. RocksDB never ran this cleanup, so a job on RocksDB is unaffected. A save no longer pays for the journeys of other campaigns that hold buffered triggers. On a laptop, with 100,000 such journeys on one subtask, a save took about 5.6 seconds before and 17 ms after. Expired entries were never returned, so no result changes. Expired state of a journey that gets no more records is still removed as other journeys' accesses sweep the state, as before.

The state layout and the operator uids do not change, and no other job is involved. Stop the state machine with a savepoint and start the new version from it. Rolling back from a savepoint of this version is likely to work, since the layout is the same, but was not run.

### Metric series as time buckets

A series now keeps totals per UTC minute, hour, and day instead of its newest 100 occurrences, as [decision 0028](../architecture/decisions/0028-store-metrics-as-tiered-time-buckets.md) records. Every occurrence within the retention period counts, and `max_retention_value` is gone from metric definitions and `studio`.

- The state, the mutation on `customer-profile-mutations`, and the `user_metrics` row all change shape. Start the decision job and the profile writer without a savepoint, and drain or reset `customer-profile-mutations` first: the profile writer skips a mutation in the old shape.
- Before you deploy, raise the size limits for `customer-profile-mutations` to 8 MiB (8388608 bytes). A series with full quantile summaries is about 2.34 MB in one mutation. Set the topic's `max.message.bytes` to 8388608, for example `kafka-configs --alter --entity-type topics --entity-name customer-profile-mutations --add-config max.message.bytes=8388608`, and make sure the broker's `message.max.bytes` and `replica.fetch.max.bytes` (or, on Redpanda, `kafka_batch_max_bytes`) are at least that large. Change the topic and broker settings in the Argo CD repo or wherever the cluster's Kafka is configured. The jobs set the producer's `max.request.size` and the profile writer's `max.partition.fetch.bytes` and `fetch.max.bytes` to 8 MiB themselves. The local compose stack sets `kafka_batch_max_bytes` to 8 MiB.
- Apply `schema.sql`. It drops a `user_metrics` table with the old occurrence arrays and creates the new one, and it drops `max_retention_value`. The job starts every series empty and backfills nothing.
- A window's old edge now rounds out to the bucket that holds it: to the minute for windows up to 1 hour, the hour up to 7 days, and the day beyond.
- `MEDIAN` and `DISTINCT_COUNT` are now estimates, within about 2%.
- A copy of an event that arrives after 512 newer events of the same person counts twice. Buckets keep no event ids.
- A rollback needs the same steps the other way: the old version cannot read the new state, mutations, or rows.

### Journey entries

A journey instance is now one entry ([decision 0033](../architecture/decisions/0033-a-journey-instance-is-one-entry.md)). A person can pass through one campaign more than once, once per entry id. These things change:

- A trigger message can carry `entry_id`. A setup trigger without one is for the entry `first`, and a trigger for any other node without one applies to each of the person's entries in the campaign. Customer decision sends no entry id yet, so a person still enters each campaign once. The trigger schema version stays 4.
- `user_campaign_state_transitions` has the column `entry_id`, and the primary key is (`canon_id`, `campaign_id`, `entry_id`, `node_id`, `branch`).
- `campaign_node_stats` counts entries. A person with two entries counts twice.
- A watch timeout carries the `entry_id` of the transition that started its watch, and the timer flow keeps one watch per entry and watch node.
- The notification request's `execution_id` ends with `_` and the entry id, for example `CAMP-0001_n5_sms_7e9d..._first`. A sender that deduplicates on `execution_id` sees a request published again after this change as a new request.

The state machine keeps a map of entries per journey key in new state, `journey-entries`, and the buffered triggers and the pending watches gain a field. This version does not restore the state of an earlier one. This was not run. Deploy in this order:

1. Stop the state machine and the outbox job.
2. Add the column. Existing rows get `first`, the entry of a person's only pass so far.

	```sql
	BEGIN;
	ALTER TABLE user_campaign_state_transitions ADD COLUMN entry_id VARCHAR NOT NULL DEFAULT 'first';
	ALTER TABLE user_campaign_state_transitions ALTER COLUMN entry_id DROP DEFAULT;
	ALTER TABLE user_campaign_state_transitions DROP CONSTRAINT user_campaign_state_transitions_pkey;
	ALTER TABLE user_campaign_state_transitions
	    ADD PRIMARY KEY (canon_id, campaign_id, entry_id, node_id, branch);
	DROP INDEX IF EXISTS idx_ucst_campaign_node;
	CREATE INDEX idx_ucst_campaign_node
	    ON user_campaign_state_transitions (campaign_id, node_id, canon_id, entry_id);
	CREATE OR REPLACE VIEW campaign_node_stats (campaign_id, node_id, user_count) AS
	SELECT campaign_id, node_id, COUNT(DISTINCT (canon_id, entry_id))
	FROM user_campaign_state_transitions
	GROUP BY campaign_id, node_id;
	COMMIT;
	```

3. Start the state machine without a savepoint. Its journey state is lost, so a journey in flight stops at its last completed node. A trigger for a node below it finds no completed parent, and the job drops it as unreachable. A trigger the job reads again completes its node again in state, but the sink skips a row that exists, so no row is written twice.
4. Start the outbox job without a savepoint. Its CDC source reads a new snapshot of `user_campaign_state_transitions`. It publishes every engagement request again with the new `execution_id`, so the sender sends each one again, and the timer flow starts every listed watch again. Deduplicate on the sender side before this step if that is not acceptable.

Customer decision and studio need no change.

### Event kinds and item keys

Each catalog event gets a kind, `person` or `business`. A business event also names its item key, one of its attributes, such as `product.id`. See [CAT-FR-16 and CAT-FR-17](../features/event-catalog.md#functional-requirements). Existing events read as `person`, which is how the pipeline treats them today.

Deploy in this order:

1. Change the database. `kind` has a constant default and `item_key` has none, so on Postgres 11 or later the `ALTER`s do not rewrite the table. Each check scans the table once to validate the existing rows, which all pass. The old studio does not read the columns.

	```sql
	ALTER TABLE user_events ADD COLUMN IF NOT EXISTS kind varchar NOT NULL DEFAULT 'person';
	ALTER TABLE user_events ADD COLUMN IF NOT EXISTS item_key varchar;
	ALTER TABLE user_events ADD CONSTRAINT user_events_kind_check CHECK (kind IN ('person', 'business'));
	ALTER TABLE user_events ADD CONSTRAINT user_events_item_key_check CHECK ((kind = 'business') = (item_key IS NOT NULL));
	```

2. Deploy studio. The event list gains a Kind column, and the create and edit forms a Kind choice with an item key.

The Flink jobs need no change. The event parse job's catalog source declares the columns it reads, so it ignores the two new ones. This is inferred from the code, not run on a cluster.

To roll back, deploy the previous studio. It neither reads nor writes the columns, and the default keeps the events it creates valid. The columns and the checks can stay.

### Customer decision rule decisions in one operator

The customer decision job now makes every rule decision in the keyed operator `apply-behavior-state`, as [decision 0030](../architecture/decisions/0030-make-every-rule-decision-in-one-keyed-operator.md) describes. A person's triggers now leave in the order their events arrived. A rule whose metric condition fails no longer looks up the profile, and a lookup reads only the profile columns that the waiting conditions compare.

**Job graph.** The non-keyed operator `evaluate-campaign-rules` and the lookup `profile-lookup` are gone. The new lookup `profile-field-lookup` reads profiles only, and the new keyed operator `release-triggers-in-order` releases each person's triggers in order. A savepoint from the previous version does not restore into this one. No deployment runs the job yet, so start it without a savepoint. A rollback also starts the previous version without a savepoint.

**Settings.** The job no longer reads `USER_METRICS_LOOKUP_THREADS`, `USER_METRICS_CACHE_MAX_ENTRIES`, or `USER_METRICS_CACHE_TTL_MINUTES`. Remove them from the job's environment. `apply-behavior-state` now reads a series that a rule references and state lacks, through its existing pool and `USER_METRICS_READ_TIMEOUT`, and keeps it in state. A series the person has no row for goes into state empty, so it is read once.

**Postgres.** Each subtask opens 5 fewer connections, because the series lookup pool is gone. An event's lookup reads every column its waiting rules compare in one query. The profile cache keys an entry by the profile and the columns read, so an event that compares other columns reads the profile again.

**Latency.** A person whose event waits for a profile lookup sees their later triggers wait until that lookup ends. A lookup ends with the profile, or with an empty profile when it fails or runs past `CAMPAIGN_LOOKUP_TIMEOUT_MS`. Under backpressure an event can also wait for a free slot in the lookup's queue of `CAMPAIGN_LOOKUP_CAPACITY` before its timeout starts, and the person's later triggers wait for it too. No trigger leaves ahead of an earlier one of the same person, including after a restore from a checkpoint. Other people's triggers do not wait.

The Kafka messages and the schema do not change. There is no deploy order with other jobs.

### Studio v2 read indexes

`schema.sql` adds three indexes on `user_campaign_state_transitions` and one on `identity_graph`, for the studio v2 reads that [decision 0035](../architecture/decisions/0035-compute-journey-analytics-from-transitions-on-read.md) lists. No job and no table changes. There is no deploy order and no restart. The AWS cluster applies `schema.sql` only when its database is first created, so run these steps on each existing database before studio v2's phase 1 pages go live. Without the indexes those pages still answer, but by scanning the tables.

1. Create the indexes. `CONCURRENTLY` does not block the state machine's inserts or the event parser's identity writes, but it cannot run inside a transaction, so run each statement on its own, for example with one `psql -c` each. Each build scans its table once.

   ```sql
   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ucst_node_reach ON user_campaign_state_transitions (campaign_id, node_id, branch, event_timestamp) INCLUDE (canon_id, entry_id);
   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ucst_type_event_time ON user_campaign_state_transitions (node_type, event_timestamp) INCLUDE (campaign_id, branch);
   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ucst_type_written ON user_campaign_state_transitions (node_type, transitioned_at) INCLUDE (event_timestamp, branch);
   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ig_canon ON identity_graph (canon_id) INCLUDE (domain_userid, user_id, created_at, updated_at);
   ```

2. A failed build leaves an invalid index, and `IF NOT EXISTS` then skips it. Check that this returns four rows, each with `t`. For a missing row or an `f`, run `DROP INDEX CONCURRENTLY IF EXISTS <name>;` and that index's statement in step 1 again.

   ```sql
   SELECT c.relname, i.indisvalid
   FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname IN ('idx_ucst_node_reach', 'idx_ucst_type_event_time', 'idx_ucst_type_written', 'idx_ig_canon');
   ```

The older index `idx_ucst_campaign_node` stays. Decision 0035 step 4 drops it only if `EXPLAIN` shows that `campaign_node_stats` uses `idx_ucst_node_reach`. Each transition insert now maintains three more indexes, so watch the state machine's write rate after step 1.

To roll back, drop the four indexes with `DROP INDEX CONCURRENTLY IF EXISTS`. Nothing else reads them.

## Environment variables

[Configuration](configuration.md) lists every variable the jobs and `studio` read, with defaults. For a deployment:

- Put `DB_PASSWORD`, `OIDC_CLIENT_SECRET` or each `OIDC_<ID>_CLIENT_SECRET`, and `SESSION_SECRET` in a Kubernetes secret.
- Set `OIDC_REDIRECT_URL` to the public hostname of the ingress, and register it at the provider.
- The ConfigMaps carry no seed data and no staff user. Each person's first sign-in creates their row, with the role the provider gives. Set `OIDC_ROLE_CLAIM` and `OIDC_ROLE_MAP` before the first sign-in.
