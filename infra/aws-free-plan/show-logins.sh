#!/usr/bin/env bash
# Prints the environment's URLs and logins from the Secrets Manager secret cdp-free-plan/logins, with your own AWS
# credentials. Run it in your own terminal, not through an agent, so the passwords stay out of chat logs. The AWS
# console shows the same value from any browser: Secrets Manager, us-east-1, cdp-free-plan/logins, Retrieve secret
# value. rotate-logins-remote.sh writes the secret.
set -euo pipefail
export MSYS_NO_PATHCONV=1 AWS_PAGER=""

aws --region us-east-1 secretsmanager get-secret-value --secret-id cdp-free-plan/logins \
	--query SecretString --output text | tr -d '\r' |
	if command -v jq >/dev/null; then jq .; else cat; fi
