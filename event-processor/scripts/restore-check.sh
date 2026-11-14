#!/usr/bin/env bash
# The image event-parse-job runs in production writes a savepoint, and the image this checkout builds restores it.
# Each version runs as the cluster runs it: its own flink-jobs image, built by the same Dockerfiles, in application
# mode with a JobManager and a TaskManager container, RocksDB, and allowNonRestoredState off. Kafka and Postgres run
# beside them. Needs docker, python3, git history, and Java 21 for the builds.
#
#   bash event-processor/scripts/restore-check.sh [<previous commit>]
#
# Without an argument, the previous commit is the image of event-parse-job on BASE_REF (default
# origin/deploy/aws-free-plan): its pin in flink-parse/pin-image.yaml while one exists, or else the flink-jobs tag of
# the environment overlay. Passes when the new JobManager logs "Restoring job ... from Savepoint" for that savepoint,
# the job is RUNNING, and it completes a checkpoint after the restore.
#
# When that commit is not in this repository, as with an image built before the history was rewritten, the previous
# commit falls back to BASE_REF itself, with a warning. The restore still runs. RESTORE_CHECK_RESOLVE_ONLY=1 prints the
# previous commit and exits; test-restore-check.sh uses it.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
BASE_REF=${BASE_REF:-origin/deploy/aws-free-plan}
PG_IMAGE=${PG_IMAGE:-postgres:16}
KAFKA_IMAGE=${KAFKA_IMAGE:-apache/kafka:3.9.1}
TIMEOUT=${RESTORE_TIMEOUT:-240}
RUN=restore-check-$$
ENTRY=com.cdp.platform.jobs.eventparser.EventParseJob
fail() { echo "FAIL: $*" >&2; exit 1; }

previous=${1:-}
explicit=$previous
pin="$BASE_REF:infra/k8s/apps/flink-parse/pin-image.yaml"
if [[ -z $previous ]] && git -C "$ROOT" cat-file -e "$pin" 2>/dev/null; then
  previous=$(git -C "$ROOT" show "$pin" | sed -n 's/^ *image: .*flink-jobs:sha-\([0-9a-f]*\)$/\1/p')
fi
if [[ -z $previous ]]; then
  previous=$(git -C "$ROOT" show "$BASE_REF:infra/k8s/envs/aws-free-plan/kustomization.yaml" \
    | sed -n '/name: cdp\/flink-jobs$/,/newTag/s/^ *newTag: sha-\([0-9a-f]*\)$/\1/p')
fi
[[ -n $previous ]] || fail "no previous image found on $BASE_REF"
if resolved=$(git -C "$ROOT" rev-parse -q --verify "$previous^{commit}"); then
  previous=$resolved
else
  [[ -z $explicit ]] || fail "commit $explicit is not in this repository"
  missing=$previous
  previous=$(git -C "$ROOT" rev-parse --verify "$BASE_REF^{commit}")
  warning="the running image's commit $missing is not in this repository; restoring from $BASE_REF ($previous) instead"
  echo "WARNING: $warning" >&2
  [[ -z ${GITHUB_ACTIONS:-} ]] || echo "::warning title=flink-restore fallback::$warning"
fi
echo "previous commit: $previous"
[[ -z ${RESTORE_CHECK_RESOLVE_ONLY:-} ]] || exit 0

WORK=$(mktemp -d)
cleanup() {
  docker rm -f "$RUN-pg" "$RUN-kafka" "$RUN-old-jm" "$RUN-old-tm" "$RUN-new-jm" "$RUN-new-tm" >/dev/null 2>&1 || true
  docker network rm "$RUN" >/dev/null 2>&1 || true
  git -C "$ROOT" worktree remove --force "$WORK/previous" >/dev/null 2>&1 || true
  # The Flink containers write the savepoint as their own user.
  docker run --rm -v "$WORK:/work" "$PG_IMAGE" rm -rf /work/savepoints >/dev/null 2>&1 || true
  rm -rf "$WORK" || true
}
trap cleanup EXIT

# The two Docker builds of build-images.yml, from a checkout's event-processor.
build_image() {
  local module=$1 tag=$2
  (cd "$module" && ./mvnw -B -q package -DskipTests)
  docker build -q -t "$tag-base" -f "$module/Dockerfile" "$module" >/dev/null
  docker build -q --build-arg "BASE_IMAGE=$tag-base" -t "$tag" -f "$module/Dockerfile.jobs" "$module" >/dev/null
}
git -C "$ROOT" worktree add --detach "$WORK/previous" "$previous" >/dev/null
build_image "$WORK/previous/event-processor" "$RUN-old"
build_image "$ROOT/event-processor" "$RUN-new"

docker network create "$RUN" >/dev/null
docker run -d --name "$RUN-pg" --network "$RUN" --network-alias pg -e POSTGRES_PASSWORD=restore \
  -e POSTGRES_DB=auroracy "$PG_IMAGE" -c wal_level=logical -c max_replication_slots=16 -c max_wal_senders=16 >/dev/null
docker run -d --name "$RUN-kafka" --network "$RUN" --network-alias kafka \
  -e KAFKA_NODE_ID=1 -e KAFKA_PROCESS_ROLES=broker,controller \
  -e KAFKA_LISTENERS=PLAINTEXT://:9092,CONTROLLER://:9093 -e KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://kafka:9092 \
  -e KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER -e KAFKA_CONTROLLER_QUORUM_VOTERS=1@localhost:9093 \
  -e KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT \
  -e KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1 -e KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1 \
  -e KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1 "$KAFKA_IMAGE" >/dev/null

