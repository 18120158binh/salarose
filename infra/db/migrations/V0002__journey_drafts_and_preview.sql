-- V3-02 (#374). The live database may already hold these from a hand-applied change, so every
-- statement skips what exists. A column with a constant default does not rewrite system_users.
ALTER TABLE system_users ADD COLUMN IF NOT EXISTS preview boolean NOT NULL DEFAULT false;
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
