#!/usr/bin/env bash
# Runs on platform-1 as root through Session Manager; bootstrap.sh delivers it. Safe to rerun.
# Usage: bootstrap-cluster.sh <cognito pool id> <studio client id> <flink-ui client id> <argocd client id>
#   <grafana client id> <kafka-ui client id> <ip dashed> <region> <root-app.yaml>
set -euo pipefail

ARGOCD_VERSION=v3.6.1
REPO_URL=git@github.com:18120158binh/salarose.git
DEPLOY_KEY=/var/lib/cdp/argocd-deploy-key
LOGINS_SECRET=cdp-free-plan/logins

# json_get <file> <key>.<key> <out>: writes the non-empty string at that path of a JSON object to <out>, or fails
# without output, so no message can echo a secret.
json_get() {
	"${PYTHON:-python3}" -c '
import json, sys
try:
    value = json.load(open(sys.argv[1]))
    for key in sys.argv[2].split("."):
        value = value.get(key) if isinstance(value, dict) else None
except Exception:
    sys.exit(1)
if not isinstance(value, str) or not value:
    sys.exit(1)
open(sys.argv[3], "w").write(value)
' "$1" "$2" "$3"
}

# ensure_argocd_token <region> <dir>: gives studio a read-only Argo CD API token for the account studio-health, in
# cdp/studio-platform key argocd-token. A rerun keeps the token studio holds while Argo CD accepts it; a missing or
# rejected one replaces the token id studio-platform. The node logs in to Argo CD's API as the break-glass admin, with
# the password from argocd-initial-admin-secret, or from LOGINS_SECRET once rotate-logins has deleted that secret. The
# logins secret outlives a rebuilt server, so it is the stale one of the two. The CLI's core mode cannot do this: it
# runs with the argocd-server service account, which may not list services. The password, the session, and the token
# pass only through mode-600 files in <dir>, never a command line or the output. Argo CD answers 415 to any request
# but a GET without the JSON content type, so every other request sends it.
ensure_argocd_token() {
	local region=$1 dir=$2 server code
	kubectl -n argocd rollout status deployment argocd-server --timeout=300s >/dev/null
	server=http://$(kubectl -n argocd get service argocd-server -o jsonpath='{.spec.clusterIP}')

	if kubectl -n cdp get secret studio-platform -o go-template='{{index .data "argocd-token"}}' 2>/dev/null |
		base64 -d >"$dir/existing-token" 2>/dev/null && [ -s "$dir/existing-token" ]; then
		printf 'Authorization: Bearer %s\n' "$(<"$dir/existing-token")" >"$dir/existing.header"
		code=$(curl -s -o /dev/null -w '%{http_code}' -H "@$dir/existing.header" \
			"$server/api/v1/applications?fields=items.metadata.name" || true)
		case $code in
		200)
			echo "argocd token: kept"
			return 0
			;;
		401 | 403) echo "argocd token: rejected ($code), replacing it" ;;
		*)
			echo "argocd GET /api/v1/applications: $code" >&2
			return 1
			;;
		esac
	fi

	if kubectl -n argocd get secret argocd-initial-admin-secret -o go-template='{{.data.password}}' 2>/dev/null |
		base64 -d >"$dir/admin-password" 2>/dev/null && [ -s "$dir/admin-password" ]; then
		echo "argocd admin password: from argocd-initial-admin-secret"
	elif aws secretsmanager get-secret-value --region "$region" --secret-id "$LOGINS_SECRET" \
		--query SecretString --output text >"$dir/logins" 2>/dev/null &&
		json_get "$dir/logins" argocd.password "$dir/admin-password"; then
		echo "argocd admin password: from $LOGINS_SECRET"
	else
		echo "no Argo CD admin password in argocd-initial-admin-secret or $LOGINS_SECRET" >&2
		return 1
	fi
	"${PYTHON:-python3}" -c '
import json, sys
json.dump({"username": "admin", "password": open(sys.argv[1]).read()}, open(sys.argv[2], "w"))
' "$dir/admin-password" "$dir/session.json"

	code=$(curl -s -o "$dir/session" -w '%{http_code}' -H 'Content-Type: application/json' \
		-d "@$dir/session.json" "$server/api/v1/session" || true)
	if [ "$code" != 200 ] || ! json_get "$dir/session" token "$dir/jwt"; then
		echo "argocd POST /api/v1/session: $code" >&2
		return 1
	fi
	printf 'Authorization: Bearer %s\n' "$(<"$dir/jwt")" >"$dir/auth.header"

	# CreateToken refuses an id that exists, so the old one goes first. 404 means there was none.
	code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "@$dir/auth.header" -H 'Content-Type: application/json' \
		"$server/api/v1/account/studio-health/token/studio-platform" || true)
	if [ "$code" != 200 ] && [ "$code" != 404 ]; then
		echo "argocd DELETE /api/v1/account/studio-health/token/studio-platform: $code" >&2
		return 1
	fi
	echo "argocd DELETE token studio-platform: $code"
	code=$(curl -s -o "$dir/token.json" -w '%{http_code}' -H "@$dir/auth.header" -H 'Content-Type: application/json' \
		-d '{"id":"studio-platform"}' "$server/api/v1/account/studio-health/token" || true)
	if [ "$code" != 200 ] || ! json_get "$dir/token.json" token "$dir/argocd-token"; then
		echo "argocd POST /api/v1/account/studio-health/token: $code" >&2
		return 1
	fi
	kubectl -n cdp create secret generic studio-platform --dry-run=client -o yaml \
		--from-file=argocd-token="$dir/argocd-token" |
		kubectl apply --server-side --field-manager=cdp-sso -f - >/dev/null
	echo "argocd token: created for studio-health"
}

