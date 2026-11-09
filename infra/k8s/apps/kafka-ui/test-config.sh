#!/usr/bin/env bash
# Runs the kafka block of config.yml in kafka-ui's pinned image against a one-node Kafka, and checks that the
# unauthenticated /metrics endpoint holds no metric of the cluster (AFP-FR-30). A control run without
# prometheusExpose must show them, so the check can fail. Needs docker and curl; CI runs it.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
image=$(grep -o 'ghcr.io/kafbat/kafka-ui:[^ ]*' "$here/kafka-ui.yaml")
kafka_image=docker.io/apache/kafka:4.3.2@sha256:852a0d49fc4e656b022e7f23785411802c9a088c78a7c5e39f33969de9c227a7
net=kafka-ui-test
conf=$(mktemp -d)
cleanup() {
	docker rm -f "$net-kafka" "$net-tested" "$net-control" >/dev/null 2>&1 || true
	docker network rm "$net" >/dev/null 2>&1 || true
	rm -rf "$conf"
}
trap cleanup EXIT

mkdir "$conf/tested" "$conf/control"
# Spring replaces a whole list when an env var sets one index, so the test edits the file instead.
awk '/^[^ #]/ { keep = ($0 == "kafka:") } keep' "$here/config.yml" |
	sed 's/^\( *bootstrapServers:\) .*/\1 kafka:9092/' >"$conf/tested/config.yml"
grep -q '^ *bootstrapServers: kafka:9092$' "$conf/tested/config.yml" || { echo "config.yml has no bootstrapServers line" >&2; exit 1; }
grep -q '^ *prometheusExpose: false$' "$conf/tested/config.yml" || { echo "config.yml sets no prometheusExpose: false" >&2; exit 1; }
grep -v '^ *prometheusExpose:' "$conf/tested/config.yml" >"$conf/control/config.yml"
chmod -R a+rX "$conf"

docker network create "$net" >/dev/null
docker run -d --name "$net-kafka" --network "$net" --network-alias kafka \
	-e KAFKA_NODE_ID=1 -e KAFKA_PROCESS_ROLES=broker,controller \
	-e KAFKA_LISTENERS=PLAINTEXT://:9092,CONTROLLER://:9093 -e KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://kafka:9092 \
	-e KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER -e KAFKA_CONTROLLER_QUORUM_VOTERS=1@kafka:9093 \
	-e KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT \
	-e KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1 "$kafka_image" >/dev/null

port=18081
for run in tested control; do
	docker run -d --name "$net-$run" --network "$net" -p "$port:8080" -v "$conf/$run:/config:ro" \
		-e SPRING_CONFIG_ADDITIONAL-LOCATION=/config/config.yml -e AUTH_TYPE=DISABLED "$image" >/dev/null
	port=$((port + 1))
done

scraped() { docker logs "$1" 2>&1 | grep -q 'Metrics updated for cluster: cdp'; }
for _ in $(seq 60); do
	scraped "$net-tested" && scraped "$net-control" && break
	sleep 3
done
if ! scraped "$net-tested" || ! scraped "$net-control"; then
	docker logs "$net-tested" 2>&1 | tail -40 >&2
	echo "kafka-ui never read the cluster's state" >&2
	exit 1
fi

exposed() { curl -fs "http://localhost:$1/metrics" | grep -c 'cluster="cdp"' || true; }
control=0
for _ in $(seq 20); do
	control=$(exposed 18082)
	[ "$control" -gt 0 ] && break
	sleep 3
done
if [ "$control" -eq 0 ]; then
	curl -s -w '\nHTTP %{http_code}\n' "http://localhost:18082/metrics" | tail -20 >&2
	echo "control: /metrics never showed the cluster, so the check proves nothing" >&2
	exit 1
fi
code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:18081/metrics")
[ "$code" = 200 ] || { echo "tested: /metrics answered $code, not 200, so the check proves nothing" >&2; exit 1; }
tested=$(exposed 18081)
[ "$tested" -eq 0 ] || { echo "/metrics exposes $tested lines of the cluster without sign-in" >&2; exit 1; }
echo "ok: /metrics holds 0 lines of the cluster (control: $control)"
