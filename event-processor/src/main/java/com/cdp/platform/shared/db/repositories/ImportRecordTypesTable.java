package com.cdp.platform.shared.db.repositories;

/**
 * The tables {@code import_record_types} and
 * {@code import_record_type_versions} on the main Postgres: datasets and their
 * immutable versions. Studio writes both. The import applier reads them.
 */
public final class ImportRecordTypesTable {

    public static final String TABLE_NAME = "import_record_types";
    public static final String ID = "id";
    public static final String KIND = "kind";
    public static final String CURRENT_VERSION = "current_version";

    public static final String VERSIONS_TABLE_NAME = "import_record_type_versions";
    public static final String VERSION_RECORD_TYPE_ID = "record_type_id";
    public static final String VERSION = "version";
    public static final String VERSION_COLUMNS = "columns";
    public static final String VERSION_ROLES = "roles";
    public static final String VERSION_DELIVERY_MODE = "delivery_mode";
    public static final String VERSION_TIME_ZONE = "time_zone";
    public static final String VERSION_DELIMITER = "delimiter";

    private ImportRecordTypesTable() {
    }
}
