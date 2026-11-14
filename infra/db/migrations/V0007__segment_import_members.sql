-- V3-08 (#20). Members of each segment known only from imports, and one run record per nightly segment membership
-- pass (decision 0038, docs/internal/architecture/components/segment-membership-pass.md). The pass is the only writer
-- of both (SMP-FR-08). It writes a member row only when membership changes, so since is the as_of of the pass that
-- first found the key a member. No foreign key to segments: the pass deletes a deleted segment's rows itself.
-- Neither table is in a publication (SMP-NFR-03). Both are new and empty, so they write almost no WAL.
CREATE TABLE IF NOT EXISTS segment_import_members (
    segment_id text NOT NULL CHECK (segment_id ~ '^SEG-[0-9A-Fa-f]{16}$'),
    customer_key text NOT NULL CHECK (customer_key <> ''),
    since TIMESTAMP WITH TIME ZONE NOT NULL,
    primary key (segment_id, customer_key)
);

CREATE INDEX IF NOT EXISTS idx_segment_import_members_customer_key ON segment_import_members (customer_key);

CREATE TABLE IF NOT EXISTS segment_membership_passes (
    as_of TIMESTAMP WITH TIME ZONE PRIMARY KEY,
    state text NOT NULL CHECK (state IN ('running', 'done', 'failed')),
    fallback boolean NOT NULL,
    metric_pass_id uuid REFERENCES import_metric_passes(id),
    started_at TIMESTAMP WITH TIME ZONE NOT NULL,
    finished_at TIMESTAMP WITH TIME ZONE,
    rows_inserted bigint NOT NULL DEFAULT 0 CHECK (rows_inserted >= 0),
    rows_deleted bigint NOT NULL DEFAULT 0 CHECK (rows_deleted >= 0),
    skipped_segments text[] NOT NULL DEFAULT '{}',
    pauses integer NOT NULL DEFAULT 0 CHECK (pauses >= 0),
    paused_seconds double precision NOT NULL DEFAULT 0 CHECK (paused_seconds >= 0),
    CHECK ((state = 'running') = (finished_at IS NULL))
);
