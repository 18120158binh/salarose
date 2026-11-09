#!/usr/bin/env bash
# Creates the traffic simulator's studio service account, the Cognito user sim-bot@sim.invalid in group studio-admin,
# and stores its login as the sim_bot entry of the Secrets Manager secret cdp-free-plan/logins, where the simulator
# Job reads it. Run it in your own terminal with your own AWS credentials. Needs aws and python.
#
# Safe to rerun: an existing user keeps its account and gets a new password, and the secret gets the same password,
# so Cognito and the secret always agree after a run that succeeds. rotate-logins.sh rewrites the whole secret and
# drops sim_bot, so run this again after every rotation.
#
# Prints no password: it lives in mode-600 files that the EXIT trap deletes, never on a command line.
set -euo pipefail
export MSYS_NO_PATHCONV=1 AWS_PAGER=""

REGION=us-east-1
POOL_ID=us-east-1_wXHpiFUAI
SECRET_ID=cdp-free-plan/logins
GROUP=studio-admin
USERNAME=sim-bot@sim.invalid

PY=$(command -v python3 || command -v python) || { echo "python is required" >&2; exit 1; }

umask 077
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# aws.exe and python.exe on Windows cannot open an MSYS path such as /tmp/x.
native() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
awsr() { aws --region "$REGION" "$@"; }

awsr cognito-idp list-groups --user-pool-id "$POOL_ID" --query 'Groups[].GroupName' --output text | tr -d '\r' |
	tr '\t' '\n' | grep -qx "$GROUP" || { echo "group $GROUP not found in $POOL_ID" >&2; exit 1; }

# The pool requires upper and lower case, a digit, and a symbol. The trailing "-" is the symbol and keeps the
# password free of characters that JSON would escape.
"$PY" -c '
import secrets, string, sys
alphabet = string.ascii_letters + string.digits
while True:
    p = "".join(secrets.choice(alphabet) for _ in range(32))
    if any(c.islower() for c in p) and any(c.isupper() for c in p) and any(c.isdigit() for c in p):
        break
open(sys.argv[1], "w").write(p + "-")
' "$(native "$tmp/password")"

if awsr cognito-idp admin-get-user --user-pool-id "$POOL_ID" --username "$USERNAME" >/dev/null 2>"$tmp/get-user.err"; then
	echo "user $USERNAME exists, rotating its password"
elif grep -q UserNotFoundException "$tmp/get-user.err"; then
	awsr cognito-idp admin-create-user --user-pool-id "$POOL_ID" --username "$USERNAME" --message-action SUPPRESS \
		--user-attributes "Name=email,Value=$USERNAME" Name=email_verified,Value=true >/dev/null
	echo "user $USERNAME created"
else
	cat "$tmp/get-user.err" >&2
	exit 1
fi

"$PY" -c '
import json, sys
password = open(sys.argv[1]).read()
json.dump({"UserPoolId": sys.argv[2], "Username": sys.argv[3], "Password": password, "Permanent": True},
          open(sys.argv[4], "w"))
' "$(native "$tmp/password")" "$POOL_ID" "$USERNAME" "$(native "$tmp/set-password.json")"
awsr cognito-idp admin-set-user-password --cli-input-json "file://$(native "$tmp/set-password.json")"
awsr cognito-idp admin-add-user-to-group --user-pool-id "$POOL_ID" --username "$USERNAME" --group-name "$GROUP"
echo "permanent password set, user in $GROUP"

awsr secretsmanager get-secret-value --secret-id "$SECRET_ID" --query SecretString --output text |
	tr -d '\r' >"$tmp/logins.json"
"$PY" -c '
import json, sys
logins = json.load(open(sys.argv[1]))
logins["sim_bot"] = {"user": sys.argv[3], "password": open(sys.argv[2]).read()}
json.dump(logins, open(sys.argv[4], "w"))
' "$(native "$tmp/logins.json")" "$(native "$tmp/password")" "$USERNAME" "$(native "$tmp/merged.json")"
awsr secretsmanager put-secret-value --secret-id "$SECRET_ID" --secret-string "file://$(native "$tmp/merged.json")" \
	>/dev/null
echo "stored sim_bot in $SECRET_ID"
