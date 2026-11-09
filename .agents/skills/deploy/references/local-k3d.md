# Deploy to the local k3d cluster

A Kubernetes rehearsal on this workstation. Use it to test manifests, the Flink operator, and the rollout order before a cloud deploy. For day-to-day development, use the Podman stack in [the local environment guide](../../../../docs/internal/operations/local-environment.md) instead.

## What exists on this machine

The global `docker-k8s-local` skill describes the cluster:

- Cluster `local-cluster`, with 1 server and 2 agents. Argo CD runs in it.
- The GitOps repo is `~/workspace/gitops-repo`, served by a git daemon at `git://host.k3d.internal:9418/gitops-repo`.
- `argo-applications/journey-engine-application.yaml` syncs `apps/journey-engine-demo/` with automated prune and self-heal.
- Today `apps/journey-engine-demo/` runs an nginx placeholder, not this system.

Port 8080 is Traefik and the Argo CD dashboard, and port 3000 is OpenHands. Check ports with `ss -tlnp` before you expose a service.

## Steps

1. **Check the cluster.** Run `kubectl --context k3d-local-cluster get nodes`. If the cluster is down, ask before you start it.
2. **Build the images.**

	```bash
	TAG=sha-$(git rev-parse --short=12 HEAD)
	./event-processor/mvnw -f event-processor/pom.xml clean package
	docker build -t cdp/flink-processor:$TAG -f event-processor/Dockerfile event-processor/
	docker build -t cdp/studio:$TAG -f studio/Dockerfile .
	```

	The Flink image has no job JAR. For k3d, build a second image that adds it, so that the cluster needs no S3:

	```bash
	docker build -t cdp/flink-jobs:$TAG -f - event-processor/ <<EOF
	FROM cdp/flink-processor:$TAG
	COPY target/event-processor-1.0.0-SNAPSHOT.jar /opt/flink/usrlib/event-processor.jar
	EOF
	```

	The `FlinkDeployment` then uses `jarURI: local:///opt/flink/usrlib/event-processor.jar`.

3. **Load the images into the cluster.** k3d nodes cannot see the local Docker images:

	```bash
	k3d image import cdp/flink-jobs:$TAG cdp/studio:$TAG -c local-cluster
	```

	Set `imagePullPolicy: IfNotPresent` in the manifests, and never use `latest`.
4. **Install the backing services.** Postgres with `wal_level=logical`, a Kafka broker such as Redpanda, and the collector, all inside the cluster. Run the migrations in `infra/db/migrations/` as the jobs' database user, with the Job `db-migrate`. The first admin is whoever signs in with a role that `OIDC_ROLE_MAP` maps to `admin`. See [the runtime checklist](runtime-checklist.md).
5. **Install the Flink Kubernetes Operator** and cert-manager. [references/aws.md](aws.md) has the Helm commands. They are the same on k3d.
6. **Write the manifests in the GitOps repo.** Put them in a new folder, such as `apps/cdp-journey-engine/`, rather than in the placeholder. Write one `FlinkDeployment` per job, each with its entry class and `upgradeMode: savepoint`, plus a `Deployment` and a `Service` for `studio`. Put secrets in a `Secret` created with `kubectl create secret`, never in the repo. Add an Argo CD `Application` for the folder, and commit to the GitOps repo with a semantic message. Argo CD syncs it.
7. **Roll out in order** and **verify**, as in [the main skill](../SKILL.md#4-build-publish-and-roll-out). The OIDC provider must accept the local redirect URL.
