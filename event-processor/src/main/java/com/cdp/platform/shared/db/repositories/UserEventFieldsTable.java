package com.cdp.platform.shared.db.repositories;

import org.apache.flink.table.api.DataTypes;
import org.apache.flink.table.api.Schema;

/**
 * The event catalog table {@code user_event_fields}: the columns ingestion
 * reads.
 */
public final class UserEventFieldsTable {

    public static final String TABLE_NAME = "user_event_fields";
    public static final String PUBLICATION_NAME = "user_event_fields_pub";

    public static final String ID = "id";
    public static final String USER_EVENT_ID = "user_event_id";
    public static final String FIELD_PATH = "field_path";
    public static final String DATA_TYPE = "data_type";
    public static final String REQUIRED = "required";

    private UserEventFieldsTable() {
    }

    public static Schema cdcSchema() {
        return Schema
            .newBuilder()
            .column(ID, DataTypes.INT().notNull())
            .column(USER_EVENT_ID, DataTypes.STRING())
            .column(FIELD_PATH, DataTypes.STRING().notNull())
            .column(DATA_TYPE, DataTypes.STRING().notNull())
            .column(REQUIRED, DataTypes.BOOLEAN().notNull())
            .primaryKey(ID)
            .build();
    }
}
