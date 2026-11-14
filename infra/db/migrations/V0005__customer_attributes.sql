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
