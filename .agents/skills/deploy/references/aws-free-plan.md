# Deploy to an AWS Free Plan account

A six-node k3s cluster on EC2 for an account on the AWS Free Plan, run by operators and synced by Argo CD. The contract is [docs/internal/operations/aws-free-plan.md](../../../../docs/internal/operations/aws-free-plan.md), and its requirement ids (`AFP-*`) are cited below. Use [aws.md](aws.md) instead on a paid account that can run MSK.

| Path | Role |
|---|---|
| `infra/aws-free-plan/terraform/` | Every AWS resource. The variable `stage` (`base`, `server`, or `all`) decides how many nodes exist. State lives in `s3://cdp-free-plan-<account id>/tfstate/` and holds the Cognito client secret, so it never goes in git. |
| `infra/aws-free-plan/check-spend.sh` | Reads the credit, the expiry, and the prices, and exits 1 if the projected spend exceeds 85% of the credit (AFP-FR-01). Run it before every `terraform apply`. |
| `infra/aws-free-plan/bootstrap.sh` | Sends `bootstrap-cluster.sh` to `platform-1` through Session Manager, with the ids it reads from `terraform output` |
| `infra/aws-free-plan/k3s-server.sh`, `k3s-agent.sh` | User data templates for `platform-1` and for `data-1` and `compute-1` to `compute-4`, rendered by `templatefile()`. Write a literal `${` as `$${`. |
| `infra/aws-free-plan/bootstrap-cluster.sh`, `root-app.yaml` | Installs Argo CD on `platform-1`, creates the secrets and the deploy key, and applies the root Application |
| `.github/workflows/build-images.yml` | On a push to `deploy/aws-free-plan`, builds each image whose inputs changed since its deployed tag, pushes it to ECR, and commits its tag to the overlay. Argo CD then rolls it out (AFP-FR-04, AFP-FR-20). Run it by hand with `images: all`, `flink-jobs`, or `studio` to force a build, for example after a change to the workflow's build steps, which is not an image input. |
| `.github/workflows/validate-deploy.yml` | On pull requests and pushes that touch `infra/`, builds the overlay with every layer, then runs `terraform validate` and shellcheck (AFP-FR-21) |
| `infra/k8s/envs/aws-free-plan/` | The overlay that the root Application syncs. Its `resources` list grows one layer per commit. |

Run the scripts from the repo root in Git Bash. They set `MSYS_NO_PATHCONV=1` themselves. Run Terraform from `infra/aws-free-plan/terraform` with `MSYS_NO_PATHCONV=1` set. Save each plan with `-out` and apply that file, so the apply does exactly what the user approved.

## Roll out in stages

Each stage ends in a check. Start the next stage only after the check passes, and stop for the user's yes where the table says so (deploy rules 1 and 2).

| Stage | Do | Check | Yes needed |
|---|---|---|---|
| 0. Integrate | `kustomize build` the overlay with every layer listed, then restore it. Run `bash -n` and shellcheck on the scripts. | The build passes, and no token other than `IMAGE_TAG` remains | No |
| 1. Base | `check-spend.sh`, then `terraform plan -var stage=base -out=base.tfplan`, then `terraform apply base.tfplan` | `aws resourcegroupstaggingapi get-resources --tag-filters Key=project,Values=cdp-free-plan` lists the bucket, both ECR repositories, the security group, and the user pool. No instance exists. | Yes |
| 2. Images | Commit, then push `deploy/aws-free-plan`. CI's `deploy` job commits the tag to the overlay, so pull before the next commit. | `aws ecr describe-images` shows the tag in both repositories | Yes, for the push |
| 3. Server | `check-spend.sh`, then plan and apply with `-var stage=server`. Commit the `env.properties` that Terraform writes. | `platform-1` is `Online` in Systems Manager, and `k3s kubectl get nodes` shows it `Ready` | Yes, because hourly billing starts here |
| 4. Agents | Plan and apply with `-var stage=all` | `kubectl get nodes -L cdp.io/pool` shows six `Ready` nodes: one `platform`, one `data`, and four `compute` | Covered by stage 3 |
| 5. Platform | `bootstrap.sh`. Add the printed public key as a read-only deploy key on GitHub. | Argo CD shows `cdp-root` and the five platform Applications `Healthy`. `https://argocd.<ip>.sslip.io` and `https://grafana.<ip>.sslip.io` serve a valid certificate. | The user adds the key |
| 6. Data | Add `../../data` to the overlay and push | `kubectl -n cdp get kafka,kafkatopic,cluster` shows Kafka `Ready`, 8 topics, and Postgres healthy. `\dt` lists the schema tables owned by `cdp`, and `\du cdp` shows `Replication`. | No |
| 7a. Sinks | Add `../../apps/flink-sinks` and `../../apps/monitoring`, then push | Three jobs show `RUNNING` and `STABLE`, each with a completed checkpoint under `s3://<bucket>/flink/<job>/` | No |
| 7b. Decision | Add `../../apps/flink-decision`, then push | Same check for `customer-decision-job` | No |
| 7c. Parse | Add `../../apps/flink-parse`, then push | Same check for `event-parse-job` | No |
| 8. Web | Add `../../apps/web`, then push. Create the first staff user. | The contract's acceptance criteria for studio, Cognito, and the collector pass | The user sets their password |

