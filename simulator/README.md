# Traffic simulator

The traffic simulator sends simulated e-commerce shoppers to a deployed journey engine and reports which pipeline stage or which requirement is broken. Its contract is [docs/internal/features/traffic-simulator.md](../docs/internal/features/traffic-simulator.md). What it does not do yet is in [its known issues](../docs/internal/known-issues/features/traffic-simulator.md).

This version has five commands:

- `smoke` sends one shopper's `sim_view_product` in a POST and `sim_add_to_cart` in a GET pixel. It follows them through the collector, `snowplow-good`, `snowplow-parsed`, `snowplow-parsed-dead-letters`, `customer-profile-mutations`, `journey-engine-matched-events`, `user_campaign_state_transitions`, and `journey-engine-outbound-noti`.
- `logical` plays the six scenarios of the contract: abandoned cart, purchase cancels, identity stitching, duplicate event, invalid event, and structured event.
- `load` sends shoppers from the contract's funnel at a rate profile, and reports per phase what the collector answered, the lag of each pipeline job, and the latency to `snowplow-parsed`.
- `bench` measures how fast one Flink job drains a backlog of its input topic. It suspends the job with a savepoint, fills the topic, and resumes the job.
- `cleanup` lists, and with `--apply` deletes, what runs left behind.

## Fixtures

Before a smoke or logical run sends anything, it makes sure its fixtures exist:

- One catalog event per funnel step, from `sim_view_page` to `sim_purchase`, plus `sim_struct_check` and `sim_gated_check`. The schema gate of `sim_gated_check` is on, and its `sku` attribute is required.
- The campaign `sim_abandoned_cart_<window>s`. A shopper enters on `sim_add_to_cart`. A `sim_purchase` within the window ends the journey. Otherwise the watch times out and a webhook engagement to `https://sim.invalid/abandoned-cart` sends one notification request.
- The metric definition that counts `sim_add_to_cart`. Publishing the campaign creates it, because the setup node holds the condition "`sim_add_to_cart` `COUNT` >= 1 in 1 day". Every shopper who adds to the cart passes it.

The simulator makes fixtures only through studio's own server actions, signed in as the service account `sim_bot` (SIM-FR-17):

1. It reads the `sim_bot` entry, `{user, password}`, of the Secrets Manager secret `cdp-free-plan/logins` with the node role. It never logs the password or passes it in an argument.
2. It starts studio's sign-in at `/api/auth/oidc/login?provider=default`, follows the redirects to Cognito's classic hosted sign-in page, and posts the form with its `_csrf` field. Studio's callback sets the `cdp_admin_session` cookie.
3. It reads each server action's id from the client bundles of `/admin/events`, `/campaign`, and a campaign builder page. The ids change with every studio build.
4. It calls each action as studio's pages do, with a `Next-Action` header and a React Flight reply.

Prepare reads the stored fixtures from Postgres in a read-only session and calls an action only for a fixture that is missing or differs. A campaign's description carries a fingerprint of its journey, so a stored campaign that is active with the same fingerprint is left alone. A second prepare signs in to nothing and writes nothing (SIM-FR-05).

After a publish, the run sends a probe shopper's `sim_add_to_cart` every 15 seconds, for up to 330 seconds, until a probe's transition appears in `user_campaign_state_transitions`. Only a state machine that holds the new graph writes that row. The probe then buys, so it leaves no notification request. After the schema gate changes, a logical run sends a probe event that breaks the gated schema until one reaches the dead-letter topic.

If any fixture fails, the run stops before its shoppers send anything. The report names the fixture and why, marks every stage `not reached` or every expectation `not run`, and ends `incomplete`. The fixture path breaks if Cognito turns on MFA, threat protection, or managed login version 2, or if studio's bundles stop importing an action.

### After you recreate sim-bot

A recreated `sim-bot` is a new studio user, and it cannot republish the `sim_` campaigns the old one published. Studio keys a staff user by the identity provider's issuer and subject, and a new Cognito user has a new subject, so the first sign-in gives it a new user id (`upsertSystemUserFromSignIn` in `shared/lib/db.ts`). Publish updates a stored campaign only when the caller owns it (`publishCampaign` in `shared/lib/db.ts`): the upsert's `WHERE campaigns.created_user = EXCLUDED.created_user` matches no row, and studio answers "Campaign <id> belongs to another user." The rule holds for an admin too. A run whose stored campaign is active and has the same fingerprint publishes nothing, so it still passes. The first run that needs to publish fails its campaign fixture and ends `incomplete`.

