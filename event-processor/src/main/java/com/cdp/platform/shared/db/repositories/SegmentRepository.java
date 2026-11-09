package com.cdp.platform.shared.db.repositories;

import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.table.api.TableDescriptor;
import org.apache.flink.table.api.bridge.java.StreamTableEnvironment;
import org.apache.flink.types.Row;

import com.cdp.platform.shared.config.DatabaseConfig;

/**
 * PostgreSQL CDC access for the {@code segments} table. The columns live in
 * {@link SegmentsTable}.
 */
public final class SegmentRepository {

    private SegmentRepository() {
    }

    public static DataStream<Row> changelog(StreamTableEnvironment tables, DatabaseConfig database,
        String temporaryTableName, String slotName) {
        tables.createTemporaryTable(temporaryTableName, createCdcSourceDescriptor(database, slotName));
        return PostgresCdc.changelog(tables, temporaryTableName);
    }

    public static TableDescriptor createCdcSourceDescriptor(DatabaseConfig database, String slotName) {
        return PostgresCdc
            .source(database, SegmentsTable.TABLE_NAME, SegmentsTable.PUBLICATION_NAME, slotName,
                SegmentsTable.cdcSchema());
    }
}