# Sourced, this file defines the functions above and runs nothing.
[ "${BASH_SOURCE[0]}" = "$0" ] || return 0

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml PATH=/usr/local/bin:$PATH

[ $# -eq 9 ] || {
	echo "usage: $0 <pool id> <studio client id> <flink-ui client id> <argocd client id> <grafana client id>" \
		"<kafka-ui client id> <ip dashed> <region> <root-app.yaml>" >&2
	exit 2
}
POOL_ID=$1 CLIENT_ID=$2 FLINK_UI_CLIENT_ID=$3 ARGOCD_CLIENT_ID=$4 GRAFANA_CLIENT_ID=$5 KAFKA_UI_CLIENT_ID=$6
IP_DASHED=$7 REGION=$8 ROOT_APP=$9

umask 077
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

for _ in $(seq 60); do
	ready=$(kubectl get nodes --no-headers 2>/dev/null | awk '$2 == "Ready"' | wc -l)
	[ "$ready" -ge 6 ] && break
	sleep 10
done
[ "$ready" -ge 6 ] || { echo "only $ready of 6 nodes are Ready" >&2; exit 1; }

for ns in argocd cdp monitoring; do
	kubectl create namespace "$ns" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
done

kubectl apply --server-side --force-conflicts -n argocd \
	-f "https://raw.githubusercontent.com/argoproj/argo-cd/${ARGOCD_VERSION}/manifests/install.yaml" >/dev/null
for workload in $(kubectl -n argocd get deployment,statefulset -o name); do
	kubectl -n argocd patch "$workload" --type merge \
		-p '{"spec":{"template":{"spec":{"nodeSelector":{"cdp.io/pool":"platform"}}}}}' >/dev/null
done
# Traefik terminates TLS, so argocd-server serves plain HTTP behind it.
if ! kubectl -n argocd patch configmap argocd-cmd-params-cm --type merge \
	-p '{"data":{"server.insecure":"true"}}' | grep -q 'no change'; then
	kubectl -n argocd rollout restart deployment argocd-server >/dev/null
fi

# Argo CD does not judge an Application's health by default, so without this check a sync wave of child
# Applications would not wait for the operators they install.
cat >"$tmp/app-health.lua" <<'EOF'
hs = { status = "Progressing", message = "" }
if obj.status ~= nil and obj.status.health ~= nil then
  hs.status = obj.status.health.status
  if obj.status.health.message ~= nil then
    hs.message = obj.status.health.message
  end
end
return hs
EOF
kubectl -n argocd create configmap argocd-cm --dry-run=client -o yaml \
	--from-file=resource.customizations.health.argoproj.io_Application="$tmp/app-health.lua" |
	kubectl label --local -f - app.kubernetes.io/part-of=argocd -o yaml |
	kubectl apply --server-side --field-manager=cdp-bootstrap --force-conflicts -f - >/dev/null

# Keeps an existing value, so a rerun does not end sessions or change the Grafana password. A new value is
# <bytes> random bytes, hex-encoded (default 32).
existing_or_new() {
	local ns=$1 name=$2 key=$3 out=$4 bytes=${5:-32} value
	value=$(kubectl -n "$ns" get secret "$name" -o go-template="{{index .data \"$key\"}}" 2>/dev/null || true)
	if [ -n "$value" ] && [ "$value" != "<no value>" ]; then
		printf '%s' "$value" | base64 -d >"$out"
	else
		openssl rand -hex "$bytes" | tr -d '\n' >"$out"
	fi
}

apply_secret() {
	kubectl apply --server-side --field-manager=cdp-bootstrap -f - >/dev/null
}

command -v openssl >/dev/null || dnf install -y -q openssl

client_secret() {
	local client=$1 out=$2
	aws cognito-idp describe-user-pool-client --region "$REGION" --user-pool-id "$POOL_ID" --client-id "$client" \
		--query UserPoolClient.ClientSecret --output text | tr -d '\n' >"$out"
	if [ ! -s "$out" ] || [ "$(cat "$out")" = None ]; then
		echo "the Cognito client $client has no secret" >&2
		exit 1
	fi
}