To fix it, delete the old fixtures with clean-up, then start a run. Delete lets an admin remove another user's campaign (`lockCampaignForChange` in `shared/lib/db.ts`), and `sim-bot` is in `studio-admin`. Clean-up needs a run id, and any id in the simulator's format works, for example the last run's:

```bash
sed -e "s/SIM_TAG/$tag/" -e "s/SIM_IP_DASHED/$ip/" -e 's/SIM_ARGS/"cleanup", "--run", "<run id>", "--fixtures", "--apply"/' infra/k8s/simulator/job.yaml | k3s kubectl create -f -
```

The next run makes every fixture again, owned by the new user.

## Run smoke or logical on the aws-free-plan cluster

The Job runs in the `cdp` namespace. No kustomization lists `infra/k8s/simulator/job.yaml`, so Argo CD never starts a run.

1. On `platform-1`, pull `deploy/aws-free-plan`, then read the simulator's image tag and the studio host. The `build-simulator` workflow builds `cdp/simulator` on its own, on a push that changes `simulator/`, so a simulator change rolls neither studio nor the Flink jobs. After it pushes the image, it commits the image's tag to `infra/k8s/simulator/image-tag`. That commit starts no workflow, and Argo CD does not watch the folder.

	```bash
	tag=$(cat infra/k8s/simulator/image-tag)
	ip=$(sed -n 's/^IP_DASHED=//p' infra/k8s/envs/aws-free-plan/env.properties)
	```

2. Create the Job. Set the arguments to `"smoke"` or `"logical"`:

	```bash
	sed -e "s/SIM_TAG/$tag/" -e "s/SIM_IP_DASHED/$ip/" -e 's/SIM_ARGS/"smoke"/' infra/k8s/simulator/job.yaml | k3s kubectl create -f -
	```

3. Follow the Job's log until the run ends. `kubectl create` prints the Job's name.

	```bash
	k3s kubectl -n cdp logs -f job/<job name>
	```

The log prints the report as JSON between `----- BEGIN SIM REPORT -----` and `----- END SIM REPORT -----`, then a summary with one line per stage or expectation. The report's `fixtures` field lists the studio writes the run made and the probe results, or the fixture that failed. The pod exits with 0 for `pass`, 1 for `fail`, and 3 for `incomplete`. Kubernetes deletes the Job 7 days after it finishes.

Smoke's last stage waits up to the window longer than the others, because the notification request comes only when the watch times out. The default 60-second window leaves 2 minutes for the other stages within the 3-minute target (SIM-NFR-01). No run has measured it yet. Logical waits for the window plus the stage timeout after its shoppers enter the journey.

To change the window for one run, edit `SIM_SCENARIO_WINDOW_S` in the rendered Job. Each window has its own campaign, `sim_abandoned_cart_<window>s`, so runs with different windows do not republish each other's journey.

## Run load on the aws-free-plan cluster

A load run prepares the same fixtures as smoke, then sends shoppers at a rate profile of four phases. Ramp climbs from 0 to its rate, and steady, peak, and soak hold theirs. The default profile takes 85 minutes:

| Phase | Default | Why |
|---|---|---|
| `--ramp` | `290:300` | Up to the average daily rate, 25 million events a day (SIM-NFR-04), over 5 minutes |
| `--steady` | `290:600` | A 10-minute baseline at that rate |
| `--peak` | `3000:600` | 3,000 events per second for 10 minutes (SIM-NFR-03) |
| `--soak` | `290:3600` | An hour at the average rate (SIM-NFR-04), while the peak's backlog drains |

Each phase takes `EPS:SECONDS`, and 0 seconds skips it. Start the run with `infra/k8s/simulator/load-job.yaml`, which has a 2-hour deadline and the resources a load run needs:

```bash
sed -e "s/SIM_TAG/$tag/" -e "s/SIM_IP_DASHED/$ip/" -e 's/SIM_ARGS/"load"/' infra/k8s/simulator/load-job.yaml | k3s kubectl create -f -
```

For a peak-only run, set the arguments to `"load", "--ramp", "3000:120", "--steady", "0:0", "--soak", "0:0"`. That run ramps to 3,000 over 2 minutes and holds it for 10. For a profile longer than about 105 minutes, raise `activeDeadlineSeconds` in the rendered Job.

