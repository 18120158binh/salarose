package com.cdp.platform.shared.db.repositories;

import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.table.api.TableDescriptor;
import org.apache.flink.table.api.bridge.java.StreamTableEnvironment;
import org.apache.flink.types.Row;

import com.cdp.platform.shared.config.DatabaseConfig;

/**
 * PostgreSQL CDC access for the {@code campaigns} table. The columns live in
 * {@link CampaignsTable}.
 */
public final class CampaignRepository {

    private CampaignRepository() {
    }

    public static DataStream<Row> changelog(StreamTableEnvironment tables, DatabaseConfig database,
        String temporaryTableName, String slotName) {
        tables.createTemporaryTable(temporaryTableName, createCdcSourceDescriptor(database, slotName));
        return PostgresCdc.changelog(tables, temporaryTableName);
    }

    public static TableDescriptor createCdcSourceDescriptor(DatabaseConfig database, String slotName) {
        return PostgresCdc
            .source(database, CampaignsTable.TABLE_NAME, CampaignsTable.PUBLICATION_NAME, slotName,
                CampaignsTable.cdcSchema());
    }
}
