package com.cdp.platform.shared.db.repositories;

/**
 * The table {@code import_metric_definitions} in the main Postgres: dataset
 * metrics that staff define in studio. The import metric pass reads it.
 */
public final class ImportMetricDefinitionsTable {

    public static final String TABLE_NAME = "import_metric_definitions";

    public static final String ID = "id";
    public static final String RECORD_TYPE_ID = "record_type_id";
    public static final String NAME = "name";
    public static final String FUNCTION = "function";
    public static final String COLUMN = "\"column\"";
    public static final String FILTERS = "filters";
    public static final String WINDOW_DAYS = "window_days";
    public static final String ARCHIVED_AT = "archived_at";

    private ImportMetricDefinitionsTable() {
    }
}
