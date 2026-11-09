package com.cdp.platform.shared.db.repositories;

import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.table.api.TableDescriptor;
import org.apache.flink.table.api.bridge.java.StreamTableEnvironment;
import org.apache.flink.types.Row;

import com.cdp.platform.shared.config.DatabaseConfig;

/** PostgreSQL CDC access for the event catalog tables. */
public final class UserEventCatalogRepository {

    private UserEventCatalogRepository() {
    }

    /** Changes to {@code user_events}. */
    public static DataStream<Row> eventChangelog(StreamTableEnvironment tables, DatabaseConfig database,
        String temporaryTableName, String slotName) {
        return changelog(tables, temporaryTableName, eventDescriptor(database, slotName));
    }

    /** Changes to {@code user_event_fields}. */
    public static DataStream<Row> attributeChangelog(StreamTableEnvironment tables, DatabaseConfig database,
        String temporaryTableName, String slotName) {
        return changelog(tables, temporaryTableName, attributeDescriptor(database, slotName));
    }

    public static TableDescriptor eventDescriptor(DatabaseConfig database, String slotName) {
        return PostgresCdc
            .source(database, UserEventsTable.TABLE_NAME, UserEventsTable.PUBLICATION_NAME, slotName,
                UserEventsTable.cdcSchema());
    }

    public static TableDescriptor attributeDescriptor(DatabaseConfig database, String slotName) {
        return PostgresCdc
            .source(database, UserEventFieldsTable.TABLE_NAME, UserEventFieldsTable.PUBLICATION_NAME, slotName,
                UserEventFieldsTable.cdcSchema());
    }

    private static DataStream<Row> changelog(StreamTableEnvironment tables, String temporaryTableName,
        TableDescriptor descriptor) {
        tables.createTemporaryTable(temporaryTableName, descriptor);
        return PostgresCdc.changelog(tables, temporaryTableName);
    }
}
