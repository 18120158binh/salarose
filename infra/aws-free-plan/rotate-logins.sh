#!/usr/bin/env bash
# Runs on platform-1 as root through Session Manager; rotate-logins-remote.sh delivers it. Gives Argo CD and Grafana
# new admin passwords and stores every login in the Secrets Manager secret cdp-free-plan/logins. Safe to rerun: each
# run rotates again. Prints no password: the passwords pass through mode-600 files and stdin, never a command line.
# It replaces only the argocd, grafana, and studio entries, so every other entry, such as sim_bot, survives.
# Usage: rotate-logins.sh <dashed ip> <region>
# test-rotate-logins.sh sources this file to test merge_logins. Sourced, it defines the functions and runs nothing.
set -euo pipefail

SECRET_ID=cdp-free-plan/logins

# merge_logins <current json> <rotated json> <out>: the current logins with the rotated entries replaced.
# An empty current file means the secret has no value yet.
merge_logins() {
	"${PYTHON:-python3}" -c '
import json, sys
text = open(sys.argv[1]).read().strip()
logins = json.loads(text) if text else {}
if not isinstance(logins, dict):
    sys.exit("the stored logins are not a JSON object")
logins.update(json.load(open(sys.argv[2])))
json.dump(logins, open(sys.argv[3], "w"))
' "$1" "$2" "$3"
}

# read_logins <out>: the secret's current value, or an empty file when the secret has no value yet. Any other
# error stops the rotation, so a failed read never overwrites the entries this script does not own.
read_logins() {
	if aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SECRET_ID" \
		--query SecretString --output text >"$1" 2>"$1.err"; then
		return 0
	fi
	case $(cat "$1.err") in
		*ResourceNotFoundException*) : >"$1" ;;
		*) echo "could not read $SECRET_ID:" >&2; cat "$1.err" >&2; return 1 ;;
	esac
}

[ "${BASH_SOURCE[0]}" = "$0" ] || return 0

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml PATH=/usr/local/bin:$PATH

[ $# -eq 2 ] || { echo "usage: $0 <dashed ip> <region>" >&2; exit 2; }
IP=$1 REGION=$2

umask 077
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

command -v openssl >/dev/null || dnf install -y -q openssl >/dev/null
command -v htpasswd >/dev/null || dnf install -y -q httpd-tools >/dev/null

# The alphabet is [A-Za-z0-9], so the passwords go into JSON and curl config files without escaping.
for name in argocd grafana; do
	openssl rand -base64 24 | tr -d '/+=\n' >"$tmp/$name"
done

# Stored first, so a failure later leaves the new passwords readable and a rerun converges.
printf '{"argocd":{"url":"https://argocd.%s.sslip.io","user":"admin","password":"%s"},"grafana":{"url":"https://grafana.%s.sslip.io","user":"admin","password":"%s"},"studio":{"url":"https://studio.%s.sslip.io","note":"Cognito user, set at first sign-in"}}' \
	"$IP" "$(cat "$tmp/argocd")" "$IP" "$(cat "$tmp/grafana")" "$IP" >"$tmp/rotated.json"
read_logins "$tmp/current.json"
merge_logins "$tmp/current.json" "$tmp/rotated.json" "$tmp/logins.json"
aws secretsmanager put-secret-value --region "$REGION" --secret-id "$SECRET_ID" \
	--secret-string "file://$tmp/logins.json" >/dev/null
echo "stored in $SECRET_ID"

# Argo CD's FAQ rewrites htpasswd's $2y$ prefix to $2a$. A new mtime ends the sessions of the old password.
# shellcheck disable=SC2016
htpasswd -n -i -B -C 10 admin <"$tmp/argocd" | sed -n '1{s/^admin://;s/^\$2y\$/$2a$/;p}' >"$tmp/argocd.bcrypt"
printf '{"stringData":{"admin.password":"%s","admin.passwordMtime":"%s"}}' \
	"$(cat "$tmp/argocd.bcrypt")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$tmp/argocd-patch.json"
kubectl -n argocd patch secret argocd-secret --type merge --patch-file "$tmp/argocd-patch.json" >/dev/null
kubectl -n argocd delete secret argocd-initial-admin-secret --ignore-not-found >/dev/null
echo "argocd rotated"

# Grafana keeps its users in its own database and reads grafana-admin only when it creates that database, so both change.
kubectl -n monitoring exec -i deploy/kps-grafana -c grafana -- \
	grafana cli admin reset-admin-password --password-from-stdin <"$tmp/grafana" >/dev/null
kubectl -n monitoring create secret generic grafana-admin --dry-run=client -o yaml \
	--from-literal=admin-user=admin --from-file=admin-password="$tmp/grafana" |
	kubectl apply --server-side --field-manager=cdp-bootstrap -f - >/dev/null
echo "grafana rotated"

printf '{"username":"admin","password":"%s"}' "$(cat "$tmp/argocd")" >"$tmp/argocd-session.json"
printf 'user = "admin:%s"\n' "$(cat "$tmp/grafana")" >"$tmp/grafana-curl.conf"
argocd_ip=$(kubectl -n argocd get service argocd-server -o jsonpath='{.spec.clusterIP}')
grafana_ip=$(kubectl -n monitoring get service kps-grafana -o jsonpath='{.spec.clusterIP}')
# Argo CD reads argocd-secret through an informer, so the new hash takes a few seconds to reach the server. Fewer
# than five tries, because Argo CD delays logins after five failures.
for _ in 1 2 3 4; do
	sleep 5
	argocd_code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
		-d "@$tmp/argocd-session.json" "http://$argocd_ip/api/v1/session" || true)
	[ "$argocd_code" = 200 ] && break
done
grafana_code=$(curl -s -o /dev/null -w '%{http_code}' -K "$tmp/grafana-curl.conf" "http://$grafana_ip/api/user" || true)
echo "argocd POST /api/v1/session: $argocd_code"
echo "grafana GET /api/user: $grafana_code"
[ "$argocd_code" = 200 ] && [ "$grafana_code" = 200 ]
