package com.cdp.platform.shared.db.sinks;

import java.time.Duration;

import org.apache.flink.connector.jdbc.JdbcConnectionOptions;
import org.apache.flink.connector.jdbc.JdbcExecutionOptions;

import com.cdp.platform.shared.config.DatabaseConfig;

/** The batching and connection options of the JDBC sinks. */
public final class JdbcSinkOptions {

    private JdbcSinkOptions() {
    }

    /** Up to 100 rows per batch, written at least every 500 ms, with 3 retries. */
    public static JdbcExecutionOptions batches() {
        return batches(100, Duration.ofMillis(500));
    }

    /**
     * Up to {@code size} rows per batch, written at least every {@code interval},
     * with 3 retries.
     */
    public static JdbcExecutionOptions batches(int size, Duration interval) {
        return JdbcExecutionOptions
            .builder()
            .withBatchSize(size)
            .withBatchIntervalMs(interval.toMillis())
            .withMaxRetries(3)
            .build();
    }

    /** A connection to the job's primary database. */
    public static JdbcConnectionOptions connection(DatabaseConfig database) {
        return new JdbcConnectionOptions.JdbcConnectionOptionsBuilder()
            .withUrl(database.jdbcUrl())
            .withDriverName("org.postgresql.Driver")
            .withUsername(database.user())
            .withPassword(database.password())
            .build();
    }
}
