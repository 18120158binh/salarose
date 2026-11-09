#!/usr/bin/env bash
# Fails a change that removes a Flink image pin while the flink-jobs image the base branch deploys lacks some of the
# change's event-processor code. A merge applies manifests at once, but the image tag commit for new code lands only
# after CI builds it, so removing a pin in the same change rolls the job to the old tag first (incident 3, 2026-11-08).
#
#   BASE_REF=origin/deploy/aws-free-plan bash .github/scripts/check-pin-removal.sh [<head>]
set -euo pipefail

BASE_REF=${BASE_REF:-origin/deploy/aws-free-plan}
HEAD=${1:-HEAD}
OVERLAY=infra/k8s/envs/aws-free-plan/kustomization.yaml

removed=$(git diff --name-only --diff-filter=D "$(git merge-base "$BASE_REF" "$HEAD")" "$HEAD" -- 'infra/k8s/apps/*/pin-image.yaml')
if [[ -z $removed ]]; then
  echo "ok: no image pin removed"
  exit 0
fi

tag=$(git show "$BASE_REF:$OVERLAY" | sed -n '/name: cdp\/flink-jobs$/,/newTag/s/^ *newTag: sha-\([0-9a-f]*\)$/\1/p')
deployed=$(git rev-parse -q --verify "${tag:-none}^{commit}" || true)
if [[ -z $deployed ]]; then
  echo "FAIL: removes $removed, but the flink-jobs tag 'sha-$tag' on $BASE_REF names no known commit" >&2
  exit 1
fi
if ! git diff --quiet "$deployed" "$HEAD" -- event-processor; then
  echo "FAIL: removes $removed, but the deployed flink-jobs image sha-$tag lacks these event-processor changes:" >&2
  git diff --stat "$deployed" "$HEAD" -- event-processor >&2
  echo "Merge the code first, wait for its image tag commit, then remove the pin in a change of its own." >&2
  exit 1
fi
echo "ok: removes $removed, and the deployed image sha-$tag has all of this change's event-processor code"
