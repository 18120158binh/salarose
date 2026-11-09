-- Per-event counts for Data > Events and Data > Monitoring. The event parse job upserts one row
-- per event name, hour, and outcome, so a burst of events writes a few rows, not one per event.
-- outcome is 'accepted' or the drop reason of an event the job could name. In no publication.
CREATE TABLE IF NOT EXISTS event_volume (
    event_name text NOT NULL CHECK (event_name <> ''),
    bucket_start TIMESTAMP WITH TIME ZONE NOT NULL CHECK (extract(epoch FROM bucket_start) % 3600 = 0),
    outcome text NOT NULL CHECK (outcome <> ''),
    count bigint NOT NULL CHECK (count > 0),
    last_seen_at TIMESTAMP WITH TIME ZONE NOT NULL,
    primary key (event_name, bucket_start, outcome)
);
CREATE INDEX IF NOT EXISTS idx_event_volume_bucket ON event_volume (bucket_start);
-- The staff user whose save created the definition. Null for a definition created before this
-- column, or whose user was deleted. A column with no default does not rewrite the table.
ALTER TABLE user_metric_definitions
    ADD COLUMN IF NOT EXISTS created_by text REFERENCES system_users(id) ON DELETE SET NULL;
