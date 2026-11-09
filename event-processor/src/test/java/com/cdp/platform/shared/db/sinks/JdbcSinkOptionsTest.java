package com.cdp.platform.shared.db.sinks;

import java.time.Duration;

import org.apache.flink.connector.jdbc.JdbcConnectionOptions;
import org.apache.flink.connector.jdbc.JdbcExecutionOptions;

import com.cdp.platform.shared.config.DatabaseConfig;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class JdbcSinkOptionsTest {

    @Test
    void aSinkWritesBatchesOfAHundredRowsEveryHalfSecondAndRetriesThreeTimes() {
        JdbcExecutionOptions batches = JdbcSinkOptions.batches();

        assertEquals(100, batches.getBatchSize());
        assertEquals(500, batches.getBatchIntervalMs());
        assertEquals(3, batches.getMaxRetries());
    }

    @Test
    void aSinkWithItsOwnBatchSettingsStillRetriesThreeTimes() {
        JdbcExecutionOptions batches = JdbcSinkOptions.batches(200, Duration.ofMillis(200));

        assertEquals(200, batches.getBatchSize());
        assertEquals(200, batches.getBatchIntervalMs());
        assertEquals(3, batches.getMaxRetries());
    }

    @Test
    void aSinkConnectsToTheJobsPrimaryDatabase() {
        JdbcConnectionOptions connection = JdbcSinkOptions
            .connection(new DatabaseConfig("db.internal", "5432", "flink", "secret", "cdp",
                "jdbc:postgresql://db.internal:5432/cdp?reWriteBatchedInserts=true",
                "jdbc:postgresql://replica.internal:5432/cdp?reWriteBatchedInserts=true", 10));

        assertEquals("jdbc:postgresql://db.internal:5432/cdp?reWriteBatchedInserts=true", connection.getDbURL());
        assertEquals("org.postgresql.Driver", connection.getDriverName());
        assertEquals("flink", connection.getUsername().orElseThrow());
        assertEquals("secret", connection.getPassword().orElseThrow());
    }
}
