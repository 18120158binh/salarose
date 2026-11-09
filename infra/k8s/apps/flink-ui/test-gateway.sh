#!/usr/bin/env bash
# Runs nginx.conf in the gateway's pinned image, with Docker's DNS in place of kube-dns and no JobManager behind it,
# and checks the read-only rules of AFP-FR-25 and the routes of AFP-FR-23. Needs docker and curl; CI runs it.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
image=$(grep -o 'docker.io/nginxinc/nginx-unprivileged:[^ ]*' "$here/gateway.yaml")
name=flink-ui-gateway-test
port=18080
job=00000000000000000000000000000000

conf=$(mktemp -d)
cleanup() {
	docker rm -f "$name" >/dev/null 2>&1 || true
	docker network rm "$name" >/dev/null 2>&1 || true
	rm -rf "$conf"
}
trap cleanup EXIT

sed 's/^resolver kube-dns\.kube-system\.svc\.cluster\.local /resolver 127.0.0.11 /' "$here/nginx.conf" >"$conf/default.conf"
grep -q '^resolver 127.0.0.11 ' "$conf/default.conf" || { echo "nginx.conf has no kube-dns resolver line to replace" >&2; exit 1; }
cp "$here/index.html" "$conf/index.html"
chmod -R a+rX "$conf"

docker network create "$name" >/dev/null
docker run -d --name "$name" --network "$name" -p "$port:8080" -v "$conf:/etc/nginx/conf.d:ro" "$image" >/dev/null
for _ in $(seq 30); do
	curl -fs -o /dev/null "http://localhost:$port/" && break
	sleep 1
done

failures=0
expect() {
	local want=$1 method=$2 path=$3 got
	if [ "$method" = HEAD ]; then
		got=$(curl -s -o /dev/null -w '%{http_code}' --head --path-as-is "http://localhost:$port$path")
	else
		got=$(curl -s -o /dev/null -w '%{http_code}' -X "$method" --path-as-is "http://localhost:$port$path")
	fi
	if [ "$got" = "$want" ]; then
		echo "ok   $want $method $path"
	else
		echo "FAIL $method $path: want $want, got $got"
		failures=$((failures + 1))
	fi
}

expect 200 GET /
expect 200 HEAD /
expect 301 GET /event-parse-job
expect 404 GET /default.conf
expect 404 GET /unknown-job/
expect 502 GET /event-parse-job/jobs/overview
expect 502 HEAD /customer-decision-job/jobs/overview

expect 403 GET "/event-parse-job/jobs/$job/yarn-cancel"
expect 403 GET "/event-parse-job/jobs/$job/yarn-stop"
expect 403 HEAD "/campaign-outbox-job/jobs/$job/yarn-cancel"
expect 403 GET "/event-parse-job/v1/jobs/$job/yarn-cancel"
expect 403 GET "/event-parse-job/jobs/$job/YARN-CANCEL"
expect 403 GET "/event-parse-job/jobs/$job/%79arn-cancel"
expect 403 GET "/event-parse-job//jobs//$job//yarn-cancel"
expect 403 GET "/event-parse-job/jobs/x/../$job/yarn-cancel"
expect 403 GET "/event-parse-job/jobs/$job/yarn-cancel?mode=cancel"

expect 405 PATCH "/event-parse-job/jobs/$job?mode=cancel"
expect 405 POST "/event-parse-job/jobs/$job/stop"
expect 405 POST "/event-parse-job/jobs/$job/savepoints"
expect 405 PUT "/event-parse-job/jobs/$job/resource-requirements"
expect 405 PATCH "/event-parse-job/jobs/$job/rescaling"
expect 405 POST /event-parse-job/jobs
expect 405 DELETE /event-parse-job/cluster
expect 405 POST /

if [ "$failures" -ne 0 ]; then
	docker logs "$name" 2>&1 | tail -20
	echo "$failures check(s) failed" >&2
	exit 1
fi
