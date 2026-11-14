# Batch jobs

A batch job is a Java main in the `event-processor` build that runs without Flink, starts on a schedule, does a bounded amount of work, and exits. The import applier is the first one. The import metric pass follows the same pattern. This page is the convention both follow, and the steps that put one into a deployment.

## Write the job

- Put the main class in its own package under `event-processor/src/main/java/com/cdp/platform/jobs/<job>/`. It may use `shared/`, but no Flink API: the batch image has no Flink on its class path.
- Read every setting from the environment once, at start, and stop with an error before doing any work when one is missing or malformed. List each variable in [configuration](configuration.md).
- Assume two instances can start at once, and a crash at any line. Take a session-level advisory lock on the main Postgres when only one instance may work, and stop when its connection drops. Make every write converge when it runs twice.
- Exit `0` when there is nothing to do, and when another instance holds the lock. Exit non-zero only on a failure an operator should see.
- Log ids, counts, and reasons. Never log a row value or a customer key.

## The image

Every batch job ships in one image, `cdp/batch-jobs`, built by `event-processor/Dockerfile.batch` from the same shaded jar as the Flink jobs. The image adds what the jar leaves out for Flink: SLF4J and the Postgres driver. Its entry point is `java -cp <jar and lib>`, so the CronJob names the main class as the container's argument. The JVM takes 75% of the container's memory limit for its heap.

The workflow `build-and-deploy` builds the image only once the deploy branch's overlay lists `cdp/batch-jobs`. Until then the build skips it, and pushes to no registry. After that, it builds when `event-processor/` changed since the deployed tag, and sets the tag in the overlay on its own line, apart from the Flink jobs' tag.

## The CronJob

Each job gets a folder `infra/k8s/apps/<job>/` with a `kustomization.yaml` and one CronJob. Copy `infra/k8s/apps/import-applier/` and keep:

- `concurrencyPolicy: Forbid`, and `backoffLimit: 0`, so a failed start waits for the next schedule instead of retrying at once.
- `image: cdp/batch-jobs` and `args: ["<main class>"]`.
- `nodeSelector: cdp.io/pool: compute`, a non-root user, a read-only root filesystem, and an `emptyDir` at `/tmp` for files the job streams to disk.
- Requests equal to limits, so the job's memory is guaranteed.

Add the folder to the layer list in `.github/workflows/validate-deploy.yml`, so CI builds it with the overlay before any target deploys it.

## Put a job into a deployment

These steps touch the AWS account and the cluster, so the owner runs them. Do them in order, each after the one before it works.

1. Create the ECR repository `cdp/batch-jobs`, once for every batch job. Add it to Terraform as its own resource: the repositories in `ecr_repos` are imported, and an import of a repository that does not exist fails the plan.
2. Create the secrets and the ConfigMap the CronJob reads, and add the secrets to the secret backup.
3. Grant the nodes' role the S3 access the job needs.
4. On the deploy branch, add an `images` entry for `cdp/batch-jobs` to the overlay, with the tag CI printed for a build of this commit, and then add `../../apps/<job>` to its resources.

## The import applier

The CronJob `import-applier` starts `com.cdp.platform.jobs.importapplier.ImportApplierMain` every 10 minutes with 1 vCPU and 2 GiB (IAP-NFR-01, IAP-NFR-02). Besides the secrets CloudNativePG creates, `cdp-pg-app` and `cdp-import-pg-app`, it reads:

| Object | Key | Value |
|---|---|---|
| Secret `cdp-import-tombstone` | `key` | The tombstone key, equal to studio's `IMPORT_TOMBSTONE_KEY` |
| ConfigMap `import-applier-env` | `IMPORTS_BUCKET` | The bucket of the drop zone, equal to studio's |
| ConfigMap `import-applier-env` | `AWS_REGION` | The bucket's region |

It needs `s3:GetObject` on `imports/incoming/*`, and `s3:PutObject` on `imports/reports/*` and `imports/rejects/*`.

Until apply exists, a run that passes validation goes back to the queue with its report, and the applier validates it again at each start. Don't deploy the applier before apply lands ([known issues](../known-issues/components/import-applier.md)).
