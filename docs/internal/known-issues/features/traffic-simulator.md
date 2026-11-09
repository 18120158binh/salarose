---
title: Traffic simulator known issues
contract: ../../features/traffic-simulator.md
updated: 2026-11-08
verified_at: 510de68b
---

# Traffic simulator known issues

Python paths are relative to `simulator/cdp_sim/`. This version builds smoke, logical, load, clean-up, and the bench's backlog drain for four Flink jobs.

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| SIM-KI-03 | Missing | The report does not reach S3 on aws-free-plan | SIM-FR-19 |
| SIM-KI-07 | Departure | Two runs that change fixtures at the same time can change each other's verdicts | SIM-FR-13 |
| SIM-KI-08 | Departure | Prepare sends probe events before it reports that a fixture failed | Failure handling |
| SIM-KI-09 | Missing | A load run measures only part of the Load column of the test architecture | Test architecture |
| SIM-KI-10 | Departure | A load run reads the data node's filesystem, not the Kafka volume | SIM-FR-12 |
| SIM-KI-11 | Departure | The dead-letter stop condition does not count a payload dropped whole | SIM-FR-12 |
| SIM-KI-12 | Missing | Bench has no recovery, scaling, state-growth, collector, or outbox run | SIM-FR-23, SIM-FR-25, SIM-FR-26 |
| SIM-KI-13 | Departure | A bench run confirms output event by event only for event parse | SIM-FR-24 |
| SIM-KI-14 | Departure | A drain rate runs low by up to a reading and a checkpoint interval | SIM-FR-22 |

## SIM-KI-03. The report does not reach S3 on aws-free-plan

- **Symptom.** The report's `storage` field holds `AccessDenied`. The pod log holds the only copy, and the log goes when Kubernetes deletes the Job.
- **Evidence.** Runs `20261107t125904-8d8367` and `20261107t130341-c2d420` got `AccessDenied` on `s3:PutObject` for `sim-reports/<run id>.json` as `assumed-role/cdp-free-plan-node`.
- **Cause.** The node role `cdp-free-plan-node` in AWS still allows `s3:PutObject` only under `flink/`. This branch adds a statement to its inline policy in `infra/aws-free-plan/terraform/base.tf` that allows `s3:GetObject` and `s3:PutObject` on `${aws_s3_bucket.flink.arn}/sim-reports/*`. Nobody has applied it yet.
- **Fix direction.** Apply the Terraform change, then run smoke and check that the report's `storage` field names the S3 object.

## SIM-KI-07. Two runs that change fixtures at the same time can change each other's verdicts

- **Symptom.** A run's journey expectations fail while another run prepares or cleans up.
- **Cause.** `fixtures.prepare` publishes the campaign when its stored row differs from the wanted one. Two runs that start with a missing or changed campaign both publish it, and each publish writes a new graph version. Journey execution drops a trigger decided against an older version (JEX-FR-17), so the first run's shoppers can miss their journey. `cleanup --fixtures --apply` deletes the campaign under any run that is still checking it.
- **Fix direction.** Prepare once before starting concurrent runs, and clean up fixtures only when no run is active. A lock around prepare, such as a Postgres advisory lock held through studio, would need a studio change.

## SIM-KI-08. Prepare sends probe events before it reports that a fixture failed

- **Symptom.** A run whose fixtures fail can still have sent `sim_add_to_cart`, `sim_purchase`, or `sim_gated_check` events from shoppers `sim-<run id>-d900` onward and `sim-<run id>-d950` onward.
- **Cause.** After prepare publishes the campaign or turns the schema gate on, `readiness.await_graph` and `readiness.await_gate` send probe shoppers until the engine shows that it applied the change. The probes are part of preparing a fixture, so a probe that times out fails the fixture after the probes were sent. The run's own shoppers send nothing.
- **Fix direction.** Keep the probes, which are the only signal that the engine holds a new graph, and change the contract's Failure handling to say that probes may have been sent. Clean-up removes the probes' rows with the run's rows.

## SIM-KI-09. A load run measures only part of the Load column of the test architecture

- **Symptom.** A load report has no Postgres write latency or replication-slot lag of its own. It has no Kafka produce or consume rates or disk use per topic, and no delay from a transition row to its notification request. It has every measurement SIM-FR-11 names.
- **Cause.** `load.phase_metrics` reports what SIM-FR-11 requires, plus the lag of the parse job and the profile writer. The slot's held-back WAL counts only toward the Postgres volume reading (`gauges.postgres_bytes`), and is not reported as a lag.
- **Fix direction.** Read the rest from Prometheus with the same client as `gauges.prometheus_value`, once the Flink, Kafka, and Postgres exporters' metric names are checked on the cluster.

