---
title: Business event fan-out known issues
contract: ../../architecture/components/business-event-fan-out.md
updated: 2026-11-14
verified_at: 5ee5ce0
---

# Business event fan-out known issues

The job is built: `BusinessEventFanoutJob` in `event-processor/src/main/java/com/cdp/platform/jobs/businessfanout/` keeps the interest and segment member indexes and reads `business-events` and writes `business-event-matches`, which `infra/k8s/data/topics.yaml` declares. Nothing runs it yet, and nothing reads its output: customer decision does not read matches (DEC-KI-41).

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| BEF-KI-01 | Blocking | No deployment runs the job | BEF-FR-01, BEF-NFR-04 |

## BEF-KI-01. No deployment runs the job

- **Symptom.** A business event reaches no one on the cluster.
- **Cause.** `infra/k8s/apps/` has no FlinkDeployment for `com.cdp.platform.jobs.businessfanout.BusinessEventFanoutJob`, and the job's CDC slots `flink_fanout_campaigns_slot` and `flink_fanout_campaign_nodes_slot` are created only when it first runs.
- **Evidence.** Read from the code at `5ee5ce0`: `infra/k8s/apps/flink-decision/` deploys customer decision only.
- **Fix direction.** Add a FlinkDeployment beside `flink-decision`, with the variables in [configuration](../../operations/configuration.md#business-event-fan-out), once customer decision reads matches.

