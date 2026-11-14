# Rollout known issues

This page covers the technical issues the AWS Free Plan rollout hit between 2026-11-06 and 2026-11-08, grouped by technology. Each entry gives the symptom, the root cause, how it was found, the fix step by step, and its status. Read it before you change a stateful Flink job, a CDC setting, the Argo CD sync policy, the database schema, or sign-in.

Status words:

- **Fixed:** shipped and verified on the cluster.
- **Mitigated:** service restored; the root fix is pending.
- **Open:** not fixed.
- **Fact:** a behavior to remember; nothing to fix.

## Apache Flink

### A new job image cannot restore its savepoint

**Status.** Mitigated. event-parse-job runs the previous image. The root fix is open.

**Symptom.** On 2026-11-08 at 13:41Z, #383 added per-event volume operators to event-parse-job. The upgrade failed, and the JobManager logged:

```
Failed to rollback to checkpoint/savepoint s3://…/savepoint-14208a-8f0401e02d2f.
Cannot map checkpoint/savepoint state for operator d6d3715bf8f439961ad0b670e668bc73
to the new program, because the operator is not available in the new program
```

The JobManager restarted once. Then the FlinkDeployment showed `DEPLOYED / RECONCILING` and `Job Not Found`, and no events were parsed. At about 14:49Z, #394's fix rolled out and failed the same way, this time on `savepoint-9cea9a-e003907878db`.

**How Flink restores state.** A savepoint maps each operator id to that operator's state. On restore, Flink builds the new job graph, gives every operator an id, and matches the ids. If saved state has no matching operator, the restore aborts. The only way past that is `allowNonRestoredState`, which silently drops the state. The ids come from three places:

- An operator with `.uid("…")` keeps that id across versions.
- An operator without a uid gets an id hashed from its position in the graph. Adding or moving an operator upstream changes the hash.
- Operators that the SQL/Table planner creates have no uid unless you set one. These include sinks attached through a statement set, `TableToDataStream`, the constraint enforcer, and anonymous sources.

**Root cause, as known on 2026-11-08.**

1. #383 changed the graph, so the generated ids of the planner-built operators changed.
2. #394 found that `d6d3715b…` is the writer of the planner-built Kafka sink `kafka_snowplow_parsed`. It pinned that writer to its old hash with `CustomSinkOperatorUidHashes`. It assumed that Flink skips operators with empty state, such as the sink committer.
3. #394 proved the fix with an operator-id fixture: the old ids checked against a graph the test built itself. Review accepted that proof.
4. The real `savepoint-9cea9a/_metadata`, read from S3, holds a state entry for every operator, including the stateless and uid-less ones: sink committer `0ab47442…`, the planner's anonymous source `552996…`, `TableToDataStream`, and `ConstraintEnforcer`. The committer assumption is wrong for this savepoint.
5. A local MiniCluster restore of that real `_metadata` with #394's jar fails on `0ab47442`, not on `d6d3715b`. The restore ran the Flink 2.2.0 distribution libraries and the `PackagedProgram` `main()` path that the cluster uses. Why production named `d6d3715b` the second time is unknown, because that JobManager log is gone.

**How it was found.**

1. `kubectl -n cdp get flinkdeployment` showed event-parse-job `RECONCILING` while the other four jobs were `STABLE`.
2. `kubectl -n cdp logs deploy/event-parse-job --previous | grep "Caused by"` printed the `Cannot map` line.

A rollout script that only reports a timeout does not prove the jobs are healthy. Check each job's lifecycle state yourself.

**How service was restored, both times.**

1. **Keep the state.** Never set `allowNonRestoredState`, and never delete a savepoint. Raw events wait in the Kafka topic `snowplow-good`, which keeps 3 days.
2. **Pin event-parse-job to the image that wrote the savepoint** (`sha-15717015fcc5`). A kustomize patch, `infra/k8s/apps/flink-parse/pin-image.yaml`, overrides `spec.image` on that one FlinkDeployment. The other four jobs keep the new image.
3. **Redeploy from the savepoint.** The pin alone does nothing (see the next issue). The same patch sets `job.state: running` and `initialSavepointPath` to the savepoint, and it changes `savepointRedeployNonce`. The operator then runs `SAVEPOINT_REDEPLOY` from that path.
4. **Push the change to the deploy branch and refresh Argo CD.** Argo CD self-heals, so a manual `kubectl` edit would be reverted.
5. **Verify every item:**
   - The JobManager log says `Restoring job … from Savepoint <n>`.
   - The job is `RUNNING` / `STABLE`, and checkpoints are completing.
   - Both of the job's CDC slots are `active` and `reserved`.
   - No new exceptions appear for 5 minutes.

Downtime was 13:41 to 14:11Z the first time and about 14:49 to 14:58Z the second. No Flink state and no events were lost.

