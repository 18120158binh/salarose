package com.cdp.platform.shared.db.repositories;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;

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

    static final String APPLY_CHANGE_SQL = "/sql/segment_members_apply_change.sql";

    private SegmentMembersTable() {
    }

    /**
     * The statement that applies one change, with the parameters {@code entered},
     * {@code segment_id}, {@code canon_id}, and {@code since}. It lives in
     * {@value #APPLY_CHANGE_SQL}, which {@code infra/db/test-migrations.sh} also
     * runs against the migrated schema, so the two cannot drift.
     */
    static String applyChangeSql() {
        try (InputStream in = SegmentMembersTable.class.getResourceAsStream(APPLY_CHANGE_SQL)) {
            if (in == null) throw new IllegalStateException("Missing resource " + APPLY_CHANGE_SQL);
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException exception) {
            throw new UncheckedIOException("Cannot read " + APPLY_CHANGE_SQL, exception);
        }
    }
}
