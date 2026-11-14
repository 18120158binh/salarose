-- V3-07 (#17). Tracked members of each segment (decision 0038). The profile writer is the only
-- writer: it inserts on an entered change and deletes on an exited one, so a deleted segment's rows
-- leave through the exited changes customer decision publishes, not through a foreign key.
-- In no publication. A new, empty table, so it writes almost no WAL.
CREATE TABLE IF NOT EXISTS segment_members (
    segment_id text NOT NULL CHECK (segment_id ~ '^SEG-[0-9A-Fa-f]{16}$'),
    canon_id text NOT NULL CHECK (canon_id <> ''),
    since TIMESTAMP WITH TIME ZONE NOT NULL,
    primary key (segment_id, canon_id)
);
