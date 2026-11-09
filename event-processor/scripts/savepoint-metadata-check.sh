#!/usr/bin/env bash
# Checks that an event-parse-job image maps every operator state of a real savepoint or retained checkpoint. Runs the
# image as the cluster does (application mode, standalone-job) with only the _metadata file, so the JobManager runs
# its restore mapping and no task reads state. Needs docker. With an s3:// path it also needs the aws CLI and read
# access to the bucket.
#
#   bash event-processor/scripts/savepoint-metadata-check.sh <image> <s3://.../savepoint-x | local dir with _metadata>
#
# Passes when the JobManager logs "Restoring job ... from Savepoint", and fails on "Cannot map" or a timeout.
set -euo pipefail

IMAGE=${1:?image}
SAVEPOINT=${2:?savepoint path}
WAIT_SECONDS=${WAIT_SECONDS:-90}
WORK=$(mktemp -d)
NAME=savepoint-check-$$
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

if [[ $SAVEPOINT == s3://* ]]; then
  aws s3 cp --only-show-errors "${SAVEPOINT%/}/_metadata" "$WORK/_metadata"
else
  cp "$SAVEPOINT/_metadata" "$WORK/_metadata"
fi
chmod -R a+rwX "$WORK"

docker run -d --name "$NAME" -v "$WORK:/savepoint" -e DB_PASSWORD=unused \
  -e "FLINK_PROPERTIES=jobmanager.memory.process.size: 1024m" "$IMAGE" standalone-job \
  --job-classname com.cdp.platform.jobs.eventparser.EventParseJob --fromSavepoint file:///savepoint >/dev/null

for _ in $(seq "$WAIT_SECONDS"); do
  log=$(docker logs "$NAME" 2>&1)
  if grep -q "Cannot map" <<<"$log"; then
    grep -m1 -o "Cannot map checkpoint/savepoint state for operator [0-9a-f]*" <<<"$log" >&2
    echo "FAIL: $IMAGE does not restore $SAVEPOINT" >&2
    exit 1
  fi
  if grep -q "Restoring job .* from Savepoint" <<<"$log"; then
    grep -m1 "Restoring job .* from Savepoint" <<<"$log"
    echo "ok: $IMAGE maps every operator state of $SAVEPOINT"
    exit 0
  fi
  sleep 1
done
docker logs "$NAME" 2>&1 | tail -20 >&2
echo "FAIL: no restore decision within ${WAIT_SECONDS}s" >&2
exit 1
