package com.cdp.platform.shared.db.repositories;

import java.util.List;

/**
 * The table {@code customer_attributes} in the main Postgres: the import
 * metric pass's per-customer results, one row per customer and imported
 * source. The pass is the only writer. Default replica identity and in no
 * publication (IMP-NFR-04).
 */
public final class CustomerAttributesTable {

    public static final String TABLE_NAME = "customer_attributes";

    public static final String CUSTOMER_KEY = "customer_key";
    public static final String SOURCE_ID = "source_id";
    public static final String ATTRIBUTES = "attributes";
    public static final String ATTRIBUTES_HASH = "attributes_hash";
    public static final String PASS_ID = "pass_id";
    public static final String UPDATED_AT = "updated_at";

    /** Every column, in the order of the {@code CREATE TABLE}. */
    public static final List<String> COLUMNS = List
        .of(CUSTOMER_KEY, SOURCE_ID, ATTRIBUTES, ATTRIBUTES_HASH, PASS_ID, UPDATED_AT);

    private CustomerAttributesTable() {
    }
}
