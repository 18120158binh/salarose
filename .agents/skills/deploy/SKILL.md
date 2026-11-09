---
name: deploy
description: >
  Build, publish, and roll out the CDP journey engine: the five Flink jobs in
  event-processor and the studio Next.js app. Targets: GitHub (images on ghcr.io and a release built by GitHub
  Actions), AWS (ECR, EKS with the Flink Kubernetes Operator, MSK, RDS), a
  six-node k3s cluster on an AWS Free Plan account, or the local k3d cluster. Use when the user says "deploy", "release", "ship to dev",
  "ship to prod", "push the images", "deploy to AWS", "use my AWS credit", "AWS free plan", "deploy to GitHub",
  "deploy to k3d", or "roll out tag X". Not for running the stack on a laptop
  for development (docs/internal/operations/local-environment.md), and not for
  editing CI without a rollout.
---

# Deploy the journey engine

Run this skill only when the user asks for a deploy in this conversation. It is the one exception to the rule in `AGENTS.md` that agents do not start services. A deploy has three parts: build and publish immutable artifacts, make sure the runtime has what the jobs need, and roll the jobs and the app out in an order that loses no events. The target decides the commands. The rules below do not change with the target.

## Rules

These hold for every target. Each one prevents a failure that a deploy of this system can cause.

