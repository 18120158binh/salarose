-- Applies one segment membership change to segment_members (PRW-FR-08 to PRW-FR-12). Parameters, in order:
-- entered, segment_id, canon_id, since (null for exited). The profile writer runs this file, and
-- infra/db/test-migrations.sh runs the same file against the migrated schema.
-- exited deletes the row. entered moves since only when it differs, and inserts the row when there is none.
-- Neither touches a row that already holds the change's since, so a repeated change writes no WAL and takes no row
-- lock. An upsert that updates on conflict would lock the row even when its WHERE matches nothing.
WITH change (entered, segment_id, canon_id, since) AS (
    VALUES (CAST(? AS boolean), CAST(? AS text), CAST(? AS text), CAST(? AS timestamptz))
), deleted AS (
    DELETE FROM segment_members m USING change c
    WHERE NOT c.entered AND m.segment_id = c.segment_id AND m.canon_id = c.canon_id
), updated AS (
    UPDATE segment_members m SET since = c.since FROM change c
    WHERE c.entered AND m.segment_id = c.segment_id AND m.canon_id = c.canon_id AND m.since <> c.since
    RETURNING 1
)
INSERT INTO segment_members (segment_id, canon_id, since)
SELECT c.segment_id, c.canon_id, c.since FROM change c
WHERE c.entered AND NOT EXISTS (SELECT 1 FROM updated)
ON CONFLICT (segment_id, canon_id) DO NOTHING