## SIM-KI-10. A load run reads the data node's filesystem, not the Kafka volume

- **Symptom.** The Kafka volume reading is the share of `data-1`'s root filesystem in use, not the share of Kafka's 6 GiB claim.
- **Cause.** Kafka's and Postgres's claims use the `local-path` storage class, which keeps each claim in a directory on the node's root filesystem and does not hold it to its size. Kafka 4 no longer serves the `DescribeLogDirs` version that kafka-python 2.3.3 sends, so the simulator cannot read Kafka's own log size (inferred from KIP-896, not run against the cluster). `gauges.Volumes` reads the filesystem with `SIM_VOLUME_QUERY` from Prometheus. Postgres takes the larger of that and its own bytes against its 8 GiB claim.
- **Fix direction.** Read Kafka's log size from a Kafka exporter in Prometheus, if the cluster gets one, and compare it with the claim's size.

## SIM-KI-11. The dead-letter stop condition does not count a payload dropped whole

- **Symptom.** When ingestion drops a whole collector payload, such as `PAYLOAD_NOT_DECODED`, a load run does not count its events as dead letters, so they do not count toward the 1% stop condition. Events dropped one by one are counted.
- **Cause.** `gauges.RunCount` counts a record of `snowplow-parsed-dead-letters` when its bytes hold the run id. An `event` record holds the event as JSON, with the run id in plain text. A `payload` record holds the collector payload only as Base64 Thrift. A payload whose events were dropped one by one also writes a `payload` record, so counting `payload` records would count those events twice. And one record stands for every event in the payload.
- **Fix direction.** For a `payload` record with a drop reason, decode the Base64 Thrift, read the events from its body, and count those that carry the run id.

## SIM-KI-12. Bench has no recovery, scaling, state-growth, collector, or outbox run

- **Symptom.** `python -m cdp_sim bench` measures only the drain rate of `event-parse-job`, `customer-decision-job`, `customer-profile-writer-job`, or `campaign-state-machine-job`. No run stops a TaskManager pod, changes parallelism, grows state, ramps the collector, or bursts transitions into the outbox.
- **Cause.** The first bench round built suspend, fill, and resume, which the backlog drain needs. The other runs need more cluster permissions than `infra/k8s/simulator/bench-rbac.yaml` grants: deleting pods for recovery, and patching `spec.job.parallelism` for scaling. The outbox reads its input through CDC, so it has no Kafka backlog to fill. `report.Measurement` reports a number's runs, median, and range, but nothing compares two sides yet.
- **Fix direction.** Add each run on `bench.Bench` with its own permission in `bench-rbac.yaml`. A scaling comparison alternates the sides over at least 5 runs each, and reports no measurable difference when the medians differ by less than the run-to-run range.

## SIM-KI-13. A bench run confirms output event by event only for event parse

- **Symptom.** For `event-parse-job`, the delivery check counts the run's events on `snowplow-parsed` and the dead letters against the events the collector accepted. For the other three jobs it checks only that the job consumed its whole backlog with no exception, restart, or failed checkpoint.
- **Cause.** Customer decision, the profile writer, and the state machine do not write one output per input. A shopper's event may match no journey, and a metric mutation updates a row in place. `bench.COUNTED_OUTPUT` names the one job whose output maps one to one.
- **Fix direction.** Predict each job's output from the run's shoppers, as the logical scenarios do, and count it on the job's output topic or table.

## SIM-KI-14. A drain rate runs low by up to a reading and a checkpoint interval

- **Symptom.** A bench run's `drain_rate` is the consumed records over the time from the job's `RUNNING` timestamp to the first reading that sees the backlog consumed. A short drain reads low.
- **Cause.** The bench reads the job's progress from its consumer group's committed offsets, and Flink commits them only when a checkpoint completes, every 30 seconds on aws-free-plan. The bench reads every `--interval` seconds, 5 by default. Each run reports this as `resolution_s`. Transaction markers on a topic that a job writes with exactly-once also count as records.
- **Fix direction.** Size the backlog so the drain takes many checkpoint intervals, or read the source's own consumed-records metric from Flink's REST API.