for _ in $(seq 60); do
  docker exec "$RUN-pg" pg_isready -U postgres -d auroracy >/dev/null 2>&1 && break
  sleep 1
done
docker exec -i "$RUN-pg" psql -q -v ON_ERROR_STOP=1 -U postgres -d auroracy <"$ROOT/infra/db/schema.sql" >/dev/null 2>&1
for topic in snowplow.good.events.restore ingestion-api-events; do
  for _ in $(seq 30); do
    docker exec "$RUN-kafka" /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:9092 --create \
      --if-not-exists --topic "$topic" >/dev/null 2>&1 && break
    sleep 2
  done
done

mkdir -p "$WORK/savepoints" && chmod 777 "$WORK/savepoints"
job_env=(-e KAFKA_BROKERS=kafka:9092 -e DB_HOST=pg -e DB_PORT=5432 -e DB_USER=postgres -e DB_PASSWORD=restore
  -e DB_DATABASE=auroracy -e CHECKPOINT_INTERVAL=2s)

# Starts one version: a JobManager in application mode and one TaskManager.
start_version() {
  local version=$1 image=$2
  shift 2
  local properties="jobmanager.rpc.address: $RUN-$version-jm
state.backend.type: rocksdb
execution.checkpointing.savepoint-dir: file:///savepoints
taskmanager.numberOfTaskSlots: 8
parallelism.default: 1
jobmanager.memory.process.size: 1024m
taskmanager.memory.process.size: 1600m"
  docker run -d --name "$RUN-$version-jm" --network "$RUN" -v "$WORK/savepoints:/savepoints" "${job_env[@]}" \
    -e "FLINK_PROPERTIES=$properties" "$image" standalone-job --job-classname "$ENTRY" "$@" >/dev/null
  docker run -d --name "$RUN-$version-tm" --network "$RUN" -v "$WORK/savepoints:/savepoints" "${job_env[@]}" \
    -e "FLINK_PROPERTIES=$properties" "$image" taskmanager >/dev/null
}

rest() {
  local version=$1 path=$2 body=${3:-}
  if [[ -n $body ]]; then
    docker exec "$RUN-$version-jm" wget -qO- --header=Content-Type:application/json --post-data="$body" \
      "http://localhost:8081$path"
  else
    docker exec "$RUN-$version-jm" wget -qO- "http://localhost:8081$path"
  fi
}
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1], {}, {'d': d}))" "$1"; }

# Prints the job id once the job is RUNNING and has completed a checkpoint.
await_checkpoint() {
  local version=$1 job="" completed log
  for _ in $(seq "$TIMEOUT"); do
    log=$(docker logs "$RUN-$version-jm" 2>&1)
    if grep -q "Cannot map" <<<"$log"; then
      grep -m1 -o "Cannot map checkpoint/savepoint state for operator [0-9a-f]*" <<<"$log" >&2
      fail "$version job did not restore"
    fi
    job=$(rest "$version" /jobs/overview 2>/dev/null \
      | json "next((j['jid'] for j in d['jobs'] if j['state'] == 'RUNNING'), '')" 2>/dev/null || true)
    if [[ -n $job ]]; then
      completed=$(rest "$version" "/jobs/$job/checkpoints" 2>/dev/null | json "d['counts']['completed']" 2>/dev/null || echo 0)
      if [[ $completed -gt 0 ]]; then
        echo "$job"
        return
      fi
    fi
    sleep 1
  done
  docker logs "$RUN-$version-jm" 2>&1 | tail -30 >&2
  fail "$version job completed no checkpoint within ${TIMEOUT}s"
}

start_version old "$RUN-old"
old_job=$(await_checkpoint old)
echo "old job $old_job is RUNNING with a completed checkpoint"
trigger=$(rest old "/jobs/$old_job/stop" '{"targetDirectory":"file:///savepoints","drain":false}' | json "d['request-id']")
savepoint=""
for _ in $(seq "$TIMEOUT"); do
  # An application-mode JobManager exits once its job stops, so the savepoint on disk is the fallback.
  written=$(find "$WORK/savepoints" -maxdepth 1 -name "savepoint-*" -type d 2>/dev/null | head -1)
  if [[ -n $written && -f $written/_metadata ]]; then
    savepoint="file:/savepoints/$(basename "$written")"
    break
  fi
  status=$(rest old "/jobs/$old_job/savepoints/$trigger" 2>/dev/null | json "d['status']['id']" 2>/dev/null || true)
  if [[ $status == COMPLETED ]]; then
    savepoint=$(rest old "/jobs/$old_job/savepoints/$trigger" | json "d['operation'].get('location', '')")
    [[ -n $savepoint ]] || fail "stop with savepoint failed: $(rest old "/jobs/$old_job/savepoints/$trigger")"
    break
  fi
  sleep 1
done
[[ -n $savepoint ]] || fail "no savepoint within ${TIMEOUT}s"
echo "old job stopped with savepoint $savepoint"
docker rm -f "$RUN-old-jm" "$RUN-old-tm" >/dev/null

start_version new "$RUN-new" --fromSavepoint "$savepoint"
new_job=$(await_checkpoint new)
restored=$(rest new "/jobs/$new_job/checkpoints" | json "(d['latest'].get('restored') or {}).get('external_path', '')")
new_log=$(docker logs "$RUN-new-jm" 2>&1)
grep -m1 "Restoring job .* from Savepoint" <<<"$new_log" || fail "the new JobManager logged no restore"
[[ $(basename "$restored") == "$(basename "$savepoint")" ]] || fail "new job restored '$restored', not $savepoint"
echo "ok: new job $new_job restored $savepoint, is RUNNING, and completed a checkpoint"
