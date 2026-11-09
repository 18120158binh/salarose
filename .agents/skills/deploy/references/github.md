# Publish to GitHub and deploy from it

GitHub hosts the artifacts, not the runtime. GitHub Actions builds three images on `ghcr.io` and attaches the JAR to a GitHub Release. Any Kubernetes cluster then pulls them: the [AWS](aws.md) or [k3d](local-k3d.md) target, or another one the user names. GitHub Pages cannot host `studio`, because it is a Node.js server, not static files.

| Artifact | Name |
|---|---|
| Flink base image | `ghcr.io/<owner>/cdp-journey-engine/flink-processor:<tag>` |
| Flink jobs image, base plus the JAR | `ghcr.io/<owner>/cdp-journey-engine/flink-jobs:<tag>` |
| studio image | `ghcr.io/<owner>/cdp-journey-engine/studio:<tag>` |
| JAR | Asset of the release `vX.Y.Z` |

Tags: `sha-<7 chars>` for every build, the branch name for a branch build, and `X.Y.Z` for a `vX.Y.Z` tag. Deploy the `sha-` or `X.Y.Z` tag, never the branch tag, which moves. Image names must be lowercase.

## Set up the workflow, once

The repo has no `.github/` folder yet. On the user's yes, add the two files below and commit them with `ci(github): build images and release the JAR`. Before you commit, check the README of each action for its current major version. These were current in October 2026.

`event-processor/Dockerfile.jobs`:

```dockerfile
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY target/event-processor-1.0.0-SNAPSHOT.jar /opt/flink/usrlib/event-processor.jar
```

`.github/workflows/build-and-release.yml`:

```yaml
name: build-and-release
on:
  push:
    branches: [master]
    tags: ['v*']

jobs:
  flink:
    runs-on: ubuntu-latest
    permissions: { contents: write, packages: write }
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-java@v6
        with: { distribution: temurin, java-version: '21', cache: maven }
      - run: ./event-processor/mvnw -B -f event-processor/pom.xml clean package
      - uses: docker/setup-buildx-action@v4
      - uses: docker/login-action@v4
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: base
        uses: docker/metadata-action@v6
        with:
          images: ghcr.io/${{ github.repository }}/flink-processor
          tags: |
            type=sha
            type=ref,event=branch
            type=semver,pattern={{version}}
      - uses: docker/build-push-action@v7
        with:
          context: event-processor
          file: event-processor/Dockerfile
          push: true
          tags: ${{ steps.base.outputs.tags }}
          labels: ${{ steps.base.outputs.labels }}
      - id: jobs
        uses: docker/metadata-action@v6
        with:
          images: ghcr.io/${{ github.repository }}/flink-jobs
          tags: |
            type=sha
            type=ref,event=branch
            type=semver,pattern={{version}}
      - uses: docker/build-push-action@v7
        with:
          context: event-processor
          file: event-processor/Dockerfile.jobs
          build-args: BASE_IMAGE=${{ fromJSON(steps.base.outputs.json).tags[0] }}
          push: true
          tags: ${{ steps.jobs.outputs.tags }}
          labels: ${{ steps.jobs.outputs.labels }}
      - if: github.ref_type == 'tag'
        uses: softprops/action-gh-release@v3
        with:
          files: event-processor/target/event-processor-1.0.0-SNAPSHOT.jar
          generate_release_notes: true
          fail_on_unmatched_files: true

  studio:
    runs-on: ubuntu-latest
    permissions: { contents: read, packages: write }
    steps:
      - uses: actions/checkout@v7
      - uses: docker/setup-buildx-action@v4
      - uses: docker/login-action@v4
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: meta
        uses: docker/metadata-action@v6
        with:
          images: ghcr.io/${{ github.repository }}/studio
          tags: |
            type=sha
            type=ref,event=branch
            type=semver,pattern={{version}}
      - uses: docker/build-push-action@v7
        with:
          context: .
          file: studio/Dockerfile
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

`metadata-action` adds the `org.opencontainers.image.source` label, which links each package to the repo. A package pushed first from a laptop without that label is not linked, and the workflow's push to it then fails. Delete that package or link it in its settings.

## Steps for each deploy

1. **Push the commit.** For a build, push `master`. For a release, the user names the version, and you push the tag:

	```bash
	git tag -a v0.4.0 -m "v0.4.0" && git push origin v0.4.0
	```

	Never move or delete a pushed release tag.
2. **Watch the run.** Read the newest run for the commit through the REST API, with the token piped in:

	```bash
	printf 'Authorization: Bearer %s\n' "$GITHUB_TOKEN" | curl -sS -H @- \
		-H 'Accept: application/vnd.github+json' \
		"https://api.github.com/repos/<owner>/<repo>/actions/runs?head_sha=$(git rev-parse HEAD)&per_page=1"
	```

	Wait for `status: completed` and `conclusion: success`. With `gh`, run `gh run watch`.
3. **Make the images pullable.** A new package is private. Either give the cluster a pull secret with a token that has `read:packages`, or make the package public under **Package settings**. Making a package public cannot be undone, so ask first.

	`kubectl create secret docker-registry` takes the password only in argv, so build the secret from a throwaway Docker config instead:

	```bash
	export DOCKER_CONFIG=$(mktemp -d)
	docker login ghcr.io -u <user> --password-stdin < ~/.config/github/ghcr-read.pat
	kubectl --context <ctx> -n <ns> create secret generic ghcr --type=kubernetes.io/dockerconfigjson \
		--from-file=.dockerconfigjson="$DOCKER_CONFIG/config.json"
	rm -rf "$DOCKER_CONFIG"; unset DOCKER_CONFIG
	```

4. **Roll out on the cluster** with the `flink-jobs` image, `jarURI: local:///opt/flink/usrlib/event-processor.jar`, and the `studio` image. Follow the cluster's reference, then [Verify](../SKILL.md#5-verify).

## Push from a laptop instead

When there is no workflow yet, and the user asks for a manual push. The container registry accepts only a classic personal access token with `write:packages`. A fine-grained token, or the git credential, does not work for it.

```bash
docker login ghcr.io -u <user> --password-stdin < ~/.config/github/ghcr.pat
TAG=sha-$(git rev-parse --short=7 HEAD)
docker build -f studio/Dockerfile -t ghcr.io/<owner>/cdp-journey-engine/studio:$TAG \
	--label org.opencontainers.image.source=https://github.com/<owner>/cdp-journey-engine .
docker push ghcr.io/<owner>/cdp-journey-engine/studio:$TAG
```

Build the two Flink images the same way, with the label, from `event-processor/`.
