package com.cdp.platform.shared.db.repositories;

import java.util.List;

/**
 * The table {@code segment_import_members}: one row per member of a segment
 * who is known only from imports, with the {@code as_of} of the pass that first
 * found the key a member. The segment membership pass is its only writer, and
 * it joins no CDC publication (SMP-FR-08, SMP-NFR-03).
 */
public final class SegmentImportMembersTable {

    public static final String TABLE_NAME = "segment_import_members";

    public static final String SEGMENT_ID = "segment_id";
    public static final String CUSTOMER_KEY = "customer_key";
    public static final String SINCE = "since";

    /** Every column, in the order of the {@code CREATE TABLE}. */
    public static final List<String> COLUMNS = List.of(SEGMENT_ID, CUSTOMER_KEY, SINCE);

    private SegmentImportMembersTable() {
    }
}
