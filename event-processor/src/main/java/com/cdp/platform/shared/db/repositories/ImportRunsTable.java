package com.cdp.platform.shared.db.repositories;

/**
 * The table {@code import_runs} on the main Postgres: one row per delivered
 * file or re-derive, in the import applier's run states. The import API and
 * studio create rows. The import applier moves them through validation and
 * apply.
 */
public final class ImportRunsTable {

    public static final String TABLE_NAME = "import_runs";

    public static final String ID = "id";
    public static final String RECORD_TYPE_ID = "record_type_id";
    public static final String VERSION = "version";
    public static final String SOURCE = "source";
    public static final String WRITER = "writer";
    public static final String FORMAT = "format";
    public static final String BYTE_SIZE = "byte_size";
    public static final String FILE_KEY = "file_key";
    public static final String STORED_SHA256 = "stored_sha256";
    public static final String STATE = "state";
    public static final String REASON = "reason";
    public static final String COUNTS = "counts";
    public static final String CREATED_AT = "created_at";
    public static final String CONFIRMED_AT = "confirmed_at";
    public static final String APPROVED_AT = "approved_at";
    public static final String STARTED_AT = "started_at";
    public static final String FINISHED_AT = "finished_at";

    private ImportRunsTable() {
    }
}
