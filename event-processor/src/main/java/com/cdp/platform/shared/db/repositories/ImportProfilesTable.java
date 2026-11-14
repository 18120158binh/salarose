package com.cdp.platform.shared.db.repositories;

import java.util.List;

/**
 * The table {@code import_profiles} in the import store: the rows of profile
 * datasets, one per record type and customer key. Only the import applier
 * writes it.
 */
public final class ImportProfilesTable {

    public static final String TABLE_NAME = "import_profiles";

    public static final String RECORD_TYPE_ID = "record_type_id";
    public static final String CUSTOMER_KEY = "customer_key";
    public static final String DATA = "data";
    public static final String WRITER = "writer";
    public static final String RUN_ID = "run_id";

    /** Every column, in the order of the {@code CREATE TABLE}. */
    public static final List<String> COLUMNS = List.of(RECORD_TYPE_ID, CUSTOMER_KEY, DATA, WRITER, RUN_ID);

    private ImportProfilesTable() {
    }
}