Before you start one, check that Prometheus answers the volume query from inside the cluster. A run whose volume reading fails sends nothing. node-exporter's `instance` label is the node's IP and port, and its `nodename` is the EC2 hostname, such as `ip-172-31-14-237.ec2.internal`, not the k3s node name. So the query takes `data-1`'s internal IP from kube-state-metrics' `kube_node_info`. The first query prints each node's hostname and instance. Expect the second to return one series, whose instance is `data-1`'s IP with port 9100, and a value between 0 and 1:

```bash
k3s kubectl -n monitoring get svc kps-kube-prometheus-stack-prometheus
k3s kubectl -n monitoring exec statefulset/prometheus-kps-kube-prometheus-stack-prometheus -c prometheus -- wget -qO- 'http://localhost:9090/api/v1/query' --post-data 'query=node_uname_info'
k3s kubectl -n monitoring exec statefulset/prometheus-kps-kube-prometheus-stack-prometheus -c prometheus -- wget -qO- 'http://localhost:9090/api/v1/query' --post-data 'query=(1 - node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}) * on(instance) group_left() label_replace(kube_node_info{node="data-1"}, "instance", "$1:9100", "internal_ip", "(.*)")'
```

### What a load run sends

The shoppers come from the same personas and funnel as the other modes (`model.browse`): 60% browsers, 25% who add to the cart and leave, 12% who log in and buy, and 3% who come back and buy again. Shopper indexes start at 1000, above the readiness probes. Visits stay whole, so each shopper's events keep their order. Visits go out as POST batches of about `--batch` events, 25 by default, from several shoppers. `--pixel-share` of visits, 5% by default, go out as one GET pixel per event. The default profile sends about 3 million events from about 730,000 shoppers.

The add-to-cart shoppers enter the `sim_abandoned_cart_<window>s` journey, so the load reaches customer decision, the profile writer, the state machine, and the outbox. Clean-up removes the run's rows as for any run, in batches of 5,000 devices. The default profile leaves about 730,000 devices, so expect about 150 batches.

### What a load run measures

Every `--interval` seconds, 15 by default, the log prints one line: the target and sent rates, send errors, the latency p95, dead letters, the simulator's CPU, the lag of each job, and the volumes. The report keeps the lines in `samples`. Each phase in `phases` reports:

- Events sent, send errors, and the collector's responses by status, with response time percentiles.
- The target events, the events sent, and the achieved rate. The sender kept up when it sent 99% of the target and its requests started within 1 second of their due time at p99. When it did not, the phase names the limiter: the collector, when every connection was busy while the sender owed events, or the sender, when the simulator used 0.85 cores or more. One Python process uses one core at most.
- The latency from send to `snowplow-parsed`, from one event in `--sample-every` (20). The run tail reads `snowplow-parsed` from its end, so the latency includes how far the tail is behind. Each sample line gives that distance as `tail_behind`.
- The lag of `event-processor-group` on `snowplow-good`, `customer-decision-events` on `snowplow-parsed`, `customer-profile-writer` on `customer-profile-mutations`, and `campaign-state-machine-group` on `journey-engine-matched-events`: end offsets minus committed offsets. Flink commits offsets on each checkpoint, so lag is current to the last checkpoint.
- The fullest each volume got.

A phase passes when its send errors stay under 1% and the sender kept up. Lag and latency are reported, not judged.

After the profile, the run waits up to `--drain` seconds, 300 by default, until every event the collector accepted reached `snowplow-parsed` or the dead letters. The check `Every event the collector accepted reached snowplow-parsed or the dead letters` fails with the missing count if some did not (SIM-FR-24).

### Stop conditions

At each reading, the run stops sending and fails when (SIM-FR-12):

- The Kafka volume is over 70% full. Kafka's and Postgres's volumes are local-path claims on `data-1`'s root filesystem, which does not hold a claim to its size. The reading is that filesystem's use, from `SIM_VOLUME_QUERY` against Prometheus.
- The Postgres volume is over 70% full: the larger of that filesystem's use and Postgres's own bytes against its 8 GiB claim. Its own bytes are the database's size plus the WAL its replication slots hold back.
- More than 1% of the events the collector accepted reached `snowplow-parsed-dead-letters`.

