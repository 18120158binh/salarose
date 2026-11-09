package com.cdp.platform.shared.db.repositories;

import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.table.api.TableDescriptor;
import org.apache.flink.table.api.bridge.java.StreamTableEnvironment;
import org.apache.flink.types.Row;

import com.cdp.platform.shared.config.DatabaseConfig;

/**
 * PostgreSQL CDC access for campaign journey nodes. The columns live in
 * {@link CampaignNodesTable}.
 */
public final class CampaignNodeRepository {

    private CampaignNodeRepository() {
    }

    public static DataStream<Row> changelog(StreamTableEnvironment tableEnvironment, DatabaseConfig database,
        String temporaryTableName, String slotName) {
        registerCdcSourceTable(tableEnvironment, database, temporaryTableName, slotName);
        return PostgresCdc.changelog(tableEnvironment, temporaryTableName);
    }

    /**
     * The node rows with the number of nodes in the save that wrote each one,
     * which the state machine needs to apply a save as one change. Customer
     * decision reads the rows without it.
     */
    public static DataStream<Row> graphChangelog(StreamTableEnvironment tableEnvironment, DatabaseConfig database,
        String temporaryTableName, String slotName) {
        tableEnvironment
            .createTemporaryTable(temporaryTableName, PostgresCdc
                .source(database, CampaignNodesTable.TABLE_NAME, CampaignNodesTable.PUBLICATION_NAME, slotName,
                    CampaignNodesTable.graphCdcSchema()));
        return PostgresCdc.changelog(tableEnvironment, temporaryTableName);
    }

    public static void registerCdcSourceTable(StreamTableEnvironment tableEnvironment, DatabaseConfig database,
        String temporaryTableName, String slotName) {
        tableEnvironment.createTemporaryTable(temporaryTableName, createCdcSourceDescriptor(database, slotName));
    }

    public static TableDescriptor createCdcSourceDescriptor(DatabaseConfig database, String slotName) {
        return PostgresCdc
            .source(database, CampaignNodesTable.TABLE_NAME, CampaignNodesTable.PUBLICATION_NAME, slotName,
                CampaignNodesTable.cdcSchema());
    }
}
