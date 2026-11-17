---
title: Run the dev environment on one stoppable Spot node and pay-per-use services
id: "0055"
status: accepted
date: 2026-11-17
tags: [deployment, aws, kubernetes, cost, environment]
supersedes: []
superseded_by: []
---

# 0055. Run the dev environment on one stoppable Spot node and pay-per-use services

## Context

The platform's only environment was the [AWS Free Plan cluster](../../operations/aws-free-plan.md): six `m7i-flex.large` nodes running k3s all day, about $450 a month, with almost no real load. The Free Plan account closed on 2026-11-14. The next deploy goes to a paid account.

There is only a dev environment, used by one person, part of the day. Nobody needs it running while nobody uses it. The owner wants it as cheap as possible, and wants to keep Kubernetes, to keep learning it.

The storage design of decisions [0052](0052-keep-hot-state-in-flink-and-a-redesigned-projection-in-postgres.md), [0053](0053-store-raw-events-transition-history-and-imports-in-an-iceberg-lakehouse.md), and [0054](0054-recover-flink-state-in-four-layers.md) applies: Postgres for configuration and the projection, Flink state as the source of truth with four recovery layers, and an Iceberg lakehouse on S3. Decision 0053 allows AWS managed services and leaves the choice to the deployment.

## Decision

The dev environment runs on one EC2 Spot instance with k3s as a single node, and on AWS services that charge only for what is stored or used. The [dev environment contract](../../operations/dev-environment.md) holds the rules.

1. **Self-host the streaming core.** Kafka (Strimzi), Postgres (CloudNativePG), the Flink Kubernetes Operator and the five jobs, studio, the collector, Argo CD, and a light Prometheus and Grafana run on the node. Managed services are used where they cost nothing while idle: S3, the Iceberg catalog and Athena, ECR, Cognito, Secrets Manager or Parameter Store, and AWS Budgets.
2. **Keep Kubernetes.** k3s on one node, Argo CD GitOps, and savepoint upgrades through the Flink operator, as on the Free Plan cluster.
3. **Stop when nobody uses it.** After 30 minutes without use, the node takes a savepoint of every Flink job and stops. It also stops 12 hours after a start, whatever the activity. One command starts it again in 5 to 10 minutes.
4. **Keep state outside the node.** One persistent EBS volume holds the Kafka, Postgres, and cluster data and is attached to each new node. Flink checkpoints and savepoints stay in S3. One Elastic IP, kept while stopped, gives every start the same hostnames, certificates, and Cognito URLs.
5. **Start empty.** The new account gets a fresh bootstrap, and the Flink jobs start clean. Nothing moves from the closed Free Plan account.
6. **Lose events sent while off.** Only the simulator sends events, and only while the owner uses the environment, so no buffer sits in front of the collector.

The owner made each of these choices on 2026-11-17.

## Why

**Nobody uses the environment most of the day.** The six-node cluster billed every hour. A dev environment used about 8 hours on working days needs compute for about a quarter of the month. Stopping the node turns the largest cost into one that tracks use. While stopped, the bill is the volume, its snapshots, S3, and the Elastic IP.

**The managed streaming services bill by the hour whether used or not.** The owner weighed these costs:

- MSK Serverless costs about $540 a month before any traffic.
- Managed Service for Apache Flink costs about $800 a month for five jobs.
- Aurora Serverless v2 cannot pause automatically while Flink CDC holds a replication connection, and the CDC sources hold one for as long as the jobs run.

MSK Serverless or Managed Flink alone costs more than the whole six-node cluster. S3, ECR, Cognito, Athena, and the catalog charge for storage and requests, so they cost cents while the environment is stopped.

**Kubernetes is something the owner wants to learn.** That rules out the cheapest layout without it. One k3s node keeps every operator, manifest, and rollout path the Free Plan cluster used, so the overlay changes and the components do not.

**Spot is safe because state lives off the node.** A reclaim loses only what the node held in memory. Kafka and Postgres data are on the persistent volume, and Flink resumes from its last checkpoint in S3, as after a node failure. The owner accepts a few minutes without service.

**The cost estimate.** About 176 node hours a month on Spot, the volume and its snapshots, the Elastic IP, and S3 come to about $15 to $30 a month in the design, and $21 to $38 in the [contract's estimate](../../operations/dev-environment.md#cost-estimate). Both are estimates from list prices, to be checked against the first bill.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Keep the six-node cluster running all day on the paid account | About $450 a month for a dev environment with almost no load, billed every hour whether used or not. |
| Managed streaming: MSK Serverless, Managed Service for Apache Flink, Kinesis, and Aurora Serverless v2 with CDC | Hourly minimums: MSK Serverless about $540 a month, Managed Flink about $800 a month for five jobs. Aurora Serverless v2 cannot pause while the Flink CDC sources hold a replication connection. Kinesis would replace Kafka and change every job's sources and sinks, and the design rules out rewriting components for managed streaming. |
| Docker Compose on one instance, without Kubernetes | Cheapest to run, but the owner wants Kubernetes, to keep learning it. It would also drop the Argo CD and Flink operator paths that the deploy and upgrade rules rely on. |

## Consequences

- The [AWS Free Plan environment](../../operations/aws-free-plan.md) is the retired target. Its contract stays as a record, and the [dev environment contract](../../operations/dev-environment.md) is the current one.
- The environment is down most of the day. Nothing may depend on it running unattended: no scheduled job that must run at night, no event source other than the simulator. A scheduled savepoint ([state recovery](../components/state-recovery.md)) runs only while the node runs, so the stop savepoint is in practice the daily one.
- Every start is a restart. The Flink jobs restore from savepoints daily, so a savepoint that does not restore shows up the next morning, not at the next deploy.
- A Spot reclaim behaves like a node failure. The jobs resume from a checkpoint, not a savepoint, and the Kafka and Postgres data on the persistent volume survive.
- Losing the persistent volume loses the Kafka and Postgres data since the last weekly snapshot.
- Production is not designed here. It needs its own decision, and may well use the managed services this record rejects for dev.
- New code must not assume more than one node, or a node that runs all day.

## Related

- [Dev environment](../../operations/dev-environment.md)
- [AWS Free Plan environment](../../operations/aws-free-plan.md), retired
- [Deployment](../../operations/deployment.md)
- [Decision 0052](0052-keep-hot-state-in-flink-and-a-redesigned-projection-in-postgres.md), [decision 0053](0053-store-raw-events-transition-history-and-imports-in-an-iceberg-lakehouse.md), [decision 0054](0054-recover-flink-state-in-four-layers.md)
