# Monitoring

The Flink jobs count what they drop in operator metrics. This page lists the journey engine's counters, how to export them to Prometheus, and which ones to alert on. The repo holds example settings in [infra/monitoring](../../../infra/monitoring). The cluster's Flink configuration and Prometheus setup live in the Argo CD repo, which this repo cannot see, so apply the examples there.

## State machine counters

The state machine operator, `Immediate Keyed Journey BFS` in the job `campaign-state-machine-job`, and its trigger source, `state_machine_journey_triggers`, count each kind of drop. The trigger source keeps `invalidMatchedEvents` in its `deserializer` group, so Prometheus exports it as `flink_taskmanager_job_task_operator_deserializer_invalidMatchedEvents`. This name is inferred from Flink's metric scopes, not checked on the cluster.

| Counter | Counts | Alert |
|---|---|---|
| `lateMatchedEvents` | Triggers at or before the watermark when they arrived. Customer decision fell more than the allowed out-of-orderness behind. | Yes, critical. [JEX-NFR-08](../architecture/components/journey-execution.md#non-functional-requirements) requires it. |
| `invalidMatchedEvents` | Trigger messages that are not a JSON object or have a field of the wrong type, and triggers without `canon_id`, `campaign_id`, `node_id`, or an event time. The log names each trigger without a key field. For a message that does not decode, it gives only the kind of error, not the message. | Yes, warning |
| `unreachableMatchedEvents` | Triggers whose parent never completed before the watermark passed them, whose node stayed missing past the graph-load allowance, or that were decided against a graph a later publish replaced | No. It rises after a marketer deletes a campaign with journeys in progress, or publishes one again. |
| `wrongBranchMatchedEvents` | Triggers whose parent completed on another branch than their node hangs off | No |
| `stateLimitDroppedMatchedEvents` | Triggers that would push a journey's buffer over its count or size limit | No |

Each counter starts again at 0 when the job restarts.

## Customer decision counters

The operator `Apply Behavior State and Select Candidates` in the job `customer-decision-job` counts the parsed events it drops.

| Counter | Counts | Alert |
|---|---|---|
| `invalidParsedEvents` | Events on `snowplow-parsed` without an `event_id`, an `event_name`, or an `event_timestamp`, or with a blank `event_id`. A field of the wrong type, such as an `event_timestamp` that is not a number, reads as missing. The source skips a message that is not JSON, and no counter counts it. An event without a `canon_id` is dropped before the operator and is not counted either. | No |

The counter starts again at 0 when the job restarts.

## Export the metrics

Flink exports metrics only through a reporter, and the repo configured none before this page. Without one, the counters show only in the Flink web UI.

1. Add the two settings in [flink-prometheus-reporter.yaml](../../../infra/monitoring/flink-prometheus-reporter.yaml) to the Flink configuration of each job, in the Argo CD repo. The reporter ships with Flink under `plugins/metrics-prometheus`, so the image needs no new jar. This is inferred from the Flink distribution, not checked on the image.
2. Let Prometheus scrape port 9249 on the JobManager and TaskManager pods, for example with a `PodMonitor`.
3. Check that `flink_taskmanager_job_task_operator_lateMatchedEvents` appears with `job_name="campaign-state-machine-job"`.

The reporter is a cluster setting, not part of a job graph, so it needs no savepoint change. A JobManager or TaskManager picks it up when it restarts.

## Alert

[journey-engine-alerts.yaml](../../../infra/monitoring/journey-engine-alerts.yaml) is a `PrometheusRule` with two alerts:

- `JourneyTriggersDroppedAsLate` fires when `lateMatchedEvents` rose in the last 10 minutes. Those triggers are lost, so the people they belong to do not move on for those events. Check customer decision's consumer lag and its checkpoints first. See [decision 0008](../architecture/decisions/0008-one-trigger-watermark-for-both-producers.md).
- `JourneyTriggersInvalid` fires when `invalidMatchedEvents` rose in the last 10 minutes. Look up the dropped triggers in the state machine log, under `Dropping trigger` and `Dropping a trigger that does not decode`. The rule matches the counter with and without the `deserializer` group, so it works before and after the [trigger decoding](deployment.md#state-machine-trigger-decoding) deploy.