1. **Ask before you act on anything shared.** Name the target, the environment, and the tag back to the user before the first push, apply, or resource creation. An agent applies to prod only when the user said "prod" in this conversation, and only with a release tag that already ran on dev.
2. **Create no billable cloud resource without an explicit yes.** For AWS, show the plan (resources, region, rough monthly cost) and wait. Prefer `--dry-run`, `plan`, `diff`, and `--build-only` first.
3. **Deploy an immutable tag.** Never deploy `latest`, a moving S3 path such as `jars/event-processor.jar`, or a tag you built from local files when CI built the real one. Kubernetes `IfNotPresent` skips the pull of a moved tag and runs the old image. Take the tag from the build output.
4. **One deploy owner.** Before an apply, check that no other deploy of this system is running. Never start a second rollout of another tag on the same environment.
5. **Keep Flink state across upgrades.** The jobs hold metrics for 31 days and journeys for 90 days in keyed state ([decision 0005](../../../docs/internal/architecture/decisions/0005-keep-live-state-in-flink.md)). Stop each running job with a savepoint, then start the new version from that savepoint. A fresh start without one forgets every journey in progress. Ask before you start any job without its savepoint.
6. **Secrets stay out of argv, chat, commits, and logs.** Read tokens from a file or an environment variable and pipe them (`--password-stdin`, `-H @-`). If the user pastes a secret, do not repeat it, and tell them to rotate it.
7. **Stage by path and commit with a semantic message, without `Co-Authored-By`.** Push only the branch the target needs. Never force-push a shared branch.
8. **Done means running, not applied.** See [Verify](#5-verify).

## 1. Pick the target

| Target | When | Reference |
|---|---|---|
| GitHub | Publish images to `ghcr.io` and the JAR to a GitHub Release, for any Kubernetes cluster to pull | [references/github.md](references/github.md) |
| AWS | A self-owned cloud environment: ECR, EKS, MSK, RDS | [references/aws.md](references/aws.md) |
| AWS Free Plan | An account on the AWS Free Plan, which cannot use MSK and has a fixed credit and end date. Everything runs on a six-node k3s cluster of Free Tier instances on EC2, synced by Argo CD. Check with `aws freetier get-account-plan-state`. | [references/aws-free-plan.md](references/aws-free-plan.md) |
| Local k3d | A Kubernetes rehearsal on this workstation, synced by the local Argo CD | [references/local-k3d.md](references/local-k3d.md) |

If the user names no target, ask. Don't guess a cloud.

## 2. Preflight

Run these on every target, from the repo root:

```bash
git status --short                      # must be empty, or the user agrees to deploy only committed work
git fetch origin && git status -sb      # the branch must contain origin's tip
./event-processor/mvnw -f event-processor/pom.xml clean package
pnpm install --frozen-lockfile && pnpm studio:build
pnpm --filter studio test
```

- A failing build stops the deploy.
- A failing test stops it too, unless it is listed in [the known issues](../../../docs/internal/known-issues/README.md) and the user agrees to go on. Today the `alignNodes` spacing test fails (JBD-KI-10).
- Name the tag. CI targets take it from the pipeline. Other targets use `sha-<git rev-parse --short=12 HEAD>` for a build and `vX.Y.Z` for a release.

## 3. Prepare the runtime

[references/runtime-checklist.md](references/runtime-checklist.md) lists what must exist before the jobs start: Postgres with logical WAL, the schema and its publications, the six Kafka topics, every environment variable and secret, the OIDC redirect URL and role claim, and the metrics reporter and alert rules. Check each item on the target. Create a missing one only after rule 1 and rule 2.

## 4. Build, publish, and roll out

Follow the target's reference to build and publish. Then roll out in this order, so that every consumer runs before its producer:

1. The schema. On an Argo CD target, the Job `db-migrate` applies every pending migration in `infra/db/migrations/` on each sync, before the apps, and a failed run stops the sync. Check its log with `kubectl -n cdp logs job/db-migrate`. On another target, run the same Job against the database before step 2, as [deployment](../../../docs/internal/operations/deployment.md#database) describes. Never run `schema.sql` against a database with data: it drops and recreates some tables.
2. `CustomerProfileWriterJob`, `StateMachineJob`, and `CampaignOutboxJob`. They consume what the later jobs produce.
3. `CustomerDecisionJob`. A new consumer group starts at the latest offset, so it must run before the event parse job publishes.
4. `EventParseJob`. A new consumer group starts at the latest offset of the collector topic.
5. `studio`.

Each Flink job runs from the same JAR with its own entry class, `com.cdp.platform.jobs.<package>.<Job>`:

| Job | Entry class |
|---|---|
| Event parse | `com.cdp.platform.jobs.eventparser.EventParseJob` |
| Customer decision | `com.cdp.platform.jobs.customerdecision.CustomerDecisionJob` |
| Profile writer | `com.cdp.platform.jobs.profilewriter.CustomerProfileWriterJob` |
| State machine | `com.cdp.platform.jobs.statemachine.StateMachineJob` |
| Outbox and timers | `com.cdp.platform.jobs.outbox.CampaignOutboxJob` |

To upgrade a running job, keep its state (rule 5):

```bash
flink stop --savepointPath <savepoint-dir> <job-id>      # prints the savepoint path
flink run -s <savepoint-path> -c <entry-class> <jar>      # same job, new JAR
```

On Kubernetes with the Flink operator, set `upgradeMode: savepoint` on the `FlinkDeployment` and change the image or the JAR. The operator takes the savepoint. A CDC source restored from the savepoint resumes from its slot. A job started without a savepoint reads a fresh snapshot of its tables. That is expected for the rule tables. For the transitions table it publishes every past notification request again, and the sender must deduplicate them (OUT-NFR-01). Warn the user before you start the outbox job without a savepoint.

## 5. Verify

A deploy is done when all of these hold. "Applied" or "Available" is not enough, because an old ReplicaSet can stay Available while the new one crash-loops.

- Every Flink job is `RUNNING`, its checkpoints complete, and it has not restarted since the rollout. Check the Flink REST API (`/jobs/overview`, `/jobs/<id>/checkpoints`) or the operator status.
- Every pod runs the new tag: `kubectl get pods -o jsonpath='{..image}'`, or the task definition revision on ECS.
- `studio` answers `GET /login` with `200` on its public URL, and the sign-in link redirects to the provider.
- `snowplow-parsed` receives messages after a test hit on the collector, when the user wants an end-to-end check.

No journey completes end to end today, because of [the blocking known issues](../../../docs/internal/known-issues/README.md#what-stops-a-journey-today). Don't report those as a failed deploy. Report a new error that the known issues do not list.

## 6. Roll back

- **App images.** Redeploy the previous tag. Record it before every rollout.
- **Flink jobs.** Stop the new job with a savepoint, then start the previous JAR from that savepoint. If the new version changed state types and the old one cannot read the new savepoint, start the old JAR from the savepoint taken before the upgrade. That older savepoint keeps every CDC change made since it was taken only within the CDC restore window, 10 completed checkpoints of the new job by default, about 5 minutes (JEX-NFR-10). Past it, freeze campaign edits until the rollback is done, or apply them again after it, as the deployment page's "Rolling back to an older savepoint" describes.
- **Schema.** No automatic rollback. A schema change needs its own plan, agreed with the user.

## Summary

End with this table, filled in. A later agent must not need the transcript.

| | |
|---|---|
| skill | deploy |
| target / env | github / dev |
| tag | sha-3f9c2a1b7d4e |
| artifacts | `ghcr.io/<owner>/cdp-journey-engine-studio:<tag>`, JAR in release `v0.4.0` |
| jobs running | 5 of 5, savepoints restored |
| studio | `200` on `/login` |
| previous tag | sha-91be03c4aa10 |
| skipped or failed | none |
