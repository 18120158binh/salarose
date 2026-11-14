#!/usr/bin/env bash
# Checks infra/db/migrations against an empty Postgres the caller provides, with Flyway run from the image and with
# the command of the migration Job (infra/k8s/data/db-migrate.yaml). Needs docker, and a Postgres on localhost:5432
# whose superuser postgres signs in without a password. It creates and drops its own databases and the role cdp.
#
#   docker run -d --name mig-pg -p 5432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16
#   BASE_REF=origin/deploy/aws-free-plan bash infra/db/test-migrations.sh
#
# BASE_REF, when set, also fails on a migration edited, renamed, or deleted since that ref. MIGRATION_FIX=true allows an
# edit, for the reviewed fix of a migration that failed and so was never recorded as applied (the PR label migration-fix).
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DB_DIR="$ROOT/infra/db"
JOB="$ROOT/infra/k8s/data/db-migrate.yaml"
PG_IMAGE=${PG_IMAGE:-postgres:16}
FLYWAY_IMAGE=$(sed -n 's/^ *image: *\(flyway\/flyway:.*\)$/\1/p' "$JOB")
JOB_COMMAND=$(sed -n 's/^ *command: \["sh", "-c", "\(.*\)"\]$/\1/p' "$JOB")
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

[[ $FLYWAY_IMAGE == *@sha256:* ]] || fail "the Job's Flyway image is not pinned by digest: '$FLYWAY_IMAGE'"
[[ -n $JOB_COMMAND ]] || fail "could not read the Job's command from $JOB"

