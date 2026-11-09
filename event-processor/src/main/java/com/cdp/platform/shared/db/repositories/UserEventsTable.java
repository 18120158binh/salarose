package com.cdp.platform.shared.db.repositories;

import org.apache.flink.table.api.DataTypes;
import org.apache.flink.table.api.Schema;

/** The event catalog table {@code user_events}: the columns ingestion reads. */
public final class UserEventsTable {

    public static final String TABLE_NAME = "user_events";
    public static final String PUBLICATION_NAME = "user_events_pub";

    public static final String ID = "id";
    public static final String EVENT_NAME = "event_name";
    public static final String ENFORCE_SCHEMA = "enforce_schema";

    private UserEventsTable() {
    }

    public static Schema cdcSchema() {
        return Schema
            .newBuilder()
            .column(ID, DataTypes.STRING().notNull())
            .column(EVENT_NAME, DataTypes.STRING().notNull())
            .column(ENFORCE_SCHEMA, DataTypes.BOOLEAN().notNull())
            .primaryKey(ID)
            .build();
    }
}
