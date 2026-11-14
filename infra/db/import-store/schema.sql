-- The import store's tables, on the cluster cdp-import-pg (docs/internal/architecture/data-model.md#import-store).
-- Decision 0040 amends decision 0019 to one DDL file per Postgres cluster, so this file is the only place that creates
-- these tables. The Job import-store-ddl (infra/k8s/data/import-store-ddl.yaml) applies it as the owner cdp_import on
-- every sync, so every statement must be safe to run again. Only the import applier writes these tables. The import
-- metric pass and studio read them as import_reader. The ids in record_type_id and run_id belong to the main Postgres,
-- so no foreign key holds them here.

-- Records of event datasets, one row per (record_type_id, record_id). data holds the shop's columns.
CREATE TABLE IF NOT EXISTS import_records (
    record_type_id uuid NOT NULL,
    record_id text NOT NULL CHECK (record_id <> ''),
    customer_key text NOT NULL CHECK (customer_key <> ''),
    event_time TIMESTAMP WITH TIME ZONE NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE,
    data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
    writer text NOT NULL CHECK (writer <> ''),
    run_id uuid NOT NULL,
    primary key (record_type_id, record_id)
);
CREATE INDEX IF NOT EXISTS idx_import_records_customer ON import_records (record_type_id, customer_key, event_time);

-- Rows of profile datasets, one per (record_type_id, customer_key).
CREATE TABLE IF NOT EXISTS import_profiles (
    record_type_id uuid NOT NULL,
    customer_key text NOT NULL CHECK (customer_key <> ''),
    data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
    writer text NOT NULL CHECK (writer <> ''),
    run_id uuid NOT NULL,
    primary key (record_type_id, customer_key)
);

-- Normalized emails and phones of profile rows. The applier replaces a customer's rows per (record_type_id,
-- customer_key), and looks up (type, value) to count identifiers that another customer key already holds.
CREATE TABLE IF NOT EXISTS import_identifiers (
    record_type_id uuid NOT NULL,
    customer_key text NOT NULL CHECK (customer_key <> ''),
    type text NOT NULL CHECK (type IN ('email', 'phone')),
    value text NOT NULL CHECK (value <> ''),
    writer text NOT NULL CHECK (writer <> ''),
    run_id uuid NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_import_identifiers_customer ON import_identifiers (record_type_id, customer_key);
CREATE INDEX IF NOT EXISTS idx_import_identifiers_value ON import_identifiers (type, value);

-- One commit marker per applied run, written in the run's own transaction with its counts (IAP-FR-15).
CREATE TABLE IF NOT EXISTS import_run_commits (
    run_id uuid primary key,
    record_type_id uuid NOT NULL,
    counts jsonb NOT NULL CHECK (jsonb_typeof(counts) = 'object'),
    committed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
