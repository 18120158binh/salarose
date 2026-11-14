package com.cdp.platform.shared.db.repositories;

import java.util.List;

/**
 * The table {@code import_records} in the import store: the records of event
 * datasets, one row per record type and record id. Only the import applier
 * writes it.
 */
public final class ImportRecordsTable {

    public static final String TABLE_NAME = "import_records";

    public static final String RECORD_TYPE_ID = "record_type_id";
    public static final String RECORD_ID = "record_id";
    public static final String CUSTOMER_KEY = "customer_key";
    public static final String EVENT_TIME = "event_time";
    public static final String UPDATED_AT = "updated_at";
    public static final String DATA = "data";
    public static final String WRITER = "writer";
    public static final String RUN_ID = "run_id";

    /** Every column, in the order of the {@code CREATE TABLE}. */
    public static final List<String> COLUMNS = List
        .of(RECORD_TYPE_ID, RECORD_ID, CUSTOMER_KEY, EVENT_TIME, UPDATED_AT, DATA, WRITER, RUN_ID);

    private ImportRecordsTable() {
    }
}
