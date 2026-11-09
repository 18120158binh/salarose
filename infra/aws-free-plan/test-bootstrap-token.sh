#!/usr/bin/env bash
# Tests ensure_argocd_token in bootstrap-cluster.sh offline, against a stub of Argo CD v3.6.1's API on 127.0.0.1 that
# answers 415 to a non-GET request without the JSON content type, as the real server does. kubectl and aws are stubs.
# curl, python3, and base64 log every argv, so the test can prove no secret reaches a command line or the output.
# Needs python and curl. Usage: test-bootstrap-token.sh
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REAL_PY=$(command -v python3 || command -v python)
REAL_CURL=$(command -v curl)
REAL_B64=$(command -v base64)
W=$(mktemp -d)
SRV=
trap 'if [ -n "$SRV" ]; then kill "$SRV" 2>/dev/null || true; fi; rm -rf "$W"' EXIT
fail() {
	echo "FAIL: $*" >&2
	exit 1
}

export ADMIN_PW="pw-$RANDOM-secretA" STALE_PW="stale-$RANDOM-secretB" JWT="jwt-$RANDOM-secretC"
export NEW_TOKEN="new-$RANDOM-secretD" OLD_TOKEN="old-$RANDOM-secretE"
export HTTP_LOG=$W/http.log ARGV_LOG=$W/argv.log STATE=$W/state PORT_FILE=$W/port
mkdir -p "$W/bin" "$STATE"

cat >"$W/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
printf '%s\0' kubectl "$@" >>"$ARGV_LOG"; printf '\n' >>"$ARGV_LOG"
case "$*" in
"-n cdp get secret studio-platform"*)
	[ -f "$STATE/existing" ] || { echo NotFound >&2; exit 1; }
	if [ -s "$STATE/existing" ]; then base64 <"$STATE/existing" | tr -d '\n'; else printf '<no value>'; fi ;;
"-n argocd rollout status"*) ;;
"-n argocd get service argocd-server"*) printf '127.0.0.1:%s' "$(cat "$PORT_FILE")" ;;
"-n argocd get secret argocd-initial-admin-secret"*)
	[ -f "$STATE/initial-pw" ] || { echo NotFound >&2; exit 1; }
	base64 <"$STATE/initial-pw" | tr -d '\n' ;;
"-n cdp create secret generic studio-platform"*)
	for a in "$@"; do
		case $a in --from-file=argocd-token=*) cp "${a#--from-file=argocd-token=}" "$STATE/created" ;; esac
	done
	echo "kind: Secret" ;;
"apply --server-side --field-manager=cdp-sso -f -") cat >"$STATE/applied" ;;
*) echo "unexpected kubectl $*" >&2; exit 9 ;;
esac
EOF

cat >"$W/bin/aws" <<'EOF'
#!/usr/bin/env bash
printf '%s\0' aws "$@" >>"$ARGV_LOG"; printf '\n' >>"$ARGV_LOG"
[ -f "$STATE/logins-pw" ] || { echo ResourceNotFoundException >&2; exit 254; }
printf '{"argocd":{"user":"admin","password":"%s"},"sim_bot":{"password":"x"}}\n' "$(cat "$STATE/logins-pw")"
EOF

