package com.cdp.platform.shared.db.repositories;

/**
 * The table {@code import_metric_passes}: one row per nightly data-import
 * metric pass. The import metric pass writes it, studio stamps
 * {@code retry_requested_at}, and the segment membership pass reads it.
 */
public final class ImportMetricPassesTable {

    public static final String TABLE_NAME = "import_metric_passes";

    public static final String ID = "id";
    public static final String AS_OF = "as_of";
    public static final String STATE = "state";
    public static final String REASON = "reason";
    public static final String RETRY_REQUESTED_AT = "retry_requested_at";
    public static final String LAST_RUN_FINISHED_AT = "last_run_finished_at";
    public static final String COUNTS = "counts";
    public static final String CHANGED_ROWS = "changed_rows";
    public static final String WAL_BYTES = "wal_bytes";
    public static final String PAUSES = "pauses";
    public static final String STARTED_AT = "started_at";
    public static final String FINISHED_AT = "finished_at";

    public static final String RUNNING = "running";
    public static final String DONE = "done";
    public static final String FAILED = "failed";

    private ImportMetricPassesTable() {
    }
}
