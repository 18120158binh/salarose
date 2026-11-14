#!/usr/bin/env bash
# Checks how restore-check.sh picks the previous commit, in a throwaway git repository, without docker or a build.
# Needs git; CI runs it before the restore.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(mktemp -d)
trap 'rm -rf "$repo"' EXIT
git -C "$repo" init -q -b base
git -C "$repo" config user.email test@example.com
git -C "$repo" config user.name test
mkdir -p "$repo/event-processor/scripts" "$repo/infra/k8s/envs/aws-free-plan" "$repo/infra/k8s/apps/flink-parse"
cp "$here/restore-check.sh" "$repo/event-processor/scripts/"

commit() { git -C "$repo" add -A && git -C "$repo" commit -qm "$1" && git -C "$repo" rev-parse HEAD; }
overlay() {
  printf 'images:\n  - name: cdp/flink-jobs\n    newName: registry/cdp/flink-jobs\n    newTag: sha-%s\n' "$1" \
    >"$repo/infra/k8s/envs/aws-free-plan/kustomization.yaml"
}
resolve() { BASE_REF=base RESTORE_CHECK_RESOLVE_ONLY=1 GITHUB_ACTIONS='' bash "$repo/event-processor/scripts/restore-check.sh" 2>&1; }

failures=0
expect() {
  local name=$1 want=$2 got=$3
  if grep -qF -- "$want" <<<"$got"; then
    echo "ok: $name"
  else
    echo "FAIL: $name: want '$want' in:" >&2
    echo "$got" >&2
    failures=$((failures + 1))
  fi
}

running=$(commit "running image")

overlay "${running:0:12}"
head=$(commit "tag the running image")
expect "a tag in the history resolves to its commit" "previous commit: $running" "$(resolve)"

printf '    image: registry/cdp/flink-jobs:sha-%s\n' "${running:0:12}" >"$repo/infra/k8s/apps/flink-parse/pin-image.yaml"
overlay 0123456789ab
commit "pin the running image" >/dev/null
expect "the pin wins over the overlay" "previous commit: $running" "$(resolve)"
git -C "$repo" rm -q "$repo/infra/k8s/apps/flink-parse/pin-image.yaml"

overlay d6d59d45c02c
head=$(commit "tag an image from a rewritten history")
out=$(resolve || true)
expect "a tag outside the history warns" "WARNING: the running image's commit d6d59d45c02c is not in this repository" "$out"
expect "a tag outside the history falls back to the base ref" "previous commit: $head" "$out"

printf 'images: []\n' >"$repo/infra/k8s/envs/aws-free-plan/kustomization.yaml"
commit "no flink-jobs tag" >/dev/null
if out=$(resolve); then
  expect "no tag fails" "exit status 1" "exit status 0: $out"
else
  expect "no tag fails" "FAIL: no previous image found on base" "$out"
fi

[[ $failures -eq 0 ]] || { echo "$failures failed" >&2; exit 1; }