A gauge it cannot read before it sends keeps the run from starting, and the run ends `incomplete`. Three readings in a row without one stop the run. A reading that has not finished after 15 seconds counts as one without any gauge, and the next one does not start while it still runs, so a hung broker or database cannot keep the stop conditions from being checked. Each Kafka request gives up after 10 seconds.

### Sizing

The sender's CPU was measured on a laptop, sending to a stand-in collector in another process, before the pacer built hits one at a time. At 3,000 events per second for 30 seconds it sent 100% of the target in each of three runs, and used 0.14, 0.25, and 0.28 cores. At 9,000 events per second it used 0.45 cores. The pacer now also finds each hit's due time by bisection, about 5,000 lookups a second at 3,000 events per second, which no run has measured. The run tail adds the cost of reading every `snowplow-parsed` record, which no benchmark has measured. `load-job.yaml` requests 500m CPU and 256Mi memory, with a 512Mi memory limit and no CPU limit. The five Flink jobs request 3.75 cores of the four 2-core compute nodes, so a compute node with 500m free exists. Each phase reports the simulator's CPU, so a run that the sender held back says so. When the collector is slower than the target, the pacer builds a hit only when it can queue it and keeps what it owes as a count, so memory stays flat. Events still owed a second after the profile ends are not sent: the phase reports them as a share of its target below 99%.

## Run bench on the aws-free-plan cluster

A bench run measures one Flink job's drain rate: how many records of its input topic it processes per second while it works through a backlog. Each run suspends the job with a savepoint, sends shoppers until the input topic holds the backlog, waits until the topic's end offset holds still, resumes the job from that savepoint, and times the drain. The sender stops before the resume, so it is never what limits the number.

| `--job` | Input topic | Consumer group |
|---|---|---|
| `event-parse-job` | `snowplow-good` | `event-processor-group` |
| `customer-decision-job` | `snowplow-parsed` | `customer-decision-events` |
| `customer-profile-writer-job` | `customer-profile-mutations` | `customer-profile-writer` |
| `campaign-state-machine-job` | `journey-engine-matched-events` | `campaign-state-machine-group` |

`--backlog` counts input records. A record of `snowplow-good` is one collector request, which holds a POST's whole batch. So for `event-parse-job`, pass `--batch 1` or expect about 25 events per record. Each run reports `events_per_record`.

### Before you start

1. Freeze merges to `deploy/aws-free-plan` until the bench ends. The bench turns off Argo CD's automated sync of `cdp-root`, but a manual sync still deploys whatever was merged.
2. Check that every job checkpoints and every replication slot is reserved. The bench checks both and refuses when either fails, but only after its prepare, which can take 6 minutes.
3. Apply the bench's permissions:

	```bash
	k3s kubectl apply -f infra/k8s/simulator/bench-rbac.yaml
	```

	The Job runs as the service account `sim-bench`. In `cdp` it may get the five FlinkDeployments, patch the four jobs above, create Leases, and get and delete the Lease `cdp-sim-bench`. In `argocd` it may get and patch the Application `cdp-root`. Nothing else. After the bench, delete the same objects with `k3s kubectl delete -f infra/k8s/simulator/bench-rbac.yaml`.

### Start it

```bash
sed -e "s/SIM_TAG/$tag/" -e "s/SIM_IP_DASHED/$ip/" \
  -e 's/SIM_ARGS/"bench", "--job", "customer-decision-job", "--backlog", "200000"/' \
  infra/k8s/simulator/bench-job.yaml | k3s kubectl create -f -
```

| Option | Default | Meaning |
|---|---|---|
| `--backlog` | required | Input records to drain in each run |
| `--runs` | `5` | Measured runs. A comparison needs at least 5 per side (SIM-FR-23). |
| `--fill-eps` | `1000` | Events per second while filling. The load run that invalidated every replication slot ran at 3,000. |
| `--probe-backlog` | `20000` | The backlog of a first probe run, which is not counted. It runs only when `--backlog` is larger. |
| `--batch`, `--connections` | `25`, `32` | As for load |
| `--interval` | `5` | Seconds between readings |
| `--settle` | `60` | Seconds the input topic's end offset must hold still before the resume, so upstream jobs have caught up |
| `--fill-timeout`, `--drain-timeout` | `3600` | The longest fill and the longest drain, in seconds |