**Root fix (open).**

1. Pin every planner-built operator to its old id with uid hashes: the writer, committer, anonymous source, `TableToDataStream`, and `ConstraintEnforcer`.
2. Add a test that fails when any operator has neither an explicit uid nor a pinned hash. Allow no exceptions.
3. Add a real restore test. CI builds the old `15717015` jar. A MiniCluster with Testcontainers Kafka and Postgres runs the old `main()`, takes a savepoint, and then the new `main()` restores it. This test replaces the id fixture.
4. Keep the image pin until that test passes. Freeze merges to the deploy branch while the fix rolls out.

**Lesson.** Give every stateful operator an explicit uid from the first version, including the operators the planner creates. Prove that a state change is compatible by restoring a real savepoint of the old version through the same entry point the cluster uses. A test that builds its own graph proves nothing about the graph production builds.

### The operator will not deploy a pinned image while the job is missing

**Status.** Worked around.

**Symptom.** After the image pin applied, the operator logged the following every 15 s, and `lastReconciledSpec` kept the broken image:

```
Falling back to last-state upgrade mode from savepoint
Job is not running and checkpoint information is not available for executing the upgrade,
waiting for upgradeable state
```

**Cause.** With `upgradeMode: savepoint`, an upgrade first stops the running job with a savepoint. When the job is gone and no recent checkpoint is known, the operator waits forever. Setting `job.state: suspended` did not help either.

**Fix.** Set `initialSavepointPath` and change `savepointRedeployNonce`. Together they are the operator's explicit "redeploy from this savepoint" switch.

### A job stuck on a lost CDC slot blocks every checkpoint

**Status.** Fixed during the #320 recovery.

**Symptom.** After a load test, the CDC jobs restarted about every 31 minutes. Each savepoint-based suspend hung for 600 s, and the operator retried it forever.

**Chain of events.**

1. Postgres invalidated each slot whose held WAL passed `max_slot_wal_keep_size` (`wal_status=lost`).
2. The Debezium source retried "Cannot obtain valid replication slot" every 2 s, 900 times.
3. While that source was in its retry loop, its subtask never acknowledged a checkpoint barrier, so every checkpoint of the whole job expired.
4. With zero tolerable checkpoint failures, each expired checkpoint restarted the job.
5. A stop-with-savepoint could not finish either, and the operator never fell back to last-state on its own.

**Fix.**

1. Suspend with `upgradeMode: last-state`, which uses the last good checkpoint.
2. Drop the lost slots.
3. Resume each job from its saved state, one job at a time.

When a job is in a slot retry loop, suspend it with last-state from the start. Alert on checkpoint failures and the job restart count, not only on job state.

### A `flinkConfiguration` change restarts the job

**Status.** Fact.

Any change under `spec.flinkConfiguration` triggers a savepoint upgrade. Put policy that must not restart jobs, such as read-only UI rules, at the ingress or gateway.

### A GET-only gateway still let anyone cancel jobs

**Status.** Fixed in #273.

Flink 2.2 still maps `GET /jobs/:id/yarn-cancel` to a cancel. A reviewer found it with `javap`. The gateway now returns 403 for `yarn-cancel` and `yarn-stop` on every path form, and a CI test asserts it.

### Every image change restarted all five Flink jobs

**Status.** Fixed in #278.

One image tag and one build served studio, the simulator, and Flink, so a studio-only change rolled every Flink job through a savepoint upgrade. `build-images.yml` now detects changes per image. A studio change no longer touches Flink.

### Flink 2.2 and the Postgres CDC connector need guava31

**Status.** Fixed in #266.

Maven dependency mediation dropped `guava31` in favor of Flink's `guava33`. The build now unpacks only the guava31 package into the jar. Adding it as a direct dependency would have removed guava33 from the tests.

## Postgres and CDC replication slots

### CDC slots were invalidated by a write burst

**Status.** Part 1 fixed in #337. Part 2 open.

**Symptom.** After a load test wrote 1.6M rows, all seven `flink_*` slots went to `wal_status=lost`.

**Cause.** Two settings that each look safe contradicted each other:

- `max_slot_wal_keep_size` was 3 GB, set to protect the disk.
- The CDC sources confirmed their position 120 checkpoints late (`scan.lsn-commit.checkpoints-num-delay`), which holds about 1 to 2 hours of WAL so a rollback can replay changes.

At the burst's WAL rate, the hold passed the cap.

**Fix.**

