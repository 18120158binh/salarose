package com.cdp.platform.shared.db.repositories;

import java.util.List;

/**
 * The table {@code segment_membership_passes}: one run record per nightly
 * segment membership pass, keyed by its {@code as_of} (SMP-FR-11). Written only
 * by the pass, and in no CDC publication.
 */
public final class SegmentMembershipPassesTable {

    public static final String TABLE_NAME = "segment_membership_passes";

    public static final String AS_OF = "as_of";
    public static final String STATE = "state";
    public static final String FALLBACK = "fallback";
    public static final String METRIC_PASS_ID = "metric_pass_id";
    public static final String STARTED_AT = "started_at";
    public static final String FINISHED_AT = "finished_at";
    public static final String ROWS_INSERTED = "rows_inserted";
    public static final String ROWS_DELETED = "rows_deleted";
    public static final String SKIPPED_SEGMENTS = "skipped_segments";
    public static final String PAUSES = "pauses";
    public static final String PAUSED_SECONDS = "paused_seconds";

    public static final String RUNNING = "running";
    public static final String DONE = "done";
    public static final String FAILED = "failed";

    /** Every column, in the order of the {@code CREATE TABLE}. */
    public static final List<String> COLUMNS = List
        .of(AS_OF, STATE, FALLBACK, METRIC_PASS_ID, STARTED_AT, FINISHED_AT, ROWS_INSERTED, ROWS_DELETED,
            SKIPPED_SEGMENTS, PAUSES, PAUSED_SECONDS);

    private SegmentMembershipPassesTable() {
    }
}