One run takes up to 15 minutes for its savepoint, then its fill, a minute to settle, up to 10 minutes to restart, and its drain. `bench-job.yaml` has a 6-hour deadline. For more, raise `activeDeadlineSeconds` in the rendered Job. On the deadline, Kubernetes sends SIGTERM and allows 15 minutes, in which the bench resumes the job it suspended and prints its report.

### What keeps the cluster safe

- **One bench at a time.** The bench first creates the Lease `cdp/cdp-sim-bench`, holding its run id, and deletes it on every way out. A second bench finds the Lease, refuses, and names the holder. A bench killed before its clean-up, as by a second SIGTERM past the grace period, leaves the Lease behind. Check that no bench Job runs, then `k3s kubectl -n cdp delete lease cdp-sim-bench`.
- **Argo CD cannot undo a suspend.** Before the first suspend, the bench reads `cdp-root`'s `spec.syncPolicy.automated` and removes it with a JSON patch whose `test` op fails if the value changed. Every step after that runs inside the block that puts the same value back, with a `test` on the whole sync policy, and reports. It never sends a merge patch, which would create `automated` where it was missing. If the freeze itself fails, the bench puts nothing back: a failed `test` op means another actor changed `automated`, and the bench restores only what it removed. The report then compares the value it read with the value now. It refuses to start when `automated` is already gone, because whoever removed it may put it back mid-bench. It refuses to start while any FlinkDeployment is suspended, because restoring the sync would start that job.
- **Only a healthy job is suspended.** Before each suspend, the job must be `STABLE` and `RUNNING`, its last checkpoint must be under three checkpoint intervals old, and none of its last five checkpoints may have failed. A job that cannot checkpoint cannot take a savepoint.
- **A savepoint that does not complete in 15 minutes** sets the job back to `running`. The operator would otherwise retry it for ever. The operator applies that change only after its current savepoint attempt ends, which may still stop the job. So the bench restores Argo CD only once the job is `STABLE` and `RUNNING` with `running` as its last reconciled state. Otherwise it leaves the sync off and says what to check.
- **Every resume is checked.** The bench resumes only when the job's `upgradeSavepointPath` is still the savepoint it took. Once the job is `STABLE` and `RUNNING`, the bench reads Flink's `latest.restored` checkpoint and fails the run if it is not that savepoint.
- **If the bench cannot confirm a resume**, it leaves Argo CD's sync off. The report's Argo CD check names the job, its savepoint, and the `automated` value to put back. When the bench already set the job running, the check says so, and says to check the restored checkpoint rather than resume again.
- **The WAL cap holds.** The bench reads `max_slot_wal_keep_size` from `pg_settings` at every reading and never assumes it. An unreadable or unlimited cap stops it. Every reading checks the load run's stop conditions, and also the WAL the replication slots hold against the cap. Over 70%, or with a slot whose `wal_status` is not `reserved` or `extended`, the bench stops.
- **A run starts only when its WAL fits.** When `--backlog` is larger than `--probe-backlog`, the probe run measures the WAL a record costs over the whole run: from the fill's start, through the upstream jobs' writes, the drain, and the downstream jobs' writes, until WAL grows no faster than before the bench. Each later run raises that cost if it measured more. Before each run, the WAL the slots already hold plus that cost times the backlog must fit under half the cap. Before any run has measured the cost, as for the probe or a run no larger than `--probe-backlog`, the bench uses an estimate of 4 KiB per event, twice the WAL per event of the load run that invalidated the slots. A record of `snowplow-good` counts as `--batch` events. The slots keep WAL until the CDC sources confirm it, so earlier runs' WAL counts until they let it go. The bench waits up to 30 minutes for that, then refuses and gives the largest safe `--backlog`, or `--probe-backlog` for the probe.
- **The fill stops before the cap.** At every fill reading, the bench projects the rest of the run's WAL from the rate the fill writes WAL now, plus the drain's measured cost. When the held WAL plus that projection would pass 70% of the cap, it stops the fill, resumes the job, and restores Argo CD. The job drains what was queued, which the projection already counted.

### What a bench run reports

Each run is one entry in `phases`, named `probe` or `run <n>`, with these metrics:

- The fill: events sent, send errors, accepted events, and how long it took.
- The savepoint, where the job restored from, the backlog, the records consumed, and `input_end_growth`, the records that arrived during the drain.
- `drain_s`, from the job's `RUNNING` timestamp to the reading that saw the backlog consumed, `drain_rate` in records per second, and `resolution_s`. The job commits its offsets only on a checkpoint, so `drain_s` runs long by up to a reading and a checkpoint interval (SIM-KI-14).
- Each operator's average busy and backpressured time, in ms per second. The TaskManagers' CPU, and the most memory they used.
- The checkpoints completed and failed, the last one's duration and size, restarts, exceptions, the WAL written during the drain (`wal_bytes_drain`) and over the whole run (`wal_bytes_run`), and the run's WAL per record.
- `limiter`: the busiest operator that is not backpressured, and whether it is CPU-bound. A subtask that uses 0.8 cores or more is CPU-bound. One that uses less is waiting on something else, such as Postgres or Kafka.

`measurements` gives the drain rate over the counted runs: its unit, the run count, every value, the median and range, and the limiter. When the runs do not all name the same limiter, the number is `inconclusive` and the verdict `incomplete` (SIM-FR-22).

The checks confirm that:

- Each run resumed from its own savepoint (SIM-FR-21).
- Each run consumed its backlog with no exception, restart, or failed checkpoint (SIM-FR-24). For `event-parse-job`, every accepted event must also reach `snowplow-parsed` or the dead letters (SIM-KI-13).
- No input arrived during a drain (SIM-FR-25).
- The job ran with the deployed image, parallelism, state backend, and resources, and the bench changed nothing but its state (SIM-FR-27).
- Argo CD's automated sync is back as it was.
- The bench lock is released.

## Clean up after runs

Clean-up takes one or more run ids. Without `--apply`, it only lists what it would delete. A delete cannot be undone, so read the list first.

```bash
sed -e "s/SIM_TAG/$tag/" -e "s/SIM_IP_DASHED/$ip/" -e 's/SIM_ARGS/"cleanup", "--run", "<run id>"/' infra/k8s/simulator/job.yaml | k3s kubectl create -f -
```

Add `"--apply"` to delete, and `"--fixtures"` to delete every `sim_` campaign and catalog event as well. Without `--apply` the output gives the rows it would delete under `rows`, and with it the rows it deleted under `deleted`. Clean-up deletes only these rows:

- `user_campaign_state_transitions` rows in a `sim_` campaign whose device id is `sim-<run id>-*` or whose canon_id is derived from the run's device or user ids.
- `user_metrics` rows with such a canon_id, for a metric definition of a `sim_` event.
- `identity_graph` rows whose device id is `sim-<run id>-*`.

It reads the run's `identity_graph` rows 5,000 devices at a time, in device id order, and deletes each batch's rows in its own transaction. So its memory and each transaction stay small whatever the run's size, and the 256Mi clean-up Job fits a load run. If it fails part way, the batches before the failure stay deleted. Run it again with the same run id to finish.

With `--fixtures`, it calls studio's `deleteCampaignAction` for each `sim_` campaign and `deleteUserEventAction` for each `sim_` catalog event. Deleting a catalog event also deletes its attributes, its metric definitions, and their `user_metrics` rows. Studio's answer is not trusted: clean-up then reads the `sim_` campaigns and catalog events again, lists each one still there under `not_deleted` with studio's errors, and exits 1 if any remain. Run it only when no other run is active (SIM-KI-07). Kafka records stay until each topic's retention removes them.

## What a run reads and writes

