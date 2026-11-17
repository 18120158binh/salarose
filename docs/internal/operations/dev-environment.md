---
title: Dev environment
slug: dev-environment
purpose: Run the whole journey engine on one stoppable k3s node on a paid AWS account, at the lowest cost a part-time dev environment allows, and stop paying for compute while nobody uses it.
status: draft
implementation: planned
area: infra
tags: [deployment, aws, kubernetes, environment, cost]
created: 2026-11-17
updated: 2026-11-17
version: 0.1
---

# Dev environment

This page is the contract for the platform's dev environment on a paid AWS account. It replaces the [AWS Free Plan environment](aws-free-plan.md), whose account closed on 2026-11-14. One EC2 Spot instance runs k3s as a single node, with Kafka, Postgres, Flink, studio, and the collector on it. S3, ECR, Cognito, and the other AWS services it uses charge only for what is stored or used. The instance stops on its own when nobody uses it, and one command starts it again. [Decision 0055](../architecture/decisions/0055-run-the-dev-environment-on-one-stoppable-spot-node.md) explains why. Like the Free Plan page, it sits in `operations/` because an environment is neither a feature nor a component, and its rules name hosts, instance families, and AWS services.

Rules marked "the lead's default, pending owner review" were set by the lead, not by the owner. The owner may change them.

## Purpose

The platform has one environment, and it is a dev environment. One person uses it, part of the day. The six-node Free Plan cluster ran all day and cost about $450 a month for almost no load. This environment keeps what that one taught: Kubernetes, Argo CD GitOps, the Flink Kubernetes Operator with savepoint upgrades, and Cognito sign-in for every tool. It drops what cost money while nobody used it. A person starts it, signs in to studio, builds a journey, runs the simulator, watches the jobs in Grafana and the Flink UI, and walks away. Thirty minutes later it saves the Flink state and stops.

## Scope

In scope:

- The AWS resources, their sizes, and their cost.
- The single k3s node, the persistent volume, and the Elastic IP.
- Starting the environment and stopping it, by hand and on its own.
- What carries over from the [AWS Free Plan environment](aws-free-plan.md): sign-in, network exposure, secrets, and the CI build-and-pin flow.
- Backup of the persistent volume, and the spend alert.

Out of scope:

- Production. A production layout with managed databases and streaming comes later and is not designed here.
- High availability. One node, so a stop or a Spot reclaim interrupts service for minutes.
- Moving data from the closed Free Plan account. The new account starts empty, and the Flink jobs start clean (owner, 2026-11-17).
- The lakehouse writer and the catalog choice. This environment provides the S3 bucket and the catalog service only, and the [lakehouse sink](../architecture/components/lakehouse.md) contract decides the rest (the lead's default, pending owner review).
- Journeys that complete end to end. The [blocking known issues](../known-issues/README.md#what-stops-a-journey-today) apply here as on every target.

## Terms

| Term | Meaning |
|---|---|
| Node | The one EC2 Spot instance that runs k3s. The start command creates or starts it, and the idle stop ends it. |
| Persistent volume | The EBS gp3 volume, separate from the node, that holds the Kafka and Postgres data and the cluster's own data. It outlives every node. |
| Start | The command that brings the environment up: a node with the persistent volume and the Elastic IP attached, k3s running, Argo CD synced, and the Flink jobs running from their savepoints. |
| Stop | The node stops running and stops billing for compute. Whether the instance is stopped or terminated is left to the builder. The persistent volume, the Elastic IP, and S3 stay. |
| Idle stop | The task on the node that stops the environment when nobody has used it for 30 minutes, or 12 hours after the start. |
| In use | At least one of the signals in DEV-FR-09 within the last check window. |
| Stop savepoint | The savepoint of every Flink job that the idle stop takes before it stops the node. |
| Spot reclaim | AWS takes the Spot capacity back. The node goes away with two minutes' notice and no stop savepoint. |
| Public hostname | A name under `sslip.io` that resolves to the Elastic IP, such as `studio.3-90-12-7.sslip.io`. `<ip>` below stands for the dashed address. |

## Behavior

1. **Start.** The operator runs the start command. It gets a Spot node, attaches the persistent volume and the Elastic IP, and boots k3s from the cluster data on the volume. Argo CD syncs from the deploy branch, the [schema migrations](../architecture/components/schema-migrations.md) run, and each Flink job resumes from its latest savepoint or checkpoint. The environment is ready within 5 to 10 minutes. The hostnames, the certificates, and the Cognito callback URLs are the same as on every earlier start.
2. **Use.** A person signs in to studio, Grafana, Argo CD, or the Flink UI through Cognito, and may run the traffic simulator against the collector. Each of these counts as use.
3. **Idle stop.** Every 5 minutes the idle stop checks for use. After 30 minutes with none, it takes a stop savepoint of every Flink job, then stops the node.
4. **Cap.** Twelve hours after a start, the idle stop stops the node whatever the activity, through the same savepoint and stop. A forgotten simulator cannot run all night. To keep working, the operator starts the environment again.
5. **Failed savepoint.** If a stop savepoint fails or times out, the idle stop logs the failure and stops the node anyway. At the next start, that job resumes from its last checkpoint, as after a Spot reclaim (the lead's default, pending owner review).
6. **Spot reclaim.** The node goes away without a stop savepoint. The Flink jobs resume from their last checkpoint at the next start, as after a node failure. Kafka and Postgres data are on the persistent volume and survive. Whether a new node starts on its own after a reclaim is an [open question](#open-questions).
7. **While stopped.** Nothing runs and nothing answers on the hostnames. Tracker hits sent to the collector are lost, and that is accepted, because only the simulator sends events, and only while the owner uses the environment (owner, 2026-11-17). No buffer sits in front of the collector.
8. **Backup.** Once a week, Data Lifecycle Manager snapshots the persistent volume and keeps the last 4 snapshots (the lead's default, pending owner review).
9. **Spend alert.** AWS Budgets alerts when the month's spend passes a threshold. The amount and the recipient are an [open question](#open-questions).
10. **Change.** To change what runs, the operator pushes to the deploy branch, and the CI build-and-pin flow of the Free Plan environment applies unchanged (DEV-FR-21). A push while the environment is stopped builds and pins images, and Argo CD rolls them out at the next start. Changes to AWS resources go through Terraform, never through CI.

Example. The owner starts the environment at 09:00, works until 12:10, and leaves the simulator off. The idle stop sees no use from 12:10, takes the stop savepoints at about 12:40 to 12:45, and stops the node. The owner starts it again at 14:00 and forgets the simulator running at 18:00. The simulator's events count as use, so the node runs until the cap at 02:00 and stops then.

## Functional requirements

| Id | Requirement |
|---|---|
| DEV-FR-01 | Every AWS resource the environment creates, including volumes, snapshots, and network interfaces, must carry one project tag, so that one tag query lists all of them, as AFP-FR-02 says (the lead's default, pending owner review). |
| DEV-FR-02 | Terraform must own every AWS resource in [AWS resources](#aws-resources) except the node instance, with its state in S3, as AFP-FR-19 says (the lead's default, pending owner review). For the node, Terraform owns a launch template, and the start command creates or starts the node from it, so a stop may stop or terminate the instance. A plan against an unchanged environment must show no changes, whether the node is running, stopped, or terminated. |
| DEV-FR-03 | The environment must not create a NAT gateway or a load balancer (the lead's default, pending owner review). It must not create MSK, Managed Flink, Kinesis, RDS, Aurora, or EKS either. That part follows from the owner's choice to self-host Kafka, Flink, and Postgres on k3s, and its list of services is the lead's default, pending owner review. |
| DEV-FR-04 | The node must be one EC2 Spot instance running k3s as a single-node cluster, with every workload in [Kubernetes layout](#kubernetes-layout) on it. |
| DEV-FR-05 | The Kafka data, the Postgres data, and the k3s cluster data must live on the persistent volume, so that a new node attached to it comes up with the same cluster, topics, offsets, and rows. The node's root volume must hold nothing that a start cannot recreate. |
| DEV-FR-06 | One Elastic IP must stay allocated while the environment is stopped, and every start must associate it with the node. The public hostnames, the certificates, and the Cognito callback and logout URLs must never change across starts (owner, 2026-11-17). |
| DEV-FR-07 | The certificates that cert-manager gets from Let's Encrypt must persist across starts, so that a start requests no new certificate while the stored one is valid. |
| DEV-FR-08 | The start command must bring the environment from stopped to ready with one command and no manual repair step. Run against a running environment, it must change nothing and report that the environment is up. It must say which step failed when one fails. |
| DEV-FR-09 | The idle stop must count the environment in use when, within the check window, at least one of these happened: an HTTP request to studio, Grafana, Argo CD, or the Flink UI, read from the ingress access log; a new event at the collector; an open Session Manager session or a connection to the Kubernetes API. |
| DEV-FR-10 | The idle stop must check for use every 5 minutes. After 30 minutes with no use, it must take a savepoint of every Flink job, then stop the node. |
| DEV-FR-11 | The idle stop must stop the node 12 hours after the start, whatever the activity, through the same savepoint and stop as DEV-FR-10. |
| DEV-FR-12 | If a stop savepoint fails or does not finish in time, the idle stop must log which job failed and stop the node anyway. The job then resumes from its last checkpoint at the next start (the lead's default, pending owner review). |
| DEV-FR-13 | At every start, each Flink job must resume from its newest savepoint or retained checkpoint, whichever is newer, and never with `allowNonRestoredState`. A job with neither starts clean only on the first start of a new account. |
| DEV-FR-14 | The idle stop must run on the node and keep working when Argo CD, Prometheus, or any Flink job is down. A failure of the idle stop itself must not leave the node running past the 12-hour cap: a second mechanism, independent of the idle stop and chosen by the builder, must stop the node at the cap (the lead's default, pending owner review). |
| DEV-FR-15 | Data Lifecycle Manager must snapshot the persistent volume once a week and keep the last 4 snapshots (the lead's default, pending owner review). |
| DEV-FR-16 | An AWS Budgets budget must alert when the month's actual or forecast spend passes the threshold the owner sets. |
| DEV-FR-17 | Studio, the collector, Argo CD, Grafana, and the Flink UI must be reachable only over HTTPS on port 443, through the k3s Traefik ingress, with certificates from Let's Encrypt for the public hostnames. Port 80 is open only for the ACME challenge and the redirect to HTTPS. No other port may be open to the internet. Operators reach the node and the Kubernetes API through AWS Systems Manager Session Manager. This carries over AFP-FR-15 and AFP-FR-16 (the lead's default, pending owner review). |
| DEV-FR-18 | Every tool must sign people in through one Cognito user pool, as AFP-FR-17 and AFP-FR-23 to AFP-FR-32 of the [Free Plan contract](aws-free-plan.md#functional-requirements) say, with this environment's names, and with each app client's callback and logout URLs on the public hostnames (the lead's default, pending owner review). |
| DEV-FR-19 | The Kafka browser must be off by default, to save memory. When an operator enables it, AFP-FR-30 applies (the lead's default, pending owner review). |
| DEV-FR-20 | No secret may appear in git, user data, a tag, an image, an SSM command, or a command line. The node generates the secrets it can, and reads the rest with its own role. This carries over AFP-FR-18 (the lead's default, pending owner review). |
| DEV-FR-21 | The CI build-and-pin flow and the GitHub OIDC trust of the Free Plan contract apply, with this environment's deploy branch, registry, and overlay: AFP-FR-04, AFP-FR-05, AFP-FR-20, AFP-FR-21, and AFP-FR-33 (the lead's default, pending owner review). |
| DEV-FR-22 | The node must pull images from ECR with its instance role, as AFP-FR-06 says (the lead's default, pending owner review). |
| DEV-FR-23 | Argo CD, Postgres, Kafka, the Flink jobs, the customer profiles table, the collector's client address, the metrics, the Flink jobs dashboard, and the pipeline alerts must meet AFP-FR-07 to AFP-FR-14, AFP-FR-22, AFP-FR-26, AFP-FR-34 to AFP-FR-36, with this environment's names (the lead's default, pending owner review). |
| DEV-FR-24 | The checkpoint and savepoint bucket must have versioning on, as [state recovery](../architecture/components/state-recovery.md) requires for savepoints. |

## Non-functional requirements

| Id | Requirement |
|---|---|
| DEV-NFR-01 | From the start command to five Flink jobs `RUNNING` and studio answering `GET /login` with `200` must take 10 minutes or less, when Spot capacity is available. The owner accepts this wait (2026-11-17). |
| DEV-NFR-02 | The node must stop no later than 40 minutes after the last use, and no later than 12 hours and 15 minutes after the start, unless AWS refuses the stop. The 10 minutes past the rule cover one 5-minute check and the stop savepoints. This bound is derived on this page, not set by the owner, and depends on the [savepoint time limit](#open-questions). |
| DEV-NFR-03 | A stop, a Spot reclaim, or the loss of the node must lose no Kafka message, no Postgres row, and no Flink state older than the last completed checkpoint. |
| DEV-NFR-04 | The loss of the persistent volume may lose at most the Kafka and Postgres data written since the last weekly snapshot. Flink state survives it, because it lives in S3. |
| DEV-NFR-05 | The sum of memory requests on the node must stay at or below 80% of its allocatable memory, as AFP-NFR-03 says (the lead's default, pending owner review). |
| DEV-NFR-06 | While the environment is stopped, the AWS bill must grow only by storage and the Elastic IP: the persistent volume, its snapshots, S3, ECR, Secrets Manager or Parameter Store, the lakehouse KMS key, and the address. |

## Interfaces

### AWS resources

All resources are in one region and one availability zone, because an EBS volume can attach only to an instance in its own zone. Which region is an [open question](#open-questions).

| Resource | Size or setting |
|---|---|
| EC2 Spot instance | One node, about 4 vCPUs and 16 to 32 GiB of memory, IMDSv2 required with a hop limit of 2 so that pods can reach the instance role (the lead's default, pending owner review). Terraform owns its launch template, not the instance (DEV-FR-02). The builder picks the type from measured memory requests (DEV-NFR-05). |
| EBS gp3 persistent volume | One, in the node's zone, holding the Kafka, Postgres, and k3s data. Its size is the builder's choice. |
| Elastic IP | One, kept while the environment is stopped, about $3.60 a month. |
| Security group | Inbound 80 and 443 from anywhere. Nothing else. |
| IAM role for the node | Session Manager, ECR read, read and write on the bucket's Flink and lakehouse prefixes, the catalog it needs, read of the Cognito app clients, its secrets, and the permission to stop itself. |
| IAM role for CI | Trusted by GitHub's OIDC provider for this repo's deploy branch only. Push to the ECR repositories. |
| Permissions for the start command | Start or create the node, attach the persistent volume, and associate the Elastic IP. |
| S3 bucket | Private and versioned. Flink checkpoints, savepoints, and HA metadata under `flink/`, the lakehouse, and the Terraform state. Every lakehouse object is encrypted with SSE-KMS under the lakehouse key (LKH-NFR-06). |
| KMS key | One customer-managed key for the lakehouse objects, as [LKH-NFR-06](../architecture/components/lakehouse.md#non-functional-requirements) and [decision 0053](../architecture/decisions/0053-store-raw-events-transition-history-and-imports-in-an-iceberg-lakehouse.md) require. The node role and the catalog may encrypt and decrypt with it. |
| Iceberg catalog and query | Glue Data Catalog or S3 Tables, and Athena, as the lakehouse sink contract chooses (#115). |
| ECR repositories | The Flink jobs image and the studio image, scan on push. |
| Secrets Manager or SSM Parameter Store | The logins and the secrets the node cannot generate. |
| Cognito user pool | The managed login pages, the groups `studio-admin` and `studio-editor`, and one confidential app client per tool, as in the [Free Plan contract](aws-free-plan.md#aws-resources). |
| Data Lifecycle Manager policy | Weekly snapshot of the persistent volume, keep 4. |
| AWS Budgets budget | Monthly cost budget with an alert at the owner's threshold. |

### Kubernetes layout

One node runs everything. There are no node pools.

| Namespace | Holds |
|---|---|
| `argocd` | Argo CD |
| `cert-manager` | cert-manager and the Let's Encrypt `ClusterIssuer` |
| `monitoring` | A light Prometheus and Grafana, with the Flink jobs dashboard and the pipeline alerts |
| `strimzi` | The Strimzi operator |
| `cnpg-system` | The CloudNativePG operator |
| `flink-operator` | The Flink Kubernetes Operator |
| `cdp` | The Kafka cluster, the Postgres cluster, the five `FlinkDeployment`s, studio, the collector, the Flink UI, and the Kafka browser when enabled |

Where on the node the idle stop runs is the builder's choice, within DEV-FR-14.

### Service addresses

| Service | Address |
|---|---|
| Studio | `https://studio.<ip>.sslip.io` |
| Collector | `https://collector.<ip>.sslip.io` |
| Argo CD | `https://argocd.<ip>.sslip.io` |
| Grafana | `https://grafana.<ip>.sslip.io` |
| Flink UI | `https://flink.<ip>.sslip.io`, with one link per job under `/<job name>/` |
| Kafka browser | `https://kafka.<ip>.sslip.io`, when enabled |
| Kafka bootstrap | `cdp-kafka-bootstrap.cdp.svc:9092`, inside the cluster only |
| Postgres primary | `cdp-pg-rw.cdp.svc:5432`, inside the cluster only |

### What carries over from the Free Plan environment

The lead carried these over from the [AWS Free Plan contract](aws-free-plan.md) (the lead's default, pending owner review):

| Carries over | Where here |
|---|---|
| Cognito sign-in for studio, Grafana, Argo CD, and the Flink UI, with break-glass local logins | DEV-FR-18 |
| Only ports 80 and 443 open, operator access through Session Manager | DEV-FR-17 |
| No secret in git or user data | DEV-FR-20 |
| The CI build-and-pin flow and the GitHub OIDC trust | DEV-FR-21 |
| No NAT gateway and no load balancer | DEV-FR-03 |
| The Flink jobs dashboard and the pipeline alerts | DEV-FR-23 |
| The Kafka browser, now off by default | DEV-FR-19 |
| One project tag on every resource (AFP-FR-02) | DEV-FR-01 |
| Terraform owns the AWS resources, state in S3 (AFP-FR-19) | DEV-FR-02 |
| The node pulls from ECR with its instance role (AFP-FR-06) | DEV-FR-22 |
| Argo CD sync and waves, Postgres, Kafka, the Flink jobs and their metrics, `customer_profiles`, the client address (AFP-FR-07 to 14, 22, 26, 34 to 36) | DEV-FR-23 |
| Memory requests at or below 80% of allocatable (AFP-NFR-03) | DEV-NFR-05 |
| IMDSv2 with a hop limit of 2 | [AWS resources](#aws-resources) |

The lead also extended the services DEV-FR-03 rules out with Managed Flink, Kinesis, and Aurora, from the owner's choice to self-host the streaming core, and added the independent cap of DEV-FR-14. Both are the lead's defaults, pending owner review.

What does not carry over: the spend check against the Free Plan credit (AFP-FR-01, AFP-NFR-01), the six nodes and their pools (AFP-NFR-02), and the account's closure at expiry. The Budgets alert and the 12-hour cap take the spend check's place.

## Cost estimate

This is an estimate from list prices in `us-east-1`, not a measurement. Check it against the first month's bill. It assumes the node runs about 8 hours on 22 working days, 176 hours a month.

| Item | Assumption | Per month |
|---|---|---|
| Spot node | 176 hours at $0.06 to $0.12 an hour for 4 vCPUs and 16 to 32 GiB | $11 to $21 |
| Persistent volume | 50 GB gp3 at $0.08 a GB-month | $4 |
| Root volume | 30 GB gp3, only if the node is stopped rather than terminated | $0 to $2.40 |
| Snapshots | 4 weekly, incremental, at $0.05 a GB-month | $1 to $3 |
| Elastic IP | $0.005 an hour, all month | $3.60 |
| S3, ECR, Secrets Manager, Athena, Glue | A few GB stored, few queries | $1 to $3 |
| KMS key for the lakehouse | $1 a key-month plus requests | about $1 |
| Total | | about $21 to $38 |

The design estimated $15 to $30. Either way it is far below the six-node cluster's $450. Most of the range comes from the instance type and the Spot price, which the builder fixes.

## Risks

| Risk | Effect | Mitigation |
|---|---|---|
| ARM images | ARM instances such as `t4g` and `m7g` cost about 20% less, but every image must build for ARM, and the OpenSnowcat collector image may not support it. | The builder checks every image and chooses ARM or x86 ([left to the builder](#left-to-the-builder)). |
| Spot reclaim | Service stops for minutes. The Flink jobs resume from their last checkpoint, not a stop savepoint. | Checkpoints in S3 and retained on cancel ([state recovery](../architecture/components/state-recovery.md)). Nothing retains them on cancel yet: REC-KI-01, #106. |
| Spot capacity shortage | The start command cannot get a node in the volume's zone. | The builder decides how the start command handles it. |
| CDC slots while stopped | Postgres keeps WAL for each slot while Flink is down. | Postgres stops with the node, and nothing writes while it is stopped, so little WAL builds up. |
| A failure of the idle stop | The node runs and bills until someone notices. | The independent cap of DEV-FR-14, and the Budgets alert. |

## Acceptance criteria

- [ ] `aws resourcegroupstaggingapi get-resources` with the project tag lists every resource in [AWS resources](#aws-resources) and none from DEV-FR-03 (DEV-FR-01, DEV-FR-03).
- [ ] `terraform plan` shows no changes with the node running, and none with it stopped (DEV-FR-02).
- [ ] From stopped, the start command brings five Flink jobs to `RUNNING` and `curl -sI https://studio.<ip>.sslip.io/login` to `200` within 10 minutes, with no other command (DEV-FR-08, DEV-NFR-01).
- [ ] Running the start command a second time changes nothing and reports the environment up (DEV-FR-08).
- [ ] The public address and every certificate's serial number are the same before a stop and after the next start (DEV-FR-06, DEV-FR-07).
- [ ] With no request, no event, and no session for 30 minutes, the node stops within 40 minutes of the last use, and S3 holds a new savepoint for each of the five jobs (DEV-FR-10, DEV-NFR-02).
- [ ] With the simulator sending events, the node stops between 12 hours and 12 hours 15 minutes after the start (DEV-FR-11, DEV-NFR-02).
- [ ] With one job's savepoint made to fail, the node still stops, the log names the job, and at the next start that job resumes from its last checkpoint (DEV-FR-12, DEV-FR-13).
- [ ] A topic message and a Postgres row written before a stop are there after the next start, and so are they after a simulated Spot reclaim (DEV-NFR-03).
- [ ] A Flink job's keyed state, such as a metric value, is the same after a stop and start as before it (DEV-FR-13).
- [ ] Data Lifecycle Manager shows the policy, and after five weeks exactly 4 snapshots of the persistent volume exist (DEV-FR-15).
- [ ] AWS Budgets shows the budget with its alert threshold and recipient (DEV-FR-16).
- [ ] A scan of the Elastic IP from outside AWS finds only ports 80 and 443 open (DEV-FR-17).
- [ ] A `studio-admin` member signs in to studio, then opens Argo CD, Grafana, and the Flink UI without a password prompt (DEV-FR-18).
- [ ] With the Kafka browser not enabled, `https://kafka.<ip>.sslip.io` serves nothing from the cluster (DEV-FR-19).
- [ ] The S3 bucket reports versioning `Enabled` (DEV-FR-24).
- [ ] For one month, the EC2 instance hours in the Cost and Usage Report match the hours between the node's start and stop events in CloudTrail, and the other line items are only those DEV-NFR-06 names (DEV-NFR-06).
- [ ] With the idle stop killed after a start, the node still stops by 12 hours 15 minutes after the start (DEV-FR-14).
- [ ] On the node, `df` and the mount table show the Kafka, Postgres, and k3s data directories on the persistent volume, and a node replaced from the launch template comes up with the same topics and rows (DEV-FR-05).
- [ ] For each signal of DEV-FR-09 alone (a studio request, a Grafana request, an Argo CD request, a Flink UI request, a collector event, a Session Manager session, a Kubernetes API connection), the node is still running 35 minutes after the last other use (DEV-FR-09).
- [ ] A search of the repo, the launch template's user data, the resource tags, and the images finds no secret value (DEV-FR-20).
- [ ] A push to the deploy branch that changes only `studio/` moves only the studio tag in the overlay, and CI holds no AWS access key (DEV-FR-21).
- [ ] Pods pull from ECR with no image pull secret (DEV-FR-22).
- [ ] Argo CD shows every application `Synced` and `Healthy`, five Flink jobs run with checkpoints in S3, and Prometheus lists the pipeline alerts (DEV-FR-23).
- [ ] `curl -sI` on studio, Argo CD, Grafana, and the Flink UI returns a certificate that a default trust store accepts, and `http://` redirects to `https://` (DEV-FR-17).
- [ ] A volume restored from the newest snapshot boots the cluster with its topics and rows as of that snapshot (DEV-NFR-04).
- [ ] The sum of memory requests in `kubectl describe node` is at or below 80% of allocatable memory (DEV-NFR-05).
- [ ] Every object under the lakehouse prefix reads `aws:kms` encryption with the lakehouse key (LKH-NFR-06).

## Left to the builder

The design leaves these to whoever builds the environment. The build issues carry them, and the builder records each choice on this page when it lands.

- The instance type, from measured memory requests, and ARM or x86.
- The persistent volume's size, and how k3s and its data directories map onto it.
- Whether a stop stops or terminates the instance, how the start command finds and attaches the volume, and how it handles a Spot capacity shortage.
- How the idle stop reads each signal of DEV-FR-09, and how it takes the savepoints.
- Whether the start is also a link, a Lambda Function URL behind sign-in, now or later.
- The names: the project tag, the deploy branch, the overlay directory, and the resource names.

## Open questions

- **The Budgets threshold and recipient.** The design gives "such as $30" for the alert. This page estimates $21 to $38 a month, so a threshold below the estimate fires in a normal month. What amount, and which address gets the alert?
- **Restart after a Spot reclaim.** Does a new node start on its own after a reclaim during use, or does the environment stay stopped until the operator runs the start command? Starting on its own keeps a working session alive. Staying stopped can never bill for a node nobody asked for.
- **The region.** The Free Plan environment ran in `us-east-1`, and the cost estimate assumes it. A region nearer the owner costs more per hour but answers faster.
- **The Free Plan code and branch.** What happens to `infra/aws-free-plan/`, the `deploy/aws-free-plan` branch, the deploy skill's Free Plan reference, and the open issues labeled `aws-free-plan`, now that the account is closed? Delete them, keep them as history, or reuse them for this environment?
- **The savepoint time limit.** How long may the stop savepoints take before the idle stop gives up and stops the node (DEV-FR-12)? DEV-NFR-02 assumes about 5 minutes.
- **Stop savepoint retention.** A stop savepoint lands on every working day. How long they are kept follows the savepoint retention of [state recovery](../architecture/components/state-recovery.md#open-questions), tracked in #113.