The order of 7a to 7c follows the deploy skill's rollout order. A new consumer group starts at the latest offset, so each consumer runs before the job that feeds it.

## Details by stage

**Stage 3.** EC2 on a Free Plan account accepts only Free Tier eligible types, and a dry run does not catch that. List them with `aws ec2 describe-instance-types --filters Name=free-tier-eligible,Values=true`.

**Stage 1.** `check-spend.sh` prints the credit, the expiry, the prices it read from the Pricing API, and the projected spend. It exits 1 if the spend exceeds 85% of the credit (AFP-NFR-01). The plan for `stage=base` must show nothing to add, change, or destroy once the base exists. The resources that `provision.sh` created on 2026-11-07, before the move to Terraform, came in through the `import` blocks in `imports.tf`. The account's other resources, a stopped `t3.micro` and the `clickstream-*` buckets, are not part of this deploy. Never touch them.

**Stage 2.** The workflow names the CI role in its `env`. The ARN is not a secret, because only the deploy branch of this repo can assume the role. The workflow runs the Maven tests, so a failing Java test stops the build.

**Stage 3.** The server writes the agent join token to the SecureString parameter `/cdp-free-plan/k3s-agent-token/<server instance id>`. The agents poll that parameter with the node role. k3s takes about 5 minutes after launch. Open a shell with `aws ssm start-session --target <instance id>`. The plugin for Session Manager must be installed on the operator's machine.

**Stage 5.** Argo CD fails to sync until the deploy key is added, then retries by itself.

**Logins.** The Argo CD, Grafana, and studio logins live in the Secrets Manager secret `cdp-free-plan/logins` in `us-east-1`. The user reads them in the AWS console (Secrets Manager, Retrieve secret value) or with `show-logins.sh` in their own terminal. Never read them through an agent. To rotate the Argo CD and Grafana passwords, run `rotate-logins-remote.sh`. It runs `rotate-logins.sh` on `platform-1`, which writes the new passwords to the secret first, then to `argocd-secret` and Grafana, and deletes `argocd-initial-admin-secret`. It prints only `stored in cdp-free-plan/logins`, `argocd rotated`, `grafana rotated`, and two HTTP codes, which must both be `200`. A failed run is safe to rerun. Studio users are Cognito users, so the secret holds only studio's URL.

**Single sign-on.** Argo CD, Grafana, and the Kafka browser sign people in through Cognito, each with its own app client (`argocd`, `grafana`, `kafka-ui`), so a person signed in to studio clicks "Log in via Cognito" and gets no password prompt. `bootstrap.sh` reads each client's id and secret into `argocd-oidc`, `grafana-oidc`, and `kafka-ui-oidc`, and writes the OIDC and RBAC keys of `argocd-cm` and `argocd-rbac-cm` under its own field manager, `cdp-sso`. Rerun `bootstrap.sh` after `terraform apply` creates the clients, and before the Grafana values or the Kafka UI layer reach the deploy branch: until the secrets exist, a new Grafana pod waits on `grafana-oidc` while the old pod keeps serving, and the Kafka UI pod does not start. Roles: `studio-admin` is Argo CD `role:admin` and Grafana `Admin`. `studio-editor` is Grafana `Viewer`. Everyone else is Argo CD read-only, and Grafana refuses them. `bootstrap.sh` also creates the Argo CD API account `studio-health` and stores its token in `studio-platform` (key `argocd-token`) in `cdp` for studio's Platform page. It makes the token inside `argocd-server` with `argocd account generate-token --core`, so no password is used, and keeps an existing token on a rerun. Argo CD applies `policy.default: role:readonly` to every subject first, so the token has read-only access to everything Argo CD shows, application logs included, and no write. It never leaves studio's server. To replace the token, delete `studio-platform` and rerun `bootstrap.sh`. The local `admin` logins of Argo CD and Grafana stay as break-glass for when Cognito is down: use the login form on each tool's sign-in page, with the password from `cdp-free-plan/logins`.