- **Part 1 (#337).** The confirm delay dropped to 10 checkpoints, and the cap rose to 8 GB. The rollout ran in two steps: Postgres first through Argo CD, then the Flink image. Afterwards, every slot was `reserved` and the jobs read a delay of 10. A later 1.59M-row delete wrote about 1 GB of WAL, and slot lag peaked at 1,664 MB, under the cap.
- **Part 2 (open).** Move the busy tables out of the shared publication, so one table's burst stops holding WAL for every slot.

**Facts to remember.**

- Every slot reads the same WAL stream, so one busy table makes all slots hold WAL.
- `wal_status=extended` is not an alarm. Alert on `unreserved` and `lost`.
- Right after a burst, `restart_lsn` can trail `confirmed_flush_lsn` by one confirm cycle. A large restart lag at that moment is expected.

### Manual DDL left new tables owned by the wrong role

**Status.** Fixed by automatic migrations.

**Symptom.** Tables created by hand were owned by `postgres` instead of `cdp`, the role the apps connect as. The first save would have failed with "permission denied". The first attempt also failed earlier, because `/tmp` in the CloudNativePG postgres container is read-only, so `kubectl cp` of a SQL file fails.

**Cause.** The default user inside the container is the superuser. The bootstrap step `schema-owner.yaml`, which hands objects to `cdp`, runs only when the cluster is first created.

**Fix.** Pipe SQL through stdin with `kubectl exec -i … psql -f -`, then run `ALTER TABLE … OWNER TO cdp`. Automatic migrations, below, replaced manual DDL.

### The schema had no way to change after bootstrap

**Status.** Fixed in #379.

`schema.sql` ran once, through CloudNativePG `postInitApplicationSQLRefs`, and every later change was manual. Schema changes now ship as versioned files in `infra/db/migrations/V<NNNN>__<name>.sql`. A Flyway Job runs them on every Argo CD sync, ordered before the apps. The live database was baselined at version 1. CI builds a database from zero and fails on drift or on an edit to a merged migration.

On its first run, the Job wrote baseline row `1` and applied `0002`, which is idempotent with `IF NOT EXISTS`. Every object ended up owned by `cdp`.

Still open: Flyway warns that `initSql` is deprecated. It should move to an `afterConnect` callback.

## Argo CD

### Automated sync undid a manual recovery step

**Status.** Fixed by a merge freeze during recoveries.

**Symptom.** During the CDC recovery, a job that had been suspended went back to running seconds later.

**Cause.**

- A PR merged during the recovery, and Argo CD's automated sync applied it. Turning off self-heal is not enough, because automated sync still applies every new commit.
- A JSON merge patch that sets `syncPolicy.automated.selfHeal` re-creates a removed `automated` key, which turns automated sync back on.

**Fix.** For the whole recovery, freeze merges to the deploy branch and remove `syncPolicy.automated` with a JSON patch. At the end, restore the original policy exactly.

### A manual `kubectl` change to a synced object is reverted

**Status.** Fact.

Every object under `cdp-root` self-heals, so cluster changes go through git: commit to the deploy branch, then refresh Argo CD.

### `policy.default` makes a read-only token read-only everywhere

**Status.** Fact.

Argo CD applies `policy.default` to every subject before the subject's own policy.

### A rollout stalls on a missing secret

**Status.** Fact.

If you merge a PR whose pod needs a secret that does not exist yet, the root app stays `Progressing`. Create the secret, by applying and rerunning bootstrap, before you merge.

## Sign-in: AWS Cognito and OIDC

### Sign-out ended on Cognito's error page

**Status.** Fixed in #393.

**Symptom.** Signing out showed Cognito's "An error was encountered with the requested page". The bug dates from 2026-10-18.

**Cause.** The studio built the standard OIDC logout URL with `post_logout_redirect_uri`. Cognito's `/logout`, which is the discovery document's `end_session_endpoint`, ignores that parameter and honors only `logout_uri`. Without `logout_uri`, Cognito sends the user to its own `/login` with no return address, and that page shows the error.

**How it was found.** Both parameter names were tried against the live user pool with curl:

| Parameter | Cognito redirects to |
|---|---|
| `post_logout_redirect_uri=<studio>/login` | Cognito's own `/login`, which shows the error page |
| `logout_uri=<studio>/login` | the studio's `/login` |

**Fix.** The studio sends `logout_uri` alongside `post_logout_redirect_uri`, with the same value. That value is in the client's allowed `logout_urls`. Test sign-in and sign-out against the real provider, not a mock, because providers that claim the standard still differ.

### A made-up email as a Cognito username

**Status.** Fact.

The temporary password went to an address nobody reads. Use a real email address, or set a permanent password from your own terminal.

## Kubernetes, k3s, and Helm charts

| Issue | Cause | Fix | Status |
|---|---|---|---|
| k3s never installed on the server node | Under `set -o pipefail`, `tr </dev/urandom \| head` died of SIGPIPE and stopped the user-data script | Use `od -N` or `openssl` | Fixed |
| Traefik's HTTP-to-HTTPS redirect was silently ignored | Chart 41 reads `ports.web.http.redirections`, not `ports.web.redirections` | Check the rendered args with `kubectl get deploy -o jsonpath` after any values change | Fixed |
| kafka-ui `/metrics` was open to anyone | kafbat serves it anonymously by default | Blocked, and an acceptance check covers it | Fixed |
| The collector sees Traefik's IP, not the visitor's | ServiceLB SNATs to the pod network without `externalTrafficPolicy: Local` | Set it on the Traefik service in the k3s `HelmChartConfig`. Traefik overwrites `X-Forwarded-For`, which the collector reads (AFP-FR-36) | Fixed |
| Pinning one Flink job's image | The `flink-common` component sets the image for every job | Add a patch to that one FlinkDeployment with the full ECR image, and check it with `kustomize build` | Works |

## CI and GitHub Actions

| Issue | Cause | Fix | Status |
|---|---|---|---|
| OIDC to AWS broke after the repo rename | The trust subject uses numeric owner and repo ids, visible only in CloudTrail. GitHub answers a POST to a renamed repo with 307 | Update the remote and the trust policy, and fix `pr.py` | Fixed |
| A queued deploy was cancelled | A shared concurrency group keeps only one pending job | Use one concurrency group per pipeline | Fixed |
| `validate-deploy` failed with a curl 504 | GitHub's release download failed while fetching kustomize | Rerun the failed job | Fact |
| The bot's tag commits start no workflow | Pushes made with `GITHUB_TOKEN` start no workflow | None needed: the bot commit cannot loop | Fact |
| The built image had a broken transitive dependency | pg8000 was pinned but scramp was not, and scramp 1.5.0 broke SSL connections | Use a hashed lock file, and run tests inside the built image | Fixed |

## Studio (Next.js)

| Issue | Cause | Fix | Status |
|---|---|---|---|
| The first live v2 Data pages confused their owner | The design was approved as text, and nobody saw a screen before the code was written | Approve a clickable draft in the Salarose design system before any code | Fixed (process) |
| Salarose tokens must not change the classic studio | Both studios share one CSS root | The tokens apply under `:root:has([data-salarose])`, which only the v2 shell renders | Fixed in #381 |
| coss `Card` and `Dialog` render a 14.4 px radius instead of the design's 12 px | coss uses `rounded-2xl` | Not yet | Open |

## Development on Windows

| Issue | Cause | Fix | Status |
|---|---|---|---|
| CRLF line endings slipped into committed files | Python text mode on Windows writes CRLF, and Git Bash `grep` cannot count CR | Write with `newline="\n"`, and count CR with `tr -cd '\r' \| wc -c` | Fixed (process) |
| Paths were rewritten for `.exe` tools | Git Bash rewrites arguments that start with `/` | Set `MSYS_NO_PATHCONV=1` and use forward-slash Windows paths | Fixed |
| Free memory dropped below 1 GB during builds | The WSL VM held 2 to 3.6 GB, and each full studio build took about 4 GB | Cap WSL at 4 GB with `autoMemoryReclaim`, run the full suite only in CI, and run only related tests locally | Mitigated |

## AWS Free Plan

| Issue | Fix | Status |
|---|---|---|
| A dry run passed but the real launch failed, because the instance type is not in the Free Tier | Check `describe-instance-types --filters Name=free-tier-eligible,Values=true` before sizing | Fixed |
| Credits lag billing by hours | Judge spend by the projection, not the balance | Fact |
| MSK is closed to Free Plan accounts | Run Kafka with Strimzi | Fact |
| The credit check prints `expiry None` and a negative projection | Not yet | Open; fix before the account closes on 2026-11-14 |

## Ten takeaways

1. **Flink.** Give every stateful operator an explicit uid from the first version, including planner-built ones. Prove a state change by restoring a real savepoint of the old version through the same entry point the cluster uses.
2. **Recover before you fix.** Pin the old image, redeploy from the savepoint, and keep the state. Raw events wait in Kafka.
3. **GitOps.** Change the cluster through git. Freeze merges and automated sync during a recovery.
4. **CDC.** Every slot shares one WAL stream. Size the slot cap against the peak burst, and alert on `lost` and `unreserved`.
5. **Schema.** Use migrations, never manual DDL, and check that objects end up owned by the app role.
6. **Sign-in.** Providers differ from the standard. Test sign-in and sign-out against the real provider.
7. **Rollout checks.** A script that times out has not shown that the system is healthy. Look at every job's state.
8. **Stateful changes.** A green CI and an approval are not enough. Ask for the evidence that matches the risk.
9. **UI.** Show a screen and get it approved before you build it.
10. **Logging.** Write each issue down when you find it. An issue nobody records gets fixed twice.
