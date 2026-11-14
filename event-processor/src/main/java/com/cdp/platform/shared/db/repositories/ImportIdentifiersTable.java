package com.cdp.platform.shared.db.repositories;

import java.util.List;

/**
 * The table {@code import_identifiers} in the import store: the normalized
 * emails and phones of profile rows. The import applier replaces a customer's
 * rows per record type and customer key.
 */
public final class ImportIdentifiersTable {

    public static final String TABLE_NAME = "import_identifiers";

    public static final String RECORD_TYPE_ID = "record_type_id";
    public static final String CUSTOMER_KEY = "customer_key";
    public static final String TYPE = "type";
    public static final String VALUE = "value";
    public static final String WRITER = "writer";
    public static final String RUN_ID = "run_id";

    /** Every column, in the order of the {@code CREATE TABLE}. */
    public static final List<String> COLUMNS = List.of(RECORD_TYPE_ID, CUSTOMER_KEY, TYPE, VALUE, WRITER, RUN_ID);

    private ImportIdentifiersTable() {
    }
}
