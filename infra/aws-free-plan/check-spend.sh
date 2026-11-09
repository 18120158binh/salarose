#!/usr/bin/env bash
# Prints the projected spend of three nodes until the Free Plan expires and exits 1 when it is over 85% of the
# remaining credit (AFP-FR-01, AFP-NFR-01). Run it before every terraform apply. Changes nothing.
set -euo pipefail
export MSYS_NO_PATHCONV=1 AWS_PAGER=""

REGION=us-east-1
INSTANCE_TYPE=m7i-flex.large
NODE_COUNT=6
VOLUME_GB=30
SPEND_LIMIT=0.85

log() { printf '%s\n' "$*" >&2; }

# aws.exe on Windows ends text output with CRLF.
awsr() { aws --region "$REGION" "$@" | tr -d '\r'; }

on_demand_usd() {
	awsr pricing get-products --service-code "$1" --filters "${@:2}" --query 'PriceList[0]' --output text |
		grep -o '"OnDemand":{"[^"]*":{"priceDimensions".*' | grep -o '"USD":"[0-9.]*"' | head -1 | grep -o '[0-9.]*'
}

plan=$(awsr freetier get-account-plan-state --query '[accountPlanType,accountPlanStatus]' --output text)
credit=$(awsr freetier get-account-plan-state --query accountPlanRemainingCredits.amount --output text)
expiry=$(awsr freetier get-account-plan-state --query accountPlanExpirationDate --output text)
hours=$(awk -v e="$(date -d "$expiry" +%s)" -v n="$(date +%s)" 'BEGIN { printf "%.1f", (e - n) / 3600 }')
instance_hr=$(on_demand_usd AmazonEC2 \
	"Type=TERM_MATCH,Field=instanceType,Value=$INSTANCE_TYPE" "Type=TERM_MATCH,Field=regionCode,Value=$REGION" \
	Type=TERM_MATCH,Field=operatingSystem,Value=Linux Type=TERM_MATCH,Field=tenancy,Value=Shared \
	Type=TERM_MATCH,Field=preInstalledSw,Value=NA Type=TERM_MATCH,Field=capacitystatus,Value=Used)
gp3_gb_month=$(on_demand_usd AmazonEC2 Type=TERM_MATCH,Field=volumeApiName,Value=gp3 \
	"Type=TERM_MATCH,Field=regionCode,Value=$REGION" Type=TERM_MATCH,Field=productFamily,Value=Storage)
ipv4_hr=$(on_demand_usd AmazonVPC "Type=TERM_MATCH,Field=regionCode,Value=$REGION" \
	Type=TERM_MATCH,Field=usagetype,Value=USE1-PublicIPv4:InUseAddress)
for price in "$instance_hr" "$gp3_gb_month" "$ipv4_hr"; do
	[ -n "$price" ] || { log "could not read a price from the Pricing API"; exit 1; }
done
spend=$(awk -v h="$hours" -v n="$NODE_COUNT" -v i="$instance_hr" -v v="$gp3_gb_month" -v g="$VOLUME_GB" -v p="$ipv4_hr" \
	'BEGIN { printf "%.2f", h * n * (i + p + g * v / 730) }')
limit=$(awk -v c="$credit" -v l="$SPEND_LIMIT" 'BEGIN { printf "%.2f", c * l }')
log "plan $plan, credit \$$credit, expiry $expiry, $hours hours left"
log "prices: $INSTANCE_TYPE \$$instance_hr/h, gp3 \$$gp3_gb_month/GB-month, public IPv4 \$$ipv4_hr/h"
log "projected spend until expiry: \$$spend, limit \$$limit (${SPEND_LIMIT} of credit)"
if awk -v s="$spend" -v l="$limit" 'BEGIN { exit !(s > l) }'; then
	log "STOP: projected spend exceeds the limit (AFP-FR-01)"
	exit 1
fi
