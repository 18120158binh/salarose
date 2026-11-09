-- The schema of the deploy tip before V3-02, when Flyway took over. A database that already holds it
-- is baselined at version 1 and never runs this file.
-- Staff users. Sign-in creates each row from the provider account (oidc_issuer, oidc_subject),
-- and writes role and email from the ID token at every sign-in. The email is for display and is
-- not unique.
CREATE TABLE IF NOT EXISTS system_users (
    id text primary key,
    email text NOT NULL,
    role text NOT NULL,
    oidc_issuer text NOT NULL,
    oidc_subject text NOT NULL,
    session_epoch integer NOT NULL DEFAULT 0
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
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
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
