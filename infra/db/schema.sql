DROP VIEW IF EXISTS campaign_steps CASCADE;
DROP TABLE IF EXISTS campaign_steps CASCADE;
DROP TABLE IF EXISTS campaign_nodes CASCADE;
DROP TABLE IF EXISTS journey_publishes;
DROP TABLE IF EXISTS journey_drafts;
DROP TABLE IF EXISTS event_volume;
DROP TABLE IF EXISTS campaigns CASCADE;
DROP TABLE IF EXISTS segments CASCADE;
-- The input table and functions of the old Postgres journey engine, which
-- databases created before it was removed still hold.
DROP TABLE IF EXISTS user_events_log CASCADE;
DROP FUNCTION IF EXISTS evaluate_state_transitions();
DROP FUNCTION IF EXISTS get_transition_watch_children(VARCHAR, VARCHAR, VARCHAR);
DROP FUNCTION IF EXISTS cleanup_user_events_log(INTERVAL, INT);
DROP TABLE IF EXISTS user_campaign_state_transitions CASCADE;
DROP TABLE IF EXISTS mailbox CASCADE;
DROP TABLE IF EXISTS event_logs CASCADE;
DROP TABLE IF EXISTS user_events CASCADE;
DROP TABLE IF EXISTS user_event_fields CASCADE;
DROP TABLE IF EXISTS user_event_fields CASCADE;
DROP TABLE IF EXISTS identity_graph CASCADE;
DROP TABLE IF EXISTS system_user_id_tokens;
DROP TABLE IF EXISTS customer_attributes;
DROP TABLE IF EXISTS pii_access_log;
DROP TABLE IF EXISTS person_tombstones;
DROP TABLE IF EXISTS import_runs;
DROP TABLE IF EXISTS import_metric_passes;
DROP TABLE IF EXISTS import_metric_definitions;
DROP TABLE IF EXISTS import_source_scopes;
DROP TABLE IF EXISTS import_record_type_versions;
DROP TABLE IF EXISTS import_record_types;
DROP TABLE IF EXISTS ingestion_source_keys;
DROP TABLE IF EXISTS system_users CASCADE;
-- campaign_node_stats used to be a table that this trigger function filled. Databases created
-- since then hold a view, which the drop of user_campaign_state_transitions above removes.
DROP TABLE IF EXISTS campaign_node_stats;
DROP FUNCTION IF EXISTS trg_update_campaign_node_stats();
-- Staff users. Sign-in creates each row from the provider account (oidc_issuer, oidc_subject),
-- and writes role and email from the ID token at every sign-in. The email is for display and is
-- not unique.
CREATE TABLE IF NOT EXISTS system_users (
    id text primary key,
    email text NOT NULL,
    role text NOT NULL,
    oidc_issuer text NOT NULL,
    oidc_subject text NOT NULL,
    session_epoch integer NOT NULL DEFAULT 0,
    -- Opens routes at stage preview to an editor. An admin sets it with SQL.
    preview boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS system_users_oidc_account_key ON system_users (oidc_issuer, oidc_subject);
-- The ID token of each staff user's latest sign-in, kept only for a provider that needs
-- id_token_hint at sign-out.
CREATE TABLE IF NOT EXISTS system_user_id_tokens (
    user_id text primary key REFERENCES system_users(id) ON DELETE CASCADE,
    session_epoch integer NOT NULL,
    id_token text NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
-- Keys of the systems that post to the data ingestion API. Only a SHA-256 hash of each key is
-- kept. A revoked key keeps its row. An app id has at most one key that is not revoked, so a
-- source rotates its key by revoking the old one and creating a new one.
CREATE TABLE IF NOT EXISTS ingestion_source_keys (
    id text primary key,
    app_id text NOT NULL,
    key_hash text NOT NULL CONSTRAINT ingestion_source_keys_key_hash_key UNIQUE,
    key_hint text NOT NULL,
    created_by text REFERENCES system_users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at TIMESTAMP WITH TIME ZONE
);
CREATE UNIQUE INDEX IF NOT EXISTS ingestion_source_keys_active_app_id_key ON ingestion_source_keys (app_id) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS identity_graph (
    domain_userid VARCHAR NOT NULL,
    user_id VARCHAR,
    canon_id VARCHAR NOT NULL DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    primary key (domain_userid)
);
CREATE INDEX IF NOT EXISTS idx_ig_user_latest
ON identity_graph (
    user_id,
    updated_at DESC
) include (
    domain_userid,
    canon_id
)
WHERE
    user_id IS NOT NULL;
-- Profile lookups read the newest user_id of a canon_id.
CREATE INDEX IF NOT EXISTS idx_ig_canon_latest
ON identity_graph (
    canon_id,
    updated_at DESC
) include (
    user_id
)
WHERE
    user_id IS NOT NULL;
-- Studio v2 customer lookup lists every identity of a canon_id, devices with no user_id
-- included (decision 0035).
CREATE INDEX IF NOT EXISTS idx_ig_canon
ON identity_graph (
    canon_id
) include (
    domain_userid,
    user_id,
    created_at,
    updated_at
);
CREATE TABLE IF NOT EXISTS user_events (
        id VARCHAR primary key,
        event_name VARCHAR NOT NULL CONSTRAINT user_events_event_name_key UNIQUE,
        display_name VARCHAR,
        description text,
        sample_payload text,
        status VARCHAR DEFAULT 'active',
        -- When true, ingestion drops each event of this name that does not match its attributes.
        enforce_schema BOOLEAN NOT NULL DEFAULT false,
        kind VARCHAR NOT NULL DEFAULT 'person' CONSTRAINT user_events_kind_check CHECK (kind IN ('person', 'business')),
        -- The attribute path that names a business event's item, such as product.id.
        item_key VARCHAR,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT user_events_item_key_check CHECK ((kind = 'business') = (item_key IS NOT NULL))
    );
CREATE TABLE IF NOT EXISTS user_event_fields (
        id serial primary key,
        user_event_id VARCHAR references user_events(id)
        ON
        DELETE
            CASCADE,
            field_path VARCHAR NOT NULL,
            display_name VARCHAR,
            data_type VARCHAR NOT NULL,
            example_value VARCHAR,
            default_value VARCHAR,
            required BOOLEAN NOT NULL DEFAULT false,
            UNIQUE(
                user_event_id,
                field_path
            )
    );
CREATE TABLE IF NOT EXISTS campaigns (
        id VARCHAR primary key,
        NAME VARCHAR NOT NULL,
        description text,
        status VARCHAR NOT NULL,
        root jsonb NOT NULL,
        created_user text references system_users(id),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
-- One value per publish of a campaign's graph, written to campaign_nodes.graph_version.
CREATE SEQUENCE IF NOT EXISTS campaign_graph_version_seq;
CREATE TABLE IF NOT EXISTS campaign_nodes (
        campaign_id VARCHAR NOT NULL,
        node_id VARCHAR NOT NULL,
        node_type VARCHAR NOT NULL,
        parent_node_id VARCHAR,
        parent_branch VARCHAR,
        -- The rule, in the saved format of the journey builder contract: the
        -- trigger, the conditions on the person, and how the node branches.
        trigger_json text,
        conditions_json text,
        paths_json text,
        action_json text,
        goal_id VARCHAR,
        -- The number of nodes in the save that wrote the row. The state machine
        -- applies a save once every row of it has arrived.
        campaign_node_count integer NOT NULL CHECK (campaign_node_count > 0),
        -- The version of the graph that the save wrote, the same on every row of
        -- the save. A publish takes the next value of campaign_graph_version_seq,
        -- and a resume keeps the version. Triggers carry it, so that the state
        -- machine can tell which graph a trigger was decided against.
        graph_version bigint NOT NULL,
        primary key (
            campaign_id,
            node_id
        ),
        foreign key (campaign_id) references campaigns(id)
        ON
        DELETE
            CASCADE
    );
ALTER TABLE
    campaign_nodes replica identity full;
CREATE INDEX IF NOT EXISTS idx_cn_parent
    ON campaign_nodes (
        campaign_id,
        parent_node_id,
        parent_branch
    );
-- Unpublished journeys (decision 0036). The id is the future campaign id. Each save raises version
-- and names the version it read. Publish deletes the row. In no publication, so autosaves reach
-- no CDC consumer.
CREATE TABLE IF NOT EXISTS journey_drafts (
    id text primary key,
    owner_id text NOT NULL references system_users(id),
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    root jsonb NOT NULL,
    origin text NOT NULL CHECK (
        origin IN ('blank', 'ai', 'browser') OR origin LIKE 'template:_%' OR origin LIKE 'duplicate:_%'
    ),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_journey_drafts_owner ON journey_drafts (owner_id, updated_at DESC);
-- One row per publish from a draft. draft_id is the old id when the draft was published as a new
-- journey. root_hash is the SHA-256 of the published root's jsonb text, so a retry of the same
-- publish is told from a collision with another publisher. In no publication.
CREATE TABLE IF NOT EXISTS journey_publishes (
    campaign_id text primary key references campaigns(id) ON DELETE CASCADE,
    draft_id text NOT NULL UNIQUE,
    root_hash text NOT NULL,
    published_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS user_metric_definitions (
        id VARCHAR primary key,
        NAME VARCHAR NOT NULL,
        display_name VARCHAR NOT NULL,
        processing_mode VARCHAR NOT NULL DEFAULT 'LIVE',
        user_event_id VARCHAR references user_events(id)
        ON
        DELETE
            CASCADE,
            event_name VARCHAR NOT NULL DEFAULT '',
            default_properties jsonb DEFAULT '{}',
            filter_conditions jsonb DEFAULT '{}',
            agg_operator VARCHAR DEFAULT 'COUNT',
            agg_field VARCHAR,
            metric_type VARCHAR(32) NOT NULL DEFAULT 'EVENT_SERIES' CHECK (metric_type IN ('EVENT_SERIES', 'LATEST')),
            value_type VARCHAR(32) NOT NULL DEFAULT 'PRESENCE' CHECK (
                value_type IN (
                    'PRESENCE',
                    'NUMBER',
                    'STRING',
                    'BOOLEAN'
                )
            ),
            retention_ms bigint NOT NULL DEFAULT 2592000000 CHECK (
                retention_ms > 0
            ),
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            source_name VARCHAR,
            query_sql text,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            -- The staff user whose save created the definition. Null for a definition created
            -- before the column, or whose user was deleted.
            created_by text references system_users(id) ON DELETE SET NULL
    );
-- Per-event counts for Data > Events and Data > Monitoring. The event parse job upserts one row
-- per event name, hour, and outcome. outcome is 'accepted' or the drop reason of an event the job
-- could name. In no publication.
CREATE TABLE IF NOT EXISTS event_volume (
    event_name text NOT NULL CHECK (event_name <> ''),
    bucket_start TIMESTAMP WITH TIME ZONE NOT NULL CHECK (extract(epoch FROM bucket_start) % 3600 = 0),
    outcome text NOT NULL CHECK (outcome <> ''),
    count bigint NOT NULL CHECK (count > 0),
    last_seen_at TIMESTAMP WITH TIME ZONE NOT NULL,
    primary key (event_name, bucket_start, outcome)
);
CREATE INDEX IF NOT EXISTS idx_event_volume_bucket ON event_volume (bucket_start);
-- Saved segments: a name and condition groups that campaigns use as entry triggers, audiences,
-- and segment_membership conditions (decision 0031). conditions_json is
-- { "groups": [ { "conditions": [ ... ] } ] } of profile_property and behavior entries, each
-- behavior entry with the metric_id studio derived. Customer decision reads it through CDC.
CREATE TABLE IF NOT EXISTS segments (
    id VARCHAR primary key CHECK (id ~ '^SEG-[0-9A-Fa-f]{16}$'),
    name VARCHAR NOT NULL CHECK (btrim(name) <> ''),
    description text NOT NULL DEFAULT '',
    conditions_json jsonb NOT NULL CHECK (jsonb_typeof(conditions_json -> 'groups') = 'array'),
    created_by text references system_users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- A series is its buckets, not its occurrences. Drop a table built with the
-- old occurrence arrays, so that CREATE TABLE IF NOT EXISTS builds the new one.
-- The system holds no production data.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'user_metrics' AND column_name = 'event_occurrence_ids'
    ) THEN
        DROP TABLE user_metrics CASCADE;
    END IF;
END $$;
ALTER TABLE user_metric_definitions DROP COLUMN IF EXISTS max_retention_value;
CREATE TABLE IF NOT EXISTS user_metrics (
        canon_id VARCHAR NOT NULL,
        metric_id VARCHAR NOT NULL references user_metric_definitions(id)
        ON
        DELETE
            CASCADE,
            series_clock bigint NOT NULL,
            buckets jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(buckets) = 'array'),
            last_behavior_version bigint NOT NULL DEFAULT 0,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            primary key (
                canon_id,
                metric_id
            )
    );
CREATE INDEX IF NOT EXISTS idx_user_metrics_metric_users
    ON user_metrics (
        metric_id,
        canon_id
    );
CREATE TABLE IF NOT EXISTS user_campaign_state_transitions (
    canon_id VARCHAR NOT NULL,
    domain_userid VARCHAR,
    network_userid VARCHAR,
    user_id VARCHAR,
    campaign_id VARCHAR NOT NULL,
    -- The entry of the journey key the node completed in: 'first', or the entry id
    -- of the setup trigger that opened it (decision 0033).
    entry_id VARCHAR NOT NULL,
    node_id VARCHAR NOT NULL,
    branch VARCHAR NOT NULL,
    event_timestamp bigint NOT NULL,
    -- When the state machine wrote the row. With event_timestamp, it shows how
    -- far the engine runs behind the events. No job reads it.
    transitioned_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    node_type VARCHAR NOT NULL,
    action_json text,
    context_json text,
    children jsonb,
    event_id uuid,
    primary key (
        canon_id,
        campaign_id,
        entry_id,
        node_id,
        branch
    )
);
-- Users per node for the builder: the entries that completed each node, on any branch, so a
-- person with two entries counts twice. Computed on read, so that a transition insert locks no
-- shared row (decision 0009).
CREATE INDEX IF NOT EXISTS idx_ucst_campaign_node
ON user_campaign_state_transitions (
    campaign_id,
    node_id,
    canon_id,
    entry_id
);
-- Studio v2 computes journey analytics from the transitions on read (decision 0035). This one
-- serves the reach set of each node and the entries of a journey in a time range.
CREATE INDEX IF NOT EXISTS idx_ucst_node_reach
ON user_campaign_state_transitions (
    campaign_id,
    node_id,
    branch,
    event_timestamp
) include (
    canon_id,
    entry_id
);
-- The home KPIs across all journeys, by event time.
CREATE INDEX IF NOT EXISTS idx_ucst_type_event_time
ON user_campaign_state_transitions (
    node_type,
    event_timestamp
) include (
    campaign_id,
    branch
);
-- Engine lag reads setup, check, and watch transitions on the success branch by write time.
CREATE INDEX IF NOT EXISTS idx_ucst_type_written
ON user_campaign_state_transitions (
    node_type,
    transitioned_at
) include (
    event_timestamp,
    branch
);
CREATE OR REPLACE VIEW campaign_node_stats (campaign_id, node_id, user_count) AS
SELECT
    campaign_id,
    node_id,
    COUNT(DISTINCT (canon_id, entry_id))
FROM
    user_campaign_state_transitions
GROUP BY
    campaign_id,
    node_id;
ALTER TABLE
    campaigns replica identity full;
ALTER TABLE
    campaign_nodes replica identity full;
ALTER TABLE
    user_metric_definitions replica identity full;
ALTER TABLE
    user_metrics replica identity full;
ALTER TABLE
    user_events replica identity full;
ALTER TABLE
    user_event_fields replica identity full;
ALTER TABLE
    segments replica identity full;
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
-- The import metric pass's per-customer results (docs/internal/architecture/components/import-metric-pass.md). One row
-- per customer and imported source, where source_id is the dataset's name. The pass is the only writer, and it rewrites
-- a row only when attributes_hash changes. Default replica identity and in no publication (IMP-NFR-04): with
-- wal_level=logical, replica identity full would log the old row on every update.
CREATE TABLE IF NOT EXISTS customer_attributes (
    customer_key text NOT NULL CHECK (customer_key <> ''),
    source_id text NOT NULL CHECK (source_id ~ '^[a-z][a-z0-9_]*$'),
    attributes jsonb NOT NULL CHECK (jsonb_typeof(attributes) = 'object'),
    attributes_hash text NOT NULL CHECK (attributes_hash ~ '^[0-9a-f]{64}$'),
    pass_id uuid NOT NULL REFERENCES import_metric_passes(id),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    primary key (customer_key, source_id)
);
-- Each CDC source upserts its slot's row on every heartbeat. The write reaches every slot through
-- its publication, so a slot moves its confirmed position while its captured table is quiet.
CREATE TABLE IF NOT EXISTS cdc_heartbeat (
    slot_name text primary key,
    beat_at TIMESTAMP WITH TIME ZONE NOT NULL
);
CREATE publication campaign_nodes_pub FOR TABLE campaign_nodes, cdc_heartbeat;
CREATE publication campaigns_pub FOR TABLE campaigns, cdc_heartbeat;
CREATE publication outbox_transitions_pub FOR TABLE user_campaign_state_transitions, cdc_heartbeat;
CREATE publication metric_defs_pub FOR TABLE user_metric_definitions, cdc_heartbeat;
CREATE publication user_events_pub FOR TABLE user_events, cdc_heartbeat;
CREATE publication user_event_fields_pub FOR TABLE user_event_fields, cdc_heartbeat;
CREATE publication segments_pub FOR TABLE segments, cdc_heartbeat;
