#!/usr/bin/env bash
# Runs bootstrap-cluster.sh on platform-1 through Session Manager, with the ids from the Terraform state. Run it after
# terraform apply -var stage=all, once all six nodes are Ready. Safe to rerun.
set -euo pipefail
export MSYS_NO_PATHCONV=1 AWS_PAGER=""

REGION=us-east-1
HERE=$(cd "$(dirname "$0")" && pwd)
TERRAFORM=${TERRAFORM:-terraform}

log() { printf '%s\n' "$*" >&2; }

# aws.exe on Windows ends text output with CRLF.
awsr() { aws --region "$REGION" "$@" | tr -d '\r'; }

# aws.exe cannot read a Git Bash path such as /tmp/x.
winpath() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

tf_output() { "$TERRAFORM" -chdir="$(winpath "$HERE/terraform")" output -raw "$1" | tr -d '\r'; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

pool=$(tf_output cognito_pool_id)
client=$(tf_output cognito_client_id)
flink_client=$(tf_output flink_ui_client_id)
argocd_client=$(tf_output argocd_client_id)
grafana_client=$(tf_output grafana_client_id)
kafka_ui_client=$(tf_output kafka_ui_client_id)
ip=$(tf_output ip_dashed)
id=$("$TERRAFORM" -chdir="$(winpath "$HERE/terraform")" output -json instance_ids | tr -d '\r' |
	grep -o '"platform-1": *"i-[0-9a-f]*"' | grep -o 'i-[0-9a-f]*')
[ -n "$id" ] || { log "platform-1 is not in the Terraform state; apply stage server first"; exit 1; }

status=$(awsr ssm describe-instance-information --filters "Key=InstanceIds,Values=$id" \
	--query 'InstanceInformationList[0].PingStatus' --output text)
[ "$status" = Online ] || { log "platform-1 is not Online in Systems Manager yet ($status)"; exit 1; }

# Base64 keeps the files intact through the JSON parameter; neither file holds a secret.
params=$WORK/bootstrap-params.json
printf '{"executionTimeout":["1800"],"commands":["set -e","mkdir -p /opt/cdp","echo %s | base64 -d >/opt/cdp/bootstrap-cluster.sh","echo %s | base64 -d >/opt/cdp/root-app.yaml","bash /opt/cdp/bootstrap-cluster.sh %s %s %s %s %s %s %s %s /opt/cdp/root-app.yaml"]}' \
	"$(base64 -w0 "$HERE/bootstrap-cluster.sh")" "$(base64 -w0 "$HERE/root-app.yaml")" "$pool" "$client" "$flink_client" \
	"$argocd_client" "$grafana_client" "$kafka_ui_client" "$ip" "$REGION" >"$params"
cmd=$(awsr ssm send-command --instance-ids "$id" --document-name AWS-RunShellScript --timeout-seconds 600 \
	--comment "cdp bootstrap-cluster" --parameters "file://$(winpath "$params")" --query Command.CommandId --output text)
log "sent command $cmd to $id; waiting"
while :; do
	status=$(awsr ssm get-command-invocation --command-id "$cmd" --instance-id "$id" --query Status --output text 2>/dev/null || true)
	case $status in
		Pending | InProgress | Delayed | "") sleep 15 ;;
		*) break ;;
	esac
done
awsr ssm get-command-invocation --command-id "$cmd" --instance-id "$id" \
	--query '[StandardOutputContent,StandardErrorContent]' --output text
[ "$status" = Success ] || { log "bootstrap ended with status $status"; exit 1; }
