package com.cdp.platform.shared.db.repositories;

import org.apache.flink.api.dag.Transformation;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.table.api.Schema;
import org.apache.flink.table.api.TableDescriptor;
import org.apache.flink.table.api.bridge.java.StreamTableEnvironment;
import org.apache.flink.types.Row;

import com.cdp.platform.shared.config.DatabaseConfig;

/** The Postgres CDC source that every job reads a table through. */
public final class PostgresCdc {

    private static final String SCHEMA_NAME = "public";
    private static final String HEARTBEAT_INTERVAL_MS = "30000";

    private PostgresCdc() {
    }

    /**
     * A source on one table of the {@code public} schema, read through the
     * table's publication and the job's own replication slot.
     */
    public static TableDescriptor source(DatabaseConfig database, String tableName, String publicationName,
        String slotName, Schema schema) {
        return TableDescriptor
            .forConnector("postgres-cdc")
            .schema(schema)
            .option("hostname", database.host())
            .option("port", database.port())
            .option("username", database.user())
            .option("password", database.password())
            .option("database-name", database.database())
            .option("schema-name", SCHEMA_NAME)
            .option("table-name", tableName)
            .option("decoding.plugin.name", "pgoutput")
            .option("slot.name", slotName)
            // Only the incremental snapshot source delays the position it confirms.
            .option("scan.incremental.snapshot.enabled", "true")
            // A restore must find in the slot every change after its checkpoint or
            // savepoint.
            // The source confirms the position of the checkpoint this many completed
            // checkpoints back, so the slot keeps the changes after each of the last ones.
            .option("scan.lsn-commit.checkpoints-num-delay",
                Integer.toString(database.cdcConfirmDelayCheckpoints()))
            .option("debezium.publication.name", publicationName)
            .option("debezium.slot.failover", "true")
            // Keep the slot when the job stops. A restore resumes from the log position in
            // the checkpoint, and only the slot holds the changes made after it.
            .option("debezium.slot.drop.on.stop", "false")
            .option("debezium.heartbeat.interval.ms", HEARTBEAT_INTERVAL_MS)
            .option("debezium.heartbeat.action.query", CdcHeartbeatTable.beatQuery(slotName))
            .build();
    }

    /**
     * The changes to a table registered with {@link #source}, in log order. The
     * source and every operator the planner adds after it run on one subtask, so
     * a change cannot overtake an earlier one on another channel. Operators that
     * the caller adds before a broadcast or a key must run on one subtask too.
     */
    public static DataStream<Row> changelog(StreamTableEnvironment tables, String temporaryTableName) {
        DataStream<Row> changes = tables.toChangelogStream(tables.from(temporaryTableName));
        Transformation<?> operator = changes.getTransformation();
        operator.setParallelism(1);
        while (!operator.getInputs().isEmpty()) {
            operator = operator.getInputs().getFirst();
            operator.setParallelism(1);
        }
        return changes;
    }
}