for pair in "curl:$REAL_CURL" "python3:$REAL_PY" "base64:$REAL_B64"; do
	name=${pair%%:*} real=${pair#*:}
	cat >"$W/bin/$name" <<EOF
#!/usr/bin/env bash
printf '%s\0' $name "\$@" >>"\$ARGV_LOG"; printf '\n' >>"\$ARGV_LOG"
exec "$real" "\$@"
EOF
done
chmod +x "$W/bin/"*

# The token id studio-platform exists in Argo CD when $STATE/argocd-id holds the token it was issued as. The server
# accepts that token and any token it creates; it echoes request bodies in errors, so a leak of a body would show.
cat >"$W/argocd.py" <<'EOF'
import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

E, STATE = os.environ, os.environ["STATE"]
ID_FILE = os.path.join(STATE, "argocd-id")
TOKEN_PATH = "/api/v1/account/studio-health/token"


def issued():
    return open(ID_FILE).read() if os.path.exists(ID_FILE) else None


class Argo(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def handle_any(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()
        auth = self.headers.get("Authorization") or ""
        with open(E["HTTP_LOG"], "a") as f:
            f.write(json.dumps({"method": self.command, "path": self.path, "auth": auth,
                                "type": self.headers.get("Content-Type"), "body": body}) + "\n")
        if self.command != "GET" and (self.headers.get("Content-Type") or "").lower() != "application/json":
            return self.reply(415, {"error": "Invalid content type"})
        if self.command == "POST" and self.path == "/api/v1/session":
            ok = json.loads(body) == {"username": "admin", "password": E["ARGOCD_PW"]}
            return self.reply(200, {"token": E["JWT"]}) if ok else self.reply(401, {"error": "bad " + body})
        if self.command == "GET" and self.path.startswith("/api/v1/applications"):
            if "STUB_GET_CODE" in E:
                return self.reply(int(E["STUB_GET_CODE"]), {})
            ok = auth.startswith("Bearer ") and auth[7:] == issued()
            return self.reply(200, {"items": []}) if ok else self.reply(401, {"error": "invalid session"})
        if auth != "Bearer " + E["JWT"]:
            return self.reply(401, {"error": "no session"})
        if self.command == "DELETE" and self.path == TOKEN_PATH + "/studio-platform":
            if "STUB_DELETE_CODE" in E:
                return self.reply(int(E["STUB_DELETE_CODE"]), {"error": "boom " + E["JWT"]})
            if issued() is None:
                return self.reply(404, {"error": "token with id 'studio-platform' does not exist"})
            os.remove(ID_FILE)
            return self.reply(200, {})
        if self.command == "POST" and self.path == TOKEN_PATH:
            if "STUB_FAIL_CREATE" in E:
                return self.reply(500, {"error": "boom " + E["JWT"]})
            if json.loads(body) != {"id": "studio-platform"}:
                return self.reply(400, {"error": "bad body"})
            if issued() is not None:
                return self.reply(500, {"error": "account already has token with id 'studio-platform'"})
            open(ID_FILE, "w").write(E["NEW_TOKEN"])
            return self.reply(200, {"token": E["NEW_TOKEN"]})
        self.reply(404, {})

    do_GET = do_POST = do_DELETE = handle_any


srv = HTTPServer(("127.0.0.1", 0), Argo)
open(sys.argv[1], "w").write(str(srv.server_address[1]))
srv.serve_forever()
EOF

# start_argocd [VAR=value...]: restarts the stub with ARGOCD_PW=$ADMIN_PW and the given environment.
start_argocd() {
	if [ -n "$SRV" ]; then
		kill "$SRV" 2>/dev/null || true
		wait "$SRV" 2>/dev/null || true
	fi
	: >"$PORT_FILE"
	env ARGOCD_PW="$ADMIN_PW" "$@" "$REAL_PY" "$W/argocd.py" "$PORT_FILE" &
	SRV=$!
	for _ in $(seq 50); do
		[ -s "$PORT_FILE" ] && return 0
		sleep 0.1
	done
	fail "the Argo CD stub did not start"
}

# given <files...>: resets the cluster to hold only the named state files, each with its value, as name=value.
given() {
	rm -rf "$STATE" && mkdir -p "$STATE"
	: >"$HTTP_LOG"
	: >"$ARGV_LOG"
	local pair
	for pair in "$@"; do printf '%s' "${pair#*=}" >"$STATE/${pair%%=*}"; done
}

export PATH="$W/bin:$PATH" PYTHON=python3
# shellcheck source=SCRIPTDIR/bootstrap-cluster.sh
. "$HERE/bootstrap-cluster.sh"

run() {
	local d
	d=$(mktemp -d "$W/run.XXXX")
	(
		umask 077
		ensure_argocd_token us-east-1 "$d"
	) >"$W/out" 2>"$W/err"
}
no_secret() {
	local f s
	for f in "$ARGV_LOG" "$W/out" "$W/err"; do
		for s in "$ADMIN_PW" "$STALE_PW" "$JWT" "$NEW_TOKEN" "$OLD_TOKEN"; do
			if grep -qaF "$s" "$f"; then fail "$(basename "$f") holds a secret"; fi
		done
	done
}
requests() { sed -E 's/^\{"method": "([A-Z]+)", "path": "([^"?]*).*/\1 \2/' "$HTTP_LOG" | paste -sd, -; }
created() { [ "$(cat "$STATE/created" 2>/dev/null)" = "$NEW_TOKEN" ] && [ -s "$STATE/applied" ]; }
show() { sed 's/^/    | /' "$W/out" "$W/err"; }

start_argocd

given initial-pw="$ADMIN_PW"
run || { show; fail "the first run failed"; }
created || fail "the first run did not store the new token"
[ "$(requests)" = "POST /api/v1/session,DELETE /api/v1/account/studio-health/token/studio-platform,POST /api/v1/account/studio-health/token" ] ||
	fail "unexpected requests: $(requests)"
grep -q '"method": "DELETE".*"type": "application/json"' "$HTTP_LOG" || fail "DELETE lacked the JSON content type"
grep -qx 'argocd DELETE token studio-platform: 404' "$W/out" || fail "a missing token id did not count as deleted"
no_secret
echo "ok: fresh cluster -> DELETE passes the content-type check, 404 counts as no old token, token created; no secret in $(wc -l <"$ARGV_LOG") argvs or the output"
show

given existing="$OLD_TOKEN" argocd-id="$OLD_TOKEN" logins-pw="$ADMIN_PW"
run || { show; fail "the rerun failed"; }
grep -qx 'argocd token: kept' "$W/out" || fail "a valid token was not kept"
[ "$(requests)" = "GET /api/v1/applications" ] || fail "a rerun with a valid token made requests: $(requests)"
grep -qF '"auth": "Bearer '"$OLD_TOKEN"'"' "$HTTP_LOG" || fail "the check did not send studio's token"
[ ! -e "$STATE/created" ] || fail "a rerun with a valid token rewrote the secret"
[ "$(cat "$STATE/argocd-id")" = "$OLD_TOKEN" ] || fail "a rerun with a valid token revoked it"
no_secret
echo "ok: rerun with a token Argo CD accepts -> one read-only GET, kept, no login, no secret write"
show

given existing="$OLD_TOKEN" argocd-id="revoked-and-reissued" logins-pw="$ADMIN_PW"
run || { show; fail "the revoked-token run failed"; }
grep -qx 'argocd token: rejected (401), replacing it' "$W/out" || fail "a revoked token was not reported"
grep -qx 'argocd DELETE token studio-platform: 200' "$W/out" || fail "the old token id was not deleted"
created || fail "a revoked token was not replaced"
no_secret
echo "ok: revoked token whose id remains -> rejected by the GET, id deleted, new token stored"
show

given existing= initial-pw="$ADMIN_PW"
run || { show; fail "the empty-key run failed"; }
created || fail "an empty argocd-token was not replaced"
echo "ok: an empty argocd-token counts as missing and is replaced"

given initial-pw="$ADMIN_PW" logins-pw="$STALE_PW"
run || { show; fail "the rebuilt-server run failed"; }
grep -qx 'argocd admin password: from argocd-initial-admin-secret' "$W/out" || fail "the stale logins secret was read first"
created || fail "the rebuilt server got no token"
no_secret
echo "ok: rebuilt server, logins secret holds the old cluster's password -> argocd-initial-admin-secret wins"
show

given logins-pw="$ADMIN_PW"
run || { show; fail "the post-rotation run failed"; }
grep -qx 'argocd admin password: from cdp-free-plan/logins' "$W/out" || fail "the logins secret was not used"
created || fail "the post-rotation run got no token"
no_secret
echo "ok: after rotate-logins deleted argocd-initial-admin-secret -> password from cdp-free-plan/logins"

given
if run; then fail "a run without any password succeeded"; fi
[ ! -s "$HTTP_LOG" ] || fail "a run without any password made requests"
echo "ok: no password anywhere -> stderr '$(cat "$W/err")'"

start_argocd STUB_DELETE_CODE=415
given initial-pw="$ADMIN_PW"
if run; then fail "a DELETE answered 415 passed"; fi
grep -qx 'argocd DELETE /api/v1/account/studio-health/token/studio-platform: 415' "$W/err" || fail "unexpected error: $(cat "$W/err")"
[ ! -e "$STATE/created" ] || fail "a failed DELETE went on to write the secret"
no_secret
echo "ok: DELETE answered 415 -> stops with stderr '$(cat "$W/err")', no token written"

start_argocd STUB_GET_CODE=503
given existing="$OLD_TOKEN" argocd-id="$OLD_TOKEN" initial-pw="$ADMIN_PW"
if run; then fail "a failed token check passed"; fi
grep -qx 'argocd GET /api/v1/applications: 503' "$W/err" || fail "unexpected error: $(cat "$W/err")"
[ "$(requests)" = "GET /api/v1/applications" ] || fail "a failed check went on to replace the token: $(requests)"
no_secret
echo "ok: token check answered 503 -> stops without replacing a token that may still work"

start_argocd ARGOCD_PW="server-$RANDOM-secretF"
given initial-pw="$ADMIN_PW"
if run; then fail "a wrong password succeeded"; fi
grep -qx 'argocd POST /api/v1/session: 401' "$W/err" || fail "unexpected error: $(cat "$W/err")"
[ ! -e "$STATE/created" ] || fail "a failed login wrote the secret"
no_secret
echo "ok: wrong password -> stderr '$(cat "$W/err")' only, though the server echoed the attempt"

start_argocd STUB_FAIL_CREATE=1
given initial-pw="$ADMIN_PW"
if run; then fail "a failed creation succeeded"; fi
grep -qx 'argocd POST /api/v1/account/studio-health/token: 500' "$W/err" || fail "unexpected error: $(cat "$W/err")"
[ ! -e "$STATE/created" ] || fail "a failed creation wrote the secret"
no_secret
echo "ok: failed creation -> stderr '$(cat "$W/err")' only, though the server body held the session"
echo "all passed"
