#!/usr/bin/env bash
# Tests rotate-logins.sh's merge offline: a rotation replaces the argocd, grafana, and studio entries and keeps every
# other entry, such as sim_bot. Calls no AWS API. Needs python. Usage: test-rotate-logins.sh
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
PYTHON=${PYTHON:-$(command -v python3 || command -v python)}
export PYTHON
# shellcheck source=SCRIPTDIR/rotate-logins.sh
. "$HERE/rotate-logins.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

printf '{"argocd":{"user":"admin","password":"old"},"sim_bot":{"user":"sim-bot","password":"kept"},"other":1}' >"$tmp/current.json"
printf '{"argocd":{"user":"admin","password":"new"},"grafana":{"user":"admin","password":"g"},"studio":{"note":"n"}}' >"$tmp/rotated.json"
merge_logins "$tmp/current.json" "$tmp/rotated.json" "$tmp/merged.json"
"$PYTHON" -c '
import json, sys
merged = json.load(open(sys.argv[1]))
assert merged["sim_bot"] == {"user": "sim-bot", "password": "kept"}, merged
assert merged["other"] == 1, merged
assert merged["argocd"]["password"] == "new", merged
assert set(merged) == {"argocd", "grafana", "studio", "sim_bot", "other"}, merged
' "$tmp/merged.json" || fail "a rotation lost or kept the wrong entries"
echo "ok: a rotation keeps sim_bot and every other entry"

: >"$tmp/empty.json"
merge_logins "$tmp/empty.json" "$tmp/rotated.json" "$tmp/first.json"
"$PYTHON" -c 'import json, sys; assert set(json.load(open(sys.argv[1]))) == {"argocd", "grafana", "studio"}' "$tmp/first.json" ||
	fail "the first rotation did not store the rotated entries"
echo "ok: the first rotation stores the rotated entries"

printf '["not", "an", "object"]' >"$tmp/list.json"
if merge_logins "$tmp/list.json" "$tmp/rotated.json" "$tmp/bad.json" 2>/dev/null; then
	fail "a stored value that is not an object was overwritten"
fi
echo "ok: a stored value that is not an object stops the rotation"