- It sends tracker hits to `http://collector.cdp.svc`. Every event name starts with `sim_`. Every event carries the run id in its data and in an `io.cdp.sim/run` entity. Device ids are `sim-<run id>-d<n>`, and user ids are `sim-<run id>-u<n>`.
- It reads topics with the consumer group `sim-<run id>-<topic>`. It assigns partitions by hand, starts at their end offsets, and never commits, so it does not move a pipeline job's offsets.
- It reads Postgres at `cdp-pg-rw.cdp.svc` with the `cdp-pg-app` secret, in sessions set to read-only. It reads the `sim_` rows of `user_events`, `user_event_fields`, `campaigns`, and `user_metric_definitions`, and the transitions of its own shoppers in `sim_` campaigns. Only `cleanup --apply` opens a writable session.
- It writes catalog events and campaigns only through studio.
- A bench run changes only `spec.job.state` of the job it measures and `spec.syncPolicy.automated` of `cdp-root`, and creates and deletes the Lease `cdp/cdp-sim-bench`. It reads the Flink REST API at `http://<job>-rest.cdp.svc:8081`, reads `pg_current_wal_lsn`, `pg_replication_slots`, and `pg_settings` in its read-only session, and reads the TaskManagers' CPU and memory from Prometheus. Its run tail uses the group `sim-<run id>-bench`.
- A load run also reads the committed offsets of the four pipeline groups that its lag covers, without joining them. It reads `pg_database_size` and `pg_replication_slots` in its read-only session, and queries Prometheus over HTTP. Its run tail uses the group `sim-<run id>-load`.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `SIM_COLLECTOR_URL` | `http://collector.cdp.svc` | The collector's base URL |
| `SIM_KAFKA_BROKERS` | `cdp-kafka-bootstrap.cdp.svc:9092` | Kafka bootstrap servers |
| `SIM_STUDIO_URL` | unset | Studio's public URL. The sign-in callback and the server actions' origin check use the public host. |
| `SIM_LOGIN_SECRET_ID` | `cdp-free-plan/logins` | The Secrets Manager secret that holds the service account |
| `SIM_LOGIN_SECRET_ENTRY` | `sim_bot` | The secret's entry with `user` and `password` |
| `SIM_REPORT_BUCKET` | unset | The bucket for `sim-reports/`. When unset, the report goes only to the log. |
| `SIM_STAGE_TIMEOUT_S` | `45` | How long a stage or an expectation waits |
| `SIM_SCENARIO_WINDOW_S` | `60` | The abandoned-cart campaign's watch window, in whole seconds (SIM-FR-18) |
| `SIM_PROMETHEUS_URL` | `http://kps-kube-prometheus-stack-prometheus.monitoring.svc:9090` | Prometheus, for a load run's volume reading |
| `SIM_VOLUME_QUERY` | `data-1`'s root filesystem use | The PromQL whose largest value is the share of the data node's filesystem in use |
| `SIM_PG_VOLUME_BYTES` | `8589934592` | The Postgres claim's size, which Postgres's own bytes count against |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | `PGPORT` is `5432` | Postgres. The Job fills them from `cdp-pg-app`. |

## Where reports go

Each run puts its report at `s3://cdp-free-plan-582577265946/sim-reports/<run id>.json` with the node's instance role. The report's `storage` field says whether the upload worked, and why not. The log always holds the full report. Until the node role can write under `sim-reports/`, the upload fails with `AccessDenied` (SIM-KI-03).

## Test the simulator

The tests read `studio/app/actions.ts` and `studio/src/entities/journey/model/parseCampaign.ts`, so run them from a full checkout. Install from the lock, then run them from `simulator/`:

```bash
cd simulator
pip install --require-hashes -r requirements-test.lock
python -m pytest -q
```

CI runs the same tests inside the built image, so they see the packages the image ships. `build-simulator` pushes only an image that passed them. To test an image the same way:

```bash
docker build -t cdp-sim simulator
sh simulator/test-image.sh cdp-sim
```

`test_dependencies.py` signs in to a local TLS server that offers `SCRAM-SHA-256-PLUS`, as CloudNativePG does, so it runs pg8000's channel-binding path. The test makes its certificate at run time with trustme.

`simulator/tests/fixtures/` holds a Cognito classic hosted sign-in page with its tokens replaced, studio's public login page, and two client chunks of a studio build on the same Next.js version.

## Change a dependency

The image installs `requirements.lock` and nothing else, with a hash for every package, direct and transitive. `requirements-test.lock` adds pytest and trustme, with the image's packages at the same versions. An unpinned transitive package once broke every Postgres connection. pg8000 1.31.5 allowed any scramp from 1.4.5 up, and scramp 1.5.0 removed the function pg8000 1.31.5 calls on a TLS connection.

To change a version, edit the pin in `pyproject.toml`, then regenerate both locks from `simulator/` with [uv](https://docs.astral.sh/uv/):

```bash
uv pip compile pyproject.toml --universal --python-version 3.11 --generate-hashes --no-header -o requirements.lock
uv pip compile pyproject.toml --extra test -c requirements.lock --universal --python-version 3.11 --generate-hashes --no-header -o requirements-test.lock
```

A test fails when a pin in `pyproject.toml` differs from the lock, or when an installed package differs from it.

