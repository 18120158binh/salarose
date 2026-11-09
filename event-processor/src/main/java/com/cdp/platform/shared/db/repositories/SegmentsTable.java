package com.cdp.platform.shared.db.repositories;

import org.apache.flink.table.api.DataTypes;
import org.apache.flink.table.api.Schema;

/**
 * The table {@code segments}: one row per saved segment. Studio writes it, and
 * customer decision reads it through CDC.
 */
public final class SegmentsTable {

    public static final String TABLE_NAME = "segments";
    public static final String PUBLICATION_NAME = "segments_pub";

    public static final String ID = "id";
    public static final String CONDITIONS_JSON = "conditions_json";

    private SegmentsTable() {
    }

    /** The columns customer decision reads through CDC. */
    public static Schema cdcSchema() {
        return Schema
            .newBuilder()
            .column(ID, DataTypes.STRING().notNull())
            .column(CONDITIONS_JSON, DataTypes.STRING().notNull())
            .primaryKey(ID)
            .build();
    }
}
