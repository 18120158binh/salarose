# Deploy to AWS

A self-owned AWS environment on a paid account. An account on the AWS Free Plan cannot use MSK (`SubscriptionRequiredException`, measured 2026-11-07), so use [aws-free-plan.md](aws-free-plan.md) there. Most steps create billable resources, so show the plan first and wait for the user's yes ([rule 2](../SKILL.md#rules)). Researched in October 2026. Each source is linked. Lines marked "unverified" were not confirmed.

## Target architecture

| Part | AWS service | Why this one |
|---|---|---|
| Images | ECR | |
| Flink jobs | EKS with the Apache Flink Kubernetes Operator | Managed Service for Apache Flink supports Flink 2.2, but runs Java 17, and the JAR targets Java 21. It also rejects some configuration that the jobs set in code. [Source](https://docs.aws.amazon.com/managed-flink/latest/java/flink-2-2.html) |
| Checkpoints, savepoints, HA | S3 | State must outlive the cluster |
| Kafka | MSK Provisioned, SASL/SCRAM | MSK Serverless requires IAM authentication, and the JAR does not bundle `aws-msk-iam-auth`. SCRAM-SHA-512 matches the jobs' default. [Source](https://docs.aws.amazon.com/msk/latest/developerguide/serverless.html) |
| Postgres | RDS for PostgreSQL 16, or Aurora PostgreSQL | Needs logical replication for CDC |
| studio | ECS Fargate through ECS Express Mode, or a Deployment on the same EKS cluster | App Runner is closed to new customers from 2026-04-30. [Source](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html) |
| Secrets | Secrets Manager | |

## 0. Plan and confirm

1. Check the identity and the region. Don't use a default profile without asking.

	```bash
	aws sts get-caller-identity --query Account --output text
	aws configure get region
	```

2. Ask whether the user has an existing EKS cluster, VPC, MSK cluster, or RDS instance to reuse. Reuse beats create.
3. Show the plan as a table: each resource, its size, and its region. Show the running cost drivers too:
	- The EKS control plane, about $0.10 an hour. This figure is unverified.
	- NAT gateways and the load balancer.
	- MSK brokers, about $0.204 an hour each for `m7g.large` in `us-east-1`, with at least 2 or 3 brokers, plus storage. [Source](https://aws.amazon.com/msk/pricing/)
	- RDS, Fargate tasks, and S3.
4. Wait for an explicit yes. Turn on deletion protection for RDS and MSK.

## 1. Registry

```bash
ACCT=$(aws sts get-caller-identity --query Account --output text); REGION=<region>; TAG=sha-$(git rev-parse --short=12 HEAD)
REG=$ACCT.dkr.ecr.$REGION.amazonaws.com
aws ecr create-repository --repository-name cdp/flink-jobs --image-scanning-configuration scanOnPush=true --region $REGION
aws ecr create-repository --repository-name cdp/studio --image-scanning-configuration scanOnPush=true --region $REGION
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $REG
```

Build the Flink jobs image with the JAR inside, as in [the k3d reference](local-k3d.md#steps), and the `studio` image. Then tag and push both to `$REG/cdp/<name>:$TAG`. Build `linux/amd64`, or a multi-arch image if the nodes are Graviton. [Source](https://docs.aws.amazon.com/AmazonECR/latest/userguide/docker-push-ecr-image.html)

## 2. Postgres

Logical replication is a static parameter. Set it in a custom parameter group, then reboot. A reboot is downtime. [Source](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.FeatureSupport.LogicalReplication.html)

```bash
aws rds create-db-parameter-group --db-parameter-group-name cdp-pg16-logical \
	--db-parameter-group-family postgres16 --description "Logical replication for Flink CDC"
aws rds modify-db-parameter-group --db-parameter-group-name cdp-pg16-logical \
	--parameters "ParameterName=rds.logical_replication,ParameterValue=1,ApplyMethod=pending-reboot"
# new instance: pass --db-parameter-group-name cdp-pg16-logical --manage-master-user-password --deletion-protection
# existing instance: modify-db-instance with the group, then reboot-db-instance
```

```sql
SHOW wal_level;                       -- logical
GRANT rds_replication TO <db_user>;   -- the master user has it already
```

- On Aurora, use a DB cluster parameter group with family `aurora-postgresql16`, and reboot the writer. [Source](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraPostgreSQL.Replication.Logical.Configure.html)
- CDC uses the writer endpoint. `DB_READ_HOST` may point at a reader.
- Raise `max_replication_slots` and `max_wal_senders` to at least 16 each, plus headroom: the jobs keep 8 slots, and on a start without saved state each of the 8 CDC sources opens one more temporary slot while it reads its snapshot.
- A slot that nobody reads holds WAL and can fill the instance's storage. Set CloudWatch alarms on `FreeStorageSpace` and `OldestReplicationSlotLag`. A running job's slot holds 10 checkpoints of WAL on purpose, about 10 minutes for the outbox job, so set the `OldestReplicationSlotLag` threshold above the WAL the database writes in 11 minutes at peak. If you set `max_slot_wal_keep_size`, keep it above that too, with room to spare. Drop leftover `flink_*` slots after you remove a job.
- Create the schema with the migrations in `infra/db/migrations/`, run as the jobs' database user, as [deployment](../../../../docs/internal/operations/deployment.md#database) describes. Never run `schema.sql` or `init-db.sh` against RDS, because both reset tables.

## 3. Kafka

```bash
aws secretsmanager create-secret --name AmazonMSK_cdp --kms-key-id <customer-managed key ARN> \
	--secret-string file://msk-scram.json        # {"username":"cdp","password":"..."}, then delete the file
aws kafka batch-associate-scram-secret --cluster-arn $MSK_ARN --secret-arn-list $SECRET_ARN
aws kafka get-bootstrap-brokers --cluster-arn $MSK_ARN --query BootstrapBrokerStringSaslScram
```

- The secret name must start with `AmazonMSK_`, and it must use a customer-managed KMS key. The default key fails. [Source](https://docs.aws.amazon.com/msk/latest/developerguide/msk-password-tutorial.html)
- The SCRAM port is 9096 inside AWS. [Source](https://docs.aws.amazon.com/msk/latest/developerguide/port-info.html)
- Create the six topics from [the runtime checklist](runtime-checklist.md#kafka) from a pod inside the VPC. MSK does not create topics on first use by default.

Job settings:

| Variable | Value |
|---|---|
| `KAFKA_BROKERS` | The SCRAM bootstrap string |
| `KAFKA_SECURITY_PROTOCOL` | `SASL_SSL` |
| `KAFKA_SASL_MECHANISM` | `SCRAM-SHA-512` |
| `KAFKA_SASL_JAAS_CONFIG` | `org.apache.kafka.common.security.scram.ScramLoginModule required username="cdp" password="...";`, from a Kubernetes Secret |
| `KAFKA_SSL_TRUSTSTORE_LOCATION` | Unset. The client then uses the JVM trust store, which trusts the MSK certificates. Inferred from the client code, unverified. |

## 4. Flink on EKS

Create or reuse the cluster with the team's tool, such as `eksctl` or Terraform. Then install cert-manager and the operator. Check the latest versions first.

```bash
kubectl --context <ctx> apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.21.2/cert-manager.yaml
helm repo add flink-operator-repo https://downloads.apache.org/flink/flink-kubernetes-operator-1.16.1/
helm install flink-kubernetes-operator flink-operator-repo/flink-kubernetes-operator \
	-n flink-operator --create-namespace --kube-context <ctx>
```

Operator 1.15 and later supports Flink 2.2. [Source](https://flink.apache.org/2026/05/26/apache-flink-kubernetes-operator-1.15.0-release-announcement/)

Give the `flink` service account S3 access with IRSA. EKS Pod Identity also works for the role, but whether the S3 file system plugin picks it up is unverified. Put `DB_PASSWORD`, `KAFKA_SASL_JAAS_CONFIG`, and the other secrets in a Kubernetes Secret `cdp-secrets`, synced from Secrets Manager.

Write one `FlinkDeployment` per job. Only `metadata.name`, the S3 paths, `entryClass`, and `parallelism` change between them.

```yaml
apiVersion: flink.apache.org/v1beta1
kind: FlinkDeployment
metadata: { name: customer-decision, namespace: flink }
spec:
  image: <ACCT>.dkr.ecr.<REGION>.amazonaws.com/cdp/flink-jobs:<TAG>
  flinkVersion: v2_2
  serviceAccount: flink
  flinkConfiguration:
    taskmanager.numberOfTaskSlots: "2"
    state.backend.type: rocksdb
    execution.checkpointing.incremental: "true"
    execution.checkpointing.dir: s3://<BUCKET>/checkpoints/customer-decision
    execution.checkpointing.savepoint-dir: s3://<BUCKET>/savepoints/customer-decision
    high-availability.type: kubernetes
    high-availability.storageDir: s3://<BUCKET>/ha/customer-decision
  podTemplate:
    spec:
      containers:
        - name: flink-main-container
          env:
            - { name: ENABLE_BUILT_IN_PLUGINS, value: flink-s3-fs-hadoop-2.2.0.jar }
            - { name: KAFKA_EVENT_TOPIC_PATTERN, value: snowplow-good }
            - { name: DB_HOST, value: <rds writer endpoint> }
          envFrom:
            - secretRef: { name: cdp-secrets }
  jobManager: { resource: { memory: "2048m", cpu: 1 } }
  taskManager: { resource: { memory: "4096m", cpu: 2 } }
  job:
    jarURI: local:///opt/flink/usrlib/event-processor.jar
    entryClass: com.cdp.platform.jobs.customerdecision.CustomerDecisionJob
    parallelism: 2
    upgradeMode: savepoint
```

The job sets its checkpoint interval in code, which overrides the configuration above. `ENABLE_BUILT_IN_PLUGINS` turns on the S3 file system that the image ships. Check the file name with `docker run --rm --entrypoint ls <image> /opt/flink/opt`. [Source](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/deployment/resource-providers/standalone/docker/)

Apply the jobs in [the rollout order](../SKILL.md#4-build-publish-and-roll-out), and wait for each one to reach `RUNNING`:

```bash
kubectl --context <ctx> -n flink get flinkdeployments
```

## 5. studio

ECS Express Mode creates the Fargate service, a load balancer, and autoscaling. It costs nothing on top of those. [Source](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-overview.md)

```bash
aws ecs create-express-gateway-service \
	--infrastructure-role-arn arn:aws:iam::$ACCT:role/ecsInfrastructureRole \
	--execution-role-arn arn:aws:iam::$ACCT:role/ecsTaskExecutionRole \
	--service-name studio --health-check-path /login --cpu 512 --memory 1024 \
	--primary-container 'image=<REG>/cdp/studio:<TAG>,containerPort=3000,environment=[{name=OIDC_ISSUER,value=<issuer>},{name=OIDC_CLIENT_ID,value=<client id>},{name=OIDC_REDIRECT_URL,value=https://<host>/api/auth/oidc/callback}],secrets=[{name=DATABASE_URL,valueFrom=<secret ARN>},{name=OIDC_CLIENT_SECRET,valueFrom=<secret ARN>},{name=SESSION_SECRET,valueFrom=<secret ARN>}]' \
	--network-configuration 'securityGroups=<sg>,subnets=<subnet-a>,<subnet-b>'
```

- The default health check path is `/ping`, which `studio` does not serve. `/login` returns `200`.
- Secrets take full ARNs, and the execution role needs `secretsmanager:GetSecretValue`. [Source](https://docs.aws.amazon.com/cli/latest/reference/ecs/create-express-gateway-service.html)
- Also set `OIDC_ROLE_CLAIM` and `OIDC_ROLE_MAP`. `OIDC_ROLE_MAP` is JSON, whose commas the shorthand above cannot carry, so pass `--primary-container` as JSON or set the two in the console. Without them every sign-in fails with `server_error`.
- `OIDC_REDIRECT_URL` depends on the public URL. Create the service, read its URL, then update the variable and register the URL at the provider. Custom domain support in Express Mode is unverified.
- If the Flink jobs already run on EKS, a `Deployment` behind the AWS Load Balancer Controller is the other choice.

## Before production

Tell the user about these CDC settings in the code before a production deploy. Each one needs its own issue (skill `create-issue`):

- Every CDC source sets `debezium.slot.drop.on.stop=false`, so each slot outlives its job and holds WAL while the job is stopped. Drop the slot of a job you remove. [Source](https://debezium.io/documentation/reference/stable/connectors/postgresql.html)
- They also set `debezium.slot.failover=true`, which needs PostgreSQL 17. Its effect on PostgreSQL 16 is unverified.
- Every CDC source sets `debezium.heartbeat.interval.ms` to 30 seconds. On PostgreSQL 15 and later a slot whose table is quiet still holds WAL, because no source sets `heartbeat.action.query` (PLT-KI-13). Alarm on `OldestReplicationSlotLag` at all times.

## Tear down

Deleting resources is destructive and needs its own yes. Take savepoints first. Never force-delete the S3 bucket with checkpoints and savepoints. Remove replication slots that no job reads.
