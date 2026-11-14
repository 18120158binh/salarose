package com.cdp.platform.shared.db.repositories;

import java.util.List;

/**
 * The table {@code import_run_commits} in the import store: one commit marker
 * per applied run, written in the run's own transaction with its counts
 * (IAP-FR-15).
 */
public final class ImportRunCommitsTable {

    public static final String TABLE_NAME = "import_run_commits";

    public static final String RUN_ID = "run_id";
    public static final String RECORD_TYPE_ID = "record_type_id";
    public static final String COUNTS = "counts";
    public static final String COMMITTED_AT = "committed_at";

    /** Every column, in the order of the {@code CREATE TABLE}. */
    public static final List<String> COLUMNS = List.of(RUN_ID, RECORD_TYPE_ID, COUNTS, COMMITTED_AT);

    private ImportRunCommitsTable() {
    }
}