client_secret "$CLIENT_ID" "$tmp/oidc"
existing_or_new cdp studio-env SESSION_SECRET "$tmp/session"
kubectl -n cdp create secret generic studio-env --dry-run=client -o yaml \
	--from-file=OIDC_CLIENT_SECRET="$tmp/oidc" --from-file=SESSION_SECRET="$tmp/session" | apply_secret

# oauth2-proxy takes a cookie secret of 16, 24, or 32 bytes; 16 random bytes hex-encode to 32.
client_secret "$FLINK_UI_CLIENT_ID" "$tmp/flink-ui-oidc"
existing_or_new cdp flink-ui-auth cookie-secret "$tmp/flink-ui-cookie" 16
kubectl -n cdp create secret generic flink-ui-auth --dry-run=client -o yaml \
	--from-literal=client-id="$FLINK_UI_CLIENT_ID" --from-file=client-secret="$tmp/flink-ui-oidc" \
	--from-file=cookie-secret="$tmp/flink-ui-cookie" | apply_secret

existing_or_new monitoring grafana-admin admin-password "$tmp/grafana"
kubectl -n monitoring create secret generic grafana-admin --dry-run=client -o yaml \
	--from-literal=admin-user=admin --from-file=admin-password="$tmp/grafana" | apply_secret

# Single sign-on through each tool's own Cognito app client (AFP-FR-27). Argo CD resolves $argocd-oidc:client-secret
# only from a secret labeled part-of=argocd. The local admin accounts stay enabled as break-glass logins (AFP-FR-32).
sso_secret() {
	local ns=$1 name=$2 client=$3
	client_secret "$client" "$tmp/$name"
	kubectl -n "$ns" create secret generic "$name" --dry-run=client -o yaml \
		--from-literal=client-id="$client" --from-file=client-secret="$tmp/$name"
}
sso_secret argocd argocd-oidc "$ARGOCD_CLIENT_ID" |
	kubectl label --local -f - app.kubernetes.io/part-of=argocd -o yaml | apply_secret
sso_secret monitoring grafana-oidc "$GRAFANA_CLIENT_ID" | apply_secret
sso_secret cdp kafka-ui-oidc "$KAFKA_UI_CLIENT_ID" | apply_secret

# Argo CD reloads both config maps without a restart. A field manager of their own keeps these keys apart from the
# health check above, so neither apply removes the other's keys. studio-health is the API account that studio's
# Platform page uses to read application health. Argo CD applies policy.default to every subject first, so it has
# read-only access to everything Argo CD shows, application logs included, and no write. Its token stays on studio's
# server.
cat >"$tmp/oidc.config" <<EOF
name: Cognito
issuer: https://cognito-idp.${REGION}.amazonaws.com/${POOL_ID}
clientID: ${ARGOCD_CLIENT_ID}
clientSecret: \$argocd-oidc:client-secret
requestedScopes: ["openid", "email", "profile"]
EOF
kubectl -n argocd create configmap argocd-cm --dry-run=client -o yaml \
	--from-literal=url="https://argocd.${IP_DASHED}.sslip.io" --from-literal=admin.enabled=true \
	--from-literal=accounts.studio-health=apiKey \
	--from-file=oidc.config="$tmp/oidc.config" |
	kubectl label --local -f - app.kubernetes.io/part-of=argocd -o yaml |
	kubectl apply --server-side --field-manager=cdp-sso --force-conflicts -f - >/dev/null
kubectl -n argocd create configmap argocd-rbac-cm --dry-run=client -o yaml \
	--from-literal=policy.default=role:readonly --from-literal=policy.csv='g, studio-admin, role:admin' \
	--from-literal=scopes='[cognito:groups]' |
	kubectl label --local -f - app.kubernetes.io/part-of=argocd -o yaml |
	kubectl apply --server-side --field-manager=cdp-sso --force-conflicts -f - >/dev/null

mkdir -p "$(dirname "$DEPLOY_KEY")"
[ -f "$DEPLOY_KEY" ] || ssh-keygen -q -t ed25519 -N '' -C argocd@cdp-free-plan -f "$DEPLOY_KEY"
kubectl -n argocd create secret generic repo-salarose --dry-run=client -o yaml \
	--from-literal=type=git --from-literal=url="$REPO_URL" --from-file=sshPrivateKey="$DEPLOY_KEY" |
	kubectl label --local -f - argocd.argoproj.io/secret-type=repository -o yaml | apply_secret

kubectl wait --for condition=established --timeout=120s crd/applications.argoproj.io >/dev/null
kubectl apply --server-side -f "$ROOT_APP" >/dev/null

echo "Add this key as a read-only deploy key at https://github.com/18120158binh/salarose/settings/keys"
cat "${DEPLOY_KEY}.pub"

# Last, so a failure here still leaves the repo secret, the root app, and the deploy key above.
ensure_argocd_token "$REGION" "$tmp"
