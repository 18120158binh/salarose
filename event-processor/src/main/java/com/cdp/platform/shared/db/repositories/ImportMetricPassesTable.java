package com.cdp.platform.shared.db.repositories;

/**
 * The columns of {@code import_metric_passes} that the segment membership pass
 * reads: one row per nightly data-import metric pass. The import metric pass
 * is its only writer.
 */
public final class ImportMetricPassesTable {

    public static final String TABLE_NAME = "import_metric_passes";

    public static final String ID = "id";
    public static final String AS_OF = "as_of";
    public static final String STATE = "state";

    public static final String DONE = "done";

    private ImportMetricPassesTable() {
    }
}