# Lint.
listed=$(sed -n 's/^ *- \(.*\)$/\1/p' "$DB_DIR/kustomization.yaml" | grep -v '^name:' | sort)
present=$( (cd "$DB_DIR" && echo flyway.toml && ls migrations/*) | sort)
[[ $listed == "$present" ]] || fail "infra/db/kustomization.yaml must list exactly flyway.toml and every file in migrations/:
$(diff <(echo "$listed") <(echo "$present") || true)"
for f in "$DB_DIR"/migrations/*; do
  name=$(basename "$f")
  [[ $name =~ ^V[0-9]{4}__[a-z0-9_]+\.sql(\.conf)?$ || $name == beforeMigrate.sql ]] ||
    fail "$name: name a migration V<NNNN>__<snake_case>.sql, and its script config V<NNNN>__<snake_case>.sql.conf"
  if [[ $name == *.conf && ! -f ${f%.conf} ]]; then fail "$name configures no migration"; fi
  if grep -q $'\r' "$f"; then fail "$name has CR bytes"; fi
done
dupes=$(ls "$DB_DIR"/migrations | sed -n 's/^V\([0-9]*\)__.*\.sql$/\1/p' | sort | uniq -d)
[[ -z $dupes ]] || fail "two migrations share version $dupes"
if [[ -n ${BASE_REF:-} ]]; then
  git -C "$ROOT" rev-parse --verify --quiet "$BASE_REF^{commit}" >/dev/null || fail "BASE_REF $BASE_REF is not a commit here"
  allowed='^A'
  [[ ${MIGRATION_FIX:-} == true ]] && allowed='^[AM]\s'
  changed=$(git -C "$ROOT" diff --name-status "$BASE_REF"...HEAD -- 'infra/db/migrations/V*' | grep -Ev "$allowed" || true)
  [[ -z $changed ]] || fail "a migration on $BASE_REF was edited, renamed, or deleted. Add a new one instead:
$changed"
fi
pass "lint"

# The layout of a ConfigMap volume: each key a symlink through ..data into a timestamped directory.
stage() {
  local dir=$1 ts=..2026_01_01_00_00_00.000000000
  mkdir -p "$dir/$ts"
  cp "$DB_DIR/flyway.toml" "$DB_DIR"/migrations/* "$dir/$ts/"
  ln -s "$ts" "$dir/..data"
  for f in "$dir/$ts"/*; do ln -s "..data/$(basename "$f")" "$dir/$(basename "$f")"; done
}
stage "$WORK/config"

sql() { # role database, SQL on stdin
  docker run --rm -i --network host "$PG_IMAGE" psql -X -q -v ON_ERROR_STOP=1 -h localhost -U "$1" -d "$2" -At
}
flyway() { # config-dir database flyway-command, as the Job runs it but with the given command
  timeout 300 docker run --rm --network host --user 65534:65534 --read-only --tmpfs /tmp:mode=1777 --tmpfs /work:mode=1777 \
    -v "$1:/config:ro" \
    -e FLYWAY_URL="jdbc:postgresql://localhost:5432/$2" -e FLYWAY_USER=cdp \
    -e FLYWAY_CONFIG_FILES=/work/flyway.toml -e FLYWAY_LOCATIONS=filesystem:/work -e REDGATE_DISABLE_TELEMETRY=true \
    --entrypoint sh "$FLYWAY_IMAGE" -c "${JOB_COMMAND/flyway migrate/flyway $3}"
}
dump() {
  docker run --rm --network host "$PG_IMAGE" pg_dump -h localhost -U postgres --schema-only --no-owner \
    --no-privileges --exclude-table=flyway_schema_history "$1" | grep -v '^\\\(un\)\?restrict '
}
history() {
  echo "SELECT ltrim(version, '0'), type, success FROM flyway_schema_history WHERE version IS NOT NULL ORDER BY installed_rank" | sql postgres "$1" | tr '\n' ' '
}
not_owned_by_cdp() {
  sql postgres "$1" <<'SQL'
SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S') AND pg_get_userbyid(c.relowner) <> 'cdp'
UNION ALL SELECT pubname FROM pg_publication WHERE pg_get_userbyid(pubowner) <> 'cdp'
SQL
}

DBS="mig_fresh mig_reference mig_live mig_stray mig_tampered mig_session mig_concurrent"
IMPORT_DB=mig_import_store
sql postgres postgres <<SQL
$(for db in $DBS; do echo "DROP DATABASE IF EXISTS $db;"; done)
DROP DATABASE IF EXISTS $IMPORT_DB;
DROP ROLE IF EXISTS cdp;
DROP ROLE IF EXISTS import_reader;
DROP ROLE IF EXISTS cdp_import;
CREATE ROLE cdp LOGIN REPLICATION;
$(for db in $DBS; do echo "CREATE DATABASE $db OWNER cdp;"; done)
-- The import store's roles, as the cluster cdp-import-pg creates them (infra/k8s/data/import-store.yaml).
CREATE ROLE cdp_import LOGIN;
CREATE ROLE import_reader LOGIN IN ROLE pg_read_all_data;
CREATE DATABASE $IMPORT_DB OWNER cdp_import;
SQL

V0001="$DB_DIR/migrations/V0001__baseline.sql"
latest=$(ls "$DB_DIR"/migrations | sed -n 's/^V0*\([0-9]*\)__.*/\1/p' | sort -n | tail -1)

# MIG-AC: an empty database runs every file, in order, and owns every object as cdp.
flyway "$WORK/config" mig_fresh migrate >"$WORK/fresh.log" || { cat "$WORK/fresh.log"; fail "migrate on an empty database"; }
h=$(history mig_fresh)
[[ $h == "1|SQL|t "* && $h == *"$latest|SQL|t " && $h != *BASELINE* ]] || fail "empty database history: $h"
[[ -z $(not_owned_by_cdp mig_fresh) ]] || fail "objects not owned by cdp: $(not_owned_by_cdp mig_fresh)"
flyway "$WORK/config" mig_fresh validate >/dev/null || fail "validate after migrate"
flyway "$WORK/config" mig_fresh migrate >"$WORK/again.log" || { cat "$WORK/again.log"; fail "a second migrate"; }
[[ $(history mig_fresh) == "$h" ]] || fail "a second migrate changed the history"
pass "an empty database runs V0001 to V$latest, owned by cdp, and a second run changes nothing"

# MIG-AC: the migrations build the schema that schema.sql describes.
sql cdp mig_reference <"$DB_DIR/schema.sql" >/dev/null
diff -u <(dump mig_reference) <(dump mig_fresh) >"$WORK/drift.diff" || {
  cat "$WORK/drift.diff"; fail "the migrations and infra/db/schema.sql build different schemas (- schema.sql, + migrations)"; }
pass "migrations match schema.sql"

# IMP-NFR-04: customer_attributes keeps the default replica identity and joins no publication.
ident=$(echo "SELECT c.relreplident::text || '|' || count(p.pubname) FROM pg_class c LEFT JOIN pg_publication_tables p
  ON p.schemaname = 'public' AND p.tablename = c.relname WHERE c.oid = 'public.customer_attributes'::regclass
  GROUP BY c.relreplident" | sql postgres mig_fresh)
[[ $ident == "d|0" ]] || fail "customer_attributes must have replica identity default and no publication, got $ident"
pass "customer_attributes has replica identity default and is in no publication"

# The import store's DDL applies as its owner, the way the Job import-store-ddl runs it, and again with no change.
# The reader role reads every table and writes none.
import_ddl() {
  docker run --rm -i --network host "$PG_IMAGE" psql -X -q --single-transaction -v ON_ERROR_STOP=1 -h localhost     -U cdp_import -d "$IMPORT_DB" <"$DB_DIR/import-store/schema.sql"
}
import_ddl >/dev/null || fail "the import store DDL on an empty database"
first=$(dump "$IMPORT_DB")
import_ddl >/dev/null || fail "a second run of the import store DDL"
[[ $(dump "$IMPORT_DB") == "$first" ]] || fail "a second run of the import store DDL changed the schema"
tables=$(echo "SELECT string_agg(tablename, ' ' ORDER BY tablename) FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'cdp_import'" |
  sql postgres "$IMPORT_DB")
[[ $tables == "import_identifiers import_profiles import_records import_run_commits" ]] ||
  fail "the import store tables owned by cdp_import are '$tables'"
echo "SELECT count(*) FROM import_records" | sql import_reader "$IMPORT_DB" >/dev/null || fail "import_reader cannot read the store"
if echo "INSERT INTO import_run_commits (run_id, record_type_id, counts) VALUES (gen_random_uuid(), gen_random_uuid(), '{}')" |
  sql import_reader "$IMPORT_DB" >/dev/null 2>&1; then fail "import_reader wrote to the store"; fi
pass "the import store DDL applies twice as cdp_import, and import_reader only reads"

# MIG-AC: a database deployed before Flyway is baselined at 1 and runs only the later files.
sql cdp mig_live <"$V0001" >/dev/null
flyway "$WORK/config" mig_live migrate >"$WORK/live.log" || { cat "$WORK/live.log"; fail "migrate on the pre-Flyway database"; }
h=$(history mig_live)
[[ $h == "1|BASELINE|t "* && $h == *"$latest|SQL|t " ]] || fail "pre-Flyway database history: $h"
diff -u <(dump mig_reference) <(dump mig_live) >/dev/null || fail "the baselined database differs from schema.sql"
pass "a pre-Flyway database is baselined at 1 and reaches the same schema"

# MIG-AC: an object another role owns, such as DDL applied by hand as postgres, fails the run and names it.
sql cdp mig_stray <"$V0001" >/dev/null
sql postgres mig_stray <"$DB_DIR/migrations/V0002__journey_drafts_and_preview.sql" >/dev/null
if flyway "$WORK/config" mig_stray migrate >"$WORK/stray.log" 2>&1; then fail "migrate passed with tables owned by postgres"; fi
grep -q "objects not owned by cdp: table journey_drafts (owner postgres), table journey_publishes (owner postgres)" "$WORK/stray.log" ||
  { cat "$WORK/stray.log"; fail "the ownership error does not name the tables"; }
echo "ALTER TABLE journey_drafts OWNER TO cdp; ALTER TABLE journey_publishes OWNER TO cdp;" | sql postgres mig_stray
flyway "$WORK/config" mig_stray migrate >/dev/null || fail "migrate after the owner fix"
pass "objects owned by another role fail the run until a superuser hands them to cdp"

# MIG-AC: an applied migration whose file changed fails validate and migrate.
cp -rP "$WORK/config" "$WORK/tampered"
echo "-- edited" >>"$WORK/tampered/..2026_01_01_00_00_00.000000000/V0001__baseline.sql"
flyway "$WORK/config" mig_tampered migrate >/dev/null || fail "migrate before the edit"
if flyway "$WORK/tampered" mig_tampered validate >/dev/null 2>&1; then fail "validate passed with an edited V0001"; fi
if flyway "$WORK/tampered" mig_tampered migrate >/dev/null 2>&1; then fail "migrate passed with an edited V0001"; fi
pass "a checksum mismatch fails validate and migrate"

# MIG-AC: every migration session has the lock and statement timeouts, and a raise with SET LOCAL ends with its file.
cp -rP "$WORK/config" "$WORK/session"
cat >"$WORK/session/..2026_01_01_00_00_00.000000000/V9998__long_backfill.sql" <<'SQL'
SET LOCAL statement_timeout = '1h';
DO $$
BEGIN
    IF current_setting('statement_timeout') <> '1h' THEN
        RAISE EXCEPTION 'SET LOCAL did not apply: %', current_setting('statement_timeout');
    END IF;
END $$;
SQL
ln -s ..data/V9998__long_backfill.sql "$WORK/session/V9998__long_backfill.sql"
cat >"$WORK/session/..2026_01_01_00_00_00.000000000/V9999__session_settings.sql" <<'SQL'
DO $$
BEGIN
    IF current_setting('lock_timeout') <> '5s' OR current_setting('statement_timeout') <> '15min' THEN
        RAISE EXCEPTION 'lock_timeout %, statement_timeout %', current_setting('lock_timeout'), current_setting('statement_timeout');
    END IF;
END $$;
SQL
ln -s ..data/V9999__session_settings.sql "$WORK/session/V9999__session_settings.sql"
flyway "$WORK/session" mig_session migrate >"$WORK/session.log" 2>&1 || { cat "$WORK/session.log"; fail "session settings"; }
pass "lock_timeout 5s and statement_timeout 15min in each migration session, and SET LOCAL does not leak"

# MIG-AC: a concurrent index builds outside a transaction without waiting on Flyway's own lock, and waits past 5 s for
# an older transaction when its file raises lock_timeout, then sets it back. A failed build leaves an INVALID index and
# a failed history row. The recovery in the db-migration skill clears both.
TS=..2026_01_01_00_00_00.000000000
cp -rP "$WORK/config" "$WORK/concurrent"
add() { echo "$2" >"$WORK/concurrent/$TS/$1"; ln -sf "..data/$1" "$WORK/concurrent/$1"; }
add V9001__idx_system_users_email.sql "SET lock_timeout = '10min';
CREATE INDEX CONCURRENTLY idx_system_users_email ON system_users (email);
SET lock_timeout = '5s';"
add V9001__idx_system_users_email.sql.conf "executeInTransaction=false"
add V9001.1__lock_timeout_restored.sql "DO \$\$ BEGIN IF current_setting('lock_timeout') <> '5s' THEN RAISE EXCEPTION 'lock_timeout leaked: %', current_setting('lock_timeout'); END IF; END \$\$;"
docker run --rm --network host "$PG_IMAGE" psql -X -q -h localhost -U postgres -d mig_concurrent \
  -c "BEGIN; SELECT txid_current(); SELECT pg_sleep(12); COMMIT;" >/dev/null &
holder=$!
sleep 2
start=$SECONDS
flyway "$WORK/concurrent" mig_concurrent migrate >"$WORK/wait.log" 2>&1 || { cat "$WORK/wait.log"; fail "a concurrent index behind a 12 s transaction"; }
waited=$((SECONDS - start))
wait "$holder"
((waited >= 6)) || fail "the concurrent index did not wait for the older transaction (${waited}s)"
pass "a concurrent index with its own lock_timeout waits ${waited}s for an older transaction"
add V9002__seed.sql "INSERT INTO system_users (id, email, role, oidc_issuer, oidc_subject) VALUES ('a', 'x@example.com', 'admin', 'i', 'a'), ('b', 'x@example.com', 'admin', 'i', 'b');"
add V9003__idx_system_users_email_unique.sql "CREATE UNIQUE INDEX CONCURRENTLY idx_system_users_email_unique ON system_users (email);"
if flyway "$WORK/concurrent" mig_concurrent migrate >"$WORK/concurrent.log" 2>&1; then fail "a unique index over duplicates built"; fi
grep -q "idx_system_users_email_unique" "$WORK/concurrent.log" || { cat "$WORK/concurrent.log"; fail "the failed build is not named"; }
h=$(history mig_concurrent)
[[ $h == *"9001|SQL|t 9001.1|SQL|t 9002|SQL|t "* ]] || fail "the first concurrent index did not apply: $h"
echo "info: history after the failed concurrent build: $h"
[[ $(echo "SELECT indisvalid FROM pg_index WHERE indexrelid = 'idx_system_users_email_unique'::regclass" | sql postgres mig_concurrent) == f ]] ||
  fail "the failed build left no INVALID index"
sql cdp mig_concurrent <<'SQL'
DROP INDEX CONCURRENTLY IF EXISTS idx_system_users_email_unique;
DELETE FROM flyway_schema_history WHERE NOT success;
SQL
add V9003__idx_system_users_email_unique.sql "CREATE INDEX CONCURRENTLY idx_system_users_email_unique ON system_users (email);"
flyway "$WORK/concurrent" mig_concurrent migrate >"$WORK/recovered.log" 2>&1 || { cat "$WORK/recovered.log"; fail "migrate after the recovery"; }
[[ $(history mig_concurrent) == *"9003|SQL|t " ]] || fail "the fixed concurrent index did not apply: $(history mig_concurrent)"
pass "a concurrent index builds, and a failed one recovers with the skill's steps and a fixed file"

{ for db in $DBS $IMPORT_DB; do echo "DROP DATABASE $db;"; done; echo "DROP ROLE import_reader; DROP ROLE cdp_import;"; } | sql postgres postgres
echo "all migration checks passed"
