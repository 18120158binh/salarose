---
title: Platform console known issues
contract: ../../features/platform-console.md
updated: 2026-11-08
verified_at: none, read from the change that adds the console, before it was committed
---

# Platform console known issues

The `/platform` page, its health checks with each Flink job's state and each Argo CD application not synced and healthy, and the AWS Free Plan tool list are built. Nobody has opened the page on a cluster yet, so the acceptance criteria that need a browser and a running tool are unchecked.

| Id | Severity | Issue | Breaks |
|---|---|---|---|
| PCN-KI-01 | Risk | A Flink job counts as healthy when it is `RUNNING` with every task running, which stands in for `STABLE` | PCN-FR-04 |
| PCN-KI-02 | Risk | The health cache lives in each studio process, so two studio pods call each tool twice per 15 seconds | PCN-NFR-03 |
| PCN-KI-03 | Minor | Grafana's card links to a dashboard search for "Flink jobs", not to the dashboard itself | PCN-FR-06 |
| PCN-KI-06 | Blocking | Quick links have no group, so the page cannot show Code and Cloud | PCN-FR-08 |

## PCN-KI-01. A Flink job counts as healthy when it is `RUNNING` with every task running

- **Symptom.** A job that restarts again and again shows `up` whenever a check lands between two restarts.
- **Cause.** Flink's REST API reports a job's state, such as `RUNNING` or `RESTARTING`, and its task counts, but not the operator's lifecycle state `STABLE`. `readFlinkJob` in `studio/src/features/platform-console/model/health.ts` reads `GET /jobs/overview` and treats `RUNNING` with `tasks.running` equal to `tasks.total` as fine.
- **Evidence.** Read from the code.
- **Fix direction.** Read the `FlinkDeployment` status from the Kubernetes API, which needs a service account with read access for studio, or count restarts from `GET /jobs/<id>`.

## PCN-KI-02. The health cache lives in each studio process

- **Symptom.** With more than one studio pod, each pod checks each tool once per 15 seconds.
- **Cause.** `createHealthCache` in `studio/src/features/platform-console/model/healthCache.ts` keeps its map in module memory. The requirement holds while `infra/k8s/apps/web/studio/studio.yaml` sets `replicas: 1`.
- **Evidence.** Read from the code.
- **Fix direction.** Before adding studio replicas, share the last result through Postgres or move the checks to one place.

## PCN-KI-03. Grafana's card links to a dashboard search

- **Symptom.** The "Flink jobs dashboard" link opens Grafana's dashboard list filtered to "Flink jobs", and the admin clicks once more.
- **Cause.** The dashboard was not provisioned with a fixed `uid` when the console was added, so `PLATFORM_TOOLS` in `infra/k8s/apps/web/studio/studio.yaml` links to `/dashboards?query=Flink%20jobs`.
- **Evidence.** Read from the manifests.
- **Fix direction.** Give the provisioned dashboard a fixed `uid` and link to `/d/<uid>`.

## PCN-KI-06. Quick links have no group

- **Symptom.** Quick links show as one flat list.
- **Cause.** `Link` in `studio/src/features/platform-console/model/tools.ts` has a label and an address and no group, and the deployment's tool list in `infra/k8s/apps/web/studio/studio.yaml` declares none.
- **Evidence.** Read from the code.
- **Fix direction.** Add an optional `group` to each quick link in the configuration and its parser. Links with no group go under one default heading.
