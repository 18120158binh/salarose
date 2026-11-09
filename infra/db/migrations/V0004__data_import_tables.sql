-- Data import's tables on the main Postgres (docs/internal/features/data-import.md). Studio
-- defines datasets, their versions, dataset metrics, and source key scopes. The import applier
-- and the import metric pass record runs and passes. pii_access_log and person_tombstones hold
-- the privacy trail. None is in a publication. A system name is lowercase letters, digits, and
-- underscores, and starts with a letter.
CREATE TABLE IF NOT EXISTS import_record_types (
    id uuid primary key DEFAULT gen_random_uuid(),
    name text NOT NULL CONSTRAINT import_record_types_name_key UNIQUE CHECK (name ~ '^[a-z][a-z0-9_]*$'),
    display_name text NOT NULL CHECK (btrim(display_name) <> ''),
    kind text NOT NULL CHECK (kind IN ('profile', 'event')),
    current_version integer NOT NULL CHECK (current_version >= 1),
    created_by text REFERENCES system_users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Immutable versions of a dataset. columns is an array of { name, displayName, type, pii,
-- aliases }. roles maps each role to a column name, or to a list for email and phone.
CREATE TABLE IF NOT EXISTS import_record_type_versions (
    record_type_id uuid NOT NULL REFERENCES import_record_types(id),
    version integer NOT NULL CHECK (version >= 1),
    columns jsonb NOT NULL CHECK (jsonb_typeof(columns) = 'array'),
    roles jsonb NOT NULL CHECK (jsonb_typeof(roles) = 'object'),
    delivery_mode text NOT NULL CHECK (delivery_mode IN ('incremental', 'snapshot')),
    time_zone text NOT NULL CHECK (time_zone <> ''),
    delimiter text NOT NULL CHECK (delimiter IN (',', ';')),
    created_by text REFERENCES system_users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    primary key (record_type_id, version)
);
-- Dataset metrics, apart from user_metric_definitions. Never deleted: archived_at freezes one.
CREATE TABLE IF NOT EXISTS import_metric_definitions (
    id uuid primary key DEFAULT gen_random_uuid(),
    record_type_id uuid NOT NULL REFERENCES import_record_types(id),
    name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]*$'),
    display_name text NOT NULL CHECK (btrim(display_name) <> ''),
    function text NOT NULL CHECK (function IN ('COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'MEDIAN', 'DISTINCT_COUNT', 'LATEST', 'FIRST_TIME', 'LAST_TIME')),
    "column" text,
    filters jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(filters) = 'array'),
    window_days integer CHECK (window_days >= 1),
    archived_at TIMESTAMP WITH TIME ZONE,
    created_by text REFERENCES system_users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT import_metric_definitions_name_key UNIQUE (record_type_id, name),
    CONSTRAINT import_metric_definitions_column_check CHECK (("column" IS NULL) = (function IN ('COUNT', 'FIRST_TIME', 'LAST_TIME')))
);
-- The datasets each source key may import.
CREATE TABLE IF NOT EXISTS import_source_scopes (
    source_key_id text NOT NULL REFERENCES ingestion_source_keys(id),
    record_type_id uuid NOT NULL REFERENCES import_record_types(id),
    primary key (source_key_id, record_type_id)
);
-- One row per nightly import metric pass. Studio stamps retry_requested_at only.
CREATE TABLE IF NOT EXISTS import_metric_passes (
    id uuid primary key DEFAULT gen_random_uuid(),
    as_of TIMESTAMP WITH TIME ZONE NOT NULL CONSTRAINT import_metric_passes_as_of_key UNIQUE,
    state text NOT NULL CHECK (state IN ('running', 'done', 'failed')),
    reason text,
    retry_requested_at TIMESTAMP WITH TIME ZONE,
    last_run_finished_at TIMESTAMP WITH TIME ZONE,
    counts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counts) = 'object'),
    changed_rows bigint CHECK (changed_rows >= 0),
    wal_bytes bigint CHECK (wal_bytes >= 0),
    pauses jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(pauses) = 'array'),
    started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMP WITH TIME ZONE
);
-- One row per delivered file, or per re-derive, in the import applier's run states. A rederive
-- run has no file.
CREATE TABLE IF NOT EXISTS import_runs (
    id uuid primary key DEFAULT gen_random_uuid(),
    record_type_id uuid NOT NULL,
    version integer NOT NULL,
    source text NOT NULL CHECK (source IN ('api', 'drop', 'studio', 'rederive')),
    writer text NOT NULL CHECK (writer <> ''),
    format text CHECK (format IN ('csv', 'ndjson', 'csv.gz', 'ndjson.gz', 'xlsx')),
    byte_size bigint CHECK (byte_size >= 0),
    file_key text,
    sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    stored_sha256 text CHECK (stored_sha256 ~ '^[0-9a-f]{64}$'),
    state text NOT NULL CHECK (state IN ('uploading', 'queued', 'validating', 'quarantined', 'approved', 'discarded', 'applying', 'applied', 'failed', 'expired')),
    reason text,
    counts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counts) = 'object'),
    first_pass_id uuid REFERENCES import_metric_passes(id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    confirmed_at TIMESTAMP WITH TIME ZONE,
    approved_by text REFERENCES system_users(id) ON DELETE SET NULL,
    approved_at TIMESTAMP WITH TIME ZONE,
    started_at TIMESTAMP WITH TIME ZONE,
    finished_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT import_runs_version_fkey FOREIGN KEY (record_type_id, version) REFERENCES import_record_type_versions(record_type_id, version),
    CONSTRAINT import_runs_file_check CHECK (
        (source = 'rederive') = (format IS NULL AND byte_size IS NULL AND file_key IS NULL AND sha256 IS NULL)
    )
);
CREATE INDEX IF NOT EXISTS idx_import_runs_type_created ON import_runs (record_type_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_runs_created ON import_runs (created_at DESC);
-- One row per read of clear imported PII, or per deletion request. Only a reveal row may hold a
-- clear customer key. The import applier replaces a deleted person's key with the tombstone, and
-- deletes rows older than 365 days.
CREATE TABLE IF NOT EXISTS pii_access_log (
    id uuid primary key DEFAULT gen_random_uuid(),
    staff_id text NOT NULL,
    at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    action text NOT NULL CHECK (action IN ('reveal', 'rejects_download', 'deletion_request')),
    route text NOT NULL CHECK (route <> ''),
    customer_key text,
    customer_key_hash text CHECK (customer_key_hash ~ '^[0-9a-f]{64}$'),
    run_id uuid REFERENCES import_runs(id),
    fields jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(fields) = 'array'),
    CONSTRAINT pii_access_log_shape_check CHECK (
        (action = 'reveal' AND run_id IS NULL AND (customer_key IS NULL) <> (customer_key_hash IS NULL) AND jsonb_array_length(fields) = 1)
        OR (action = 'rejects_download' AND run_id IS NOT NULL AND customer_key IS NULL AND customer_key_hash IS NULL)
        OR (action = 'deletion_request' AND run_id IS NULL AND customer_key IS NULL AND customer_key_hash IS NOT NULL AND fields = '[]'::jsonb)
    )
);
CREATE INDEX IF NOT EXISTS idx_pii_access_log_at ON pii_access_log (at DESC);
-- Deleted people, by the HMAC-SHA-256 of the customer key under the tombstone key, in lowercase
-- hex. Never the key.
CREATE TABLE IF NOT EXISTS person_tombstones (
    customer_key_hash text primary key CHECK (customer_key_hash ~ '^[0-9a-f]{64}$'),
    requested_by text NOT NULL,
    requested_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    state text NOT NULL CHECK (state IN ('requested', 'done'))
);