**Stage 6.** The CloudNativePG bootstrap creates no table (AFP-FR-09). The Job `db-migrate` applies the migrations in `infra/db/migrations/` as `cdp` on every sync, in wave 1, before the apps. A schema change ships as a new migration, written with the `db-migration` skill. Never apply DDL by hand as `postgres`: the next run fails on any object `cdp` does not own. Never delete the `Cluster`, because that deletes the data.

**Stage 8.** Create the first admin:

```bash
aws cognito-idp admin-create-user --user-pool-id <pool id> --username <email> \
	--user-attributes Name=email,Value=<email> Name=email_verified,Value=true --region us-east-1
aws cognito-idp admin-add-user-to-group --user-pool-id <pool id> --username <email> --group-name studio-admin --region us-east-1
```

## Upgrade

Push the change to `deploy/aws-free-plan`. CI builds the images whose inputs changed and commits their new `newTag` to the overlay, and Argo CD syncs it. A studio-only change leaves the Flink jobs running. The Flink operator stops each job with a savepoint and starts the new image from it (`upgradeMode: savepoint`). Check each job's `status.jobStatus.savepointInfo` before you report the upgrade done.

## Look inside

- Flink UI: open `https://flink.<ip>.sslip.io` and sign in as a Cognito user in `studio-admin`. The page links each job's Flink UI at `/<job name>/`. It is read-only: any method other than `GET` or `HEAD` gets `405`, and Flink's legacy `GET .../yarn-cancel` and `yarn-stop` routes get `403`, so cancel, rescale, and submit from the UI fail. `infra/k8s/apps/flink-ui/test-gateway.sh` checks these rules in CI. The secret `flink-ui-auth` must exist first: `bootstrap.sh` creates it from the `flink-ui` app client. To act on a job, or without a browser, run `k3s kubectl -n cdp port-forward svc/<job name>-rest 8081` in a Session Manager shell on `platform-1`, or forward a local port with `AWS-StartPortForwardingSessionToRemoteHost`.
- Argo CD: open `https://argocd.<ip>.sslip.io` and click "Log in via Cognito". A `studio-admin` member gets the admin role, and anyone else gets read-only.
- Grafana: open `https://grafana.<ip>.sslip.io` and click "Sign in with Cognito". The dashboard "Flink jobs" shows the five jobs' state, restarts, throughput, Kafka lag, backpressure, checkpoints, and pod CPU and memory.
- Kafka browser: open `https://kafka.<ip>.sslip.io` and sign in as a Cognito user in `studio-admin`. It lists topics, partitions, consumer groups, and messages. The cluster is configured read-only, so produce, topic create, edit, and delete, and offset resets fail for everyone. A user in no allowed group gets an empty UI. `/metrics` needs no sign-in, so the cluster keeps `prometheusExpose: false`: `curl -s https://kafka.<ip>.sslip.io/metrics | grep -c 'cluster="cdp"'` must print `0`. CI runs `infra/k8s/apps/kafka-ui/test-config.sh` to check the same. The secret `kafka-ui-oidc` must exist first.
- Kafka: `k3s kubectl -n cdp exec cdp-dual-role-0 -- bin/kafka-topics.sh --bootstrap-server localhost:9092 --list`.
- Postgres: `k3s kubectl -n cdp exec -it cdp-pg-1 -- psql -d auroracy`.

## At expiry

The contract leaves the environment running until AWS closes the account. To end it earlier, list everything with the tag query in stage 1. Get the user's yes before you delete anything, and take savepoints first. Release the Elastic IP after you terminate `platform-1`, because an unattached address is still billed.
