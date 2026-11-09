#!/usr/bin/env bash
# Runs rotate-logins.sh on platform-1 through Session Manager, with the ids from the Terraform state. Needs the secret
# cdp-free-plan/logins, which terraform apply creates. Safe to rerun: each run rotates the Argo CD and Grafana
# passwords again. The command output holds no password; show-logins.sh reads them.
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

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

ip=$("$TERRAFORM" -chdir="$(winpath "$HERE/terraform")" output -raw ip_dashed | tr -d '\r')
id=$("$TERRAFORM" -chdir="$(winpath "$HERE/terraform")" output -json instance_ids | tr -d '\r' |
	grep -o '"platform-1": *"i-[0-9a-f]*"' | grep -o 'i-[0-9a-f]*')
[ -n "$id" ] || { log "platform-1 is not in the Terraform state"; exit 1; }

# Base64 keeps the script intact through the JSON parameter; it holds no secret.
params=$WORK/rotate-params.json
printf '{"commands":["set -e","mkdir -p /opt/cdp","echo %s | base64 -d >/opt/cdp/rotate-logins.sh","bash /opt/cdp/rotate-logins.sh %s %s"]}' \
	"$(base64 -w0 "$HERE/rotate-logins.sh")" "$ip" "$REGION" >"$params"
cmd=$(awsr ssm send-command --instance-ids "$id" --document-name AWS-RunShellScript --timeout-seconds 600 \
	--comment "cdp rotate-logins" --parameters "file://$(winpath "$params")" --query Command.CommandId --output text)
log "sent command $cmd to $id; waiting"
while :; do
	status=$(awsr ssm get-command-invocation --command-id "$cmd" --instance-id "$id" --query Status --output text 2>/dev/null || true)
	case $status in
		Pending | InProgress | Delayed | "") sleep 5 ;;
		*) break ;;
	esac
done
awsr ssm get-command-invocation --command-id "$cmd" --instance-id "$id" \
	--query '[StandardOutputContent,StandardErrorContent]' --output text
[ "$status" = Success ] || { log "rotation ended with status $status"; exit 1; }
