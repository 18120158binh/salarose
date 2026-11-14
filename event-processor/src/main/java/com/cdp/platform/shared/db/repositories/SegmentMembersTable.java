package com.cdp.platform.shared.db.repositories;

/**
 * The table {@code segment_members}: one row per tracked person in a segment,
 * with the time they entered. The profile writer is its only writer, and it
 * joins no CDC publication.
 */
public final class SegmentMembersTable {

    public static final String TABLE_NAME = "segment_members";

    static final String SEGMENT_ID = "segment_id";
    static final String CANON_ID = "canon_id";
    static final String SINCE = "since";

    private SegmentMembersTable() {
    }

    /**
     * Applies one change, with the parameters {@code entered}, {@code segment_id},
     * {@code canon_id}, and {@code since}. An exited change deletes the row. An
     * entered change sets {@code since} only when it differs, and inserts the row
     * when there is none. Neither the update nor the insert touches a row that
     * already holds the change's {@code since}, so a repeated change writes no WAL
     * and takes no row lock (PRW-FR-12). An upsert with {@code DO UPDATE} would
     * lock the row even when its {@code WHERE} matches nothing.
     */
    static String applyChangeSql() {
        return """
            WITH change (entered, segment_id, canon_id, since) AS (
                VALUES (CAST(? AS boolean), CAST(? AS text), CAST(? AS text), CAST(? AS timestamptz))
            ), deleted AS (
                DELETE FROM %1$s m USING change c
                WHERE NOT c.entered AND m.%2$s = c.segment_id AND m.%3$s = c.canon_id
            ), updated AS (
                UPDATE %1$s m SET %4$s = c.since FROM change c
                WHERE c.entered AND m.%2$s = c.segment_id AND m.%3$s = c.canon_id AND m.%4$s <> c.since
                RETURNING 1
            )
            INSERT INTO %1$s (%2$s, %3$s, %4$s)
            SELECT c.segment_id, c.canon_id, c.since FROM change c
            WHERE c.entered AND NOT EXISTS (SELECT 1 FROM updated)
            ON CONFLICT (%2$s, %3$s) DO NOTHING
            """.formatted(TABLE_NAME, SEGMENT_ID, CANON_ID, SINCE);
    }
}
