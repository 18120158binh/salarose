package com.cdp.platform.jobs.customerdecision;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import org.apache.flink.table.api.DataTypes;
import org.apache.flink.table.api.EnvironmentSettings;
import org.apache.flink.table.api.Table;
import org.apache.flink.table.api.TableEnvironment;
import org.apache.flink.types.Row;
import org.apache.flink.util.CloseableIterator;

import static org.apache.flink.table.api.Expressions.callSql;
import static org.apache.flink.table.api.Expressions.row;
import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

/**
 * Ingestion publishes a null {@code collector_timestamp} when the collector
 * time is unset. The event's time then comes from {@code event_timestamp}.
 */
class ParsedEventRowtimeTest {

    @Test
    void aNullCollectorTimestampFallsBackToTheEventTimestamp() throws Exception {
        TableEnvironment tables = TableEnvironment.create(EnvironmentSettings.inBatchMode());
        Table events = tables
            .fromValues(DataTypes
                .ROW(DataTypes.FIELD("collector_timestamp", DataTypes.BIGINT()),
                    DataTypes.FIELD("event_timestamp", DataTypes.BIGINT())),
                row(null, 900L), row(1000L, 900L));

        List<Instant> rowtimes = new ArrayList<>();
        try (CloseableIterator<Row> rows = events.select(callSql(CustomerDecisionJob.ROWTIME)).execute().collect()) {
            rows.forEachRemaining(result -> rowtimes.add(result.getFieldAs(0)));
        }

        assertEquals(List.of(Instant.ofEpochMilli(900), Instant.ofEpochMilli(1000)), rowtimes);
    }
}
