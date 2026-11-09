package com.cdp.platform.shared.db.sinks;

import java.io.IOException;
import java.sql.SQLException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BinaryOperator;
import java.util.function.Function;

import org.apache.flink.api.common.operators.ProcessingTimeService;
import org.apache.flink.api.connector.sink2.SinkWriter;
import org.apache.flink.connector.jdbc.JdbcExecutionOptions;
import org.apache.flink.metrics.Counter;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Buffers rows and writes them in batches. Flink flushes the buffer on every
 * checkpoint, so delivery is at least once. With a key, the rows that write
 * the same database row are merged into one before each batch: Postgres rejects
 * a multi-row upsert that touches one row twice. When a batch fails, the writer
 * writes its rows one at a time and skips each row that the database rejects
 * for its data. Any other error is retried, and then fails the flush.
 */
final class BatchingJdbcWriter<T> implements SinkWriter<T> {

    private static final Logger LOG = LoggerFactory.getLogger(BatchingJdbcWriter.class);

    /** The database side of the writer. */
    interface Statements<T> extends AutoCloseable {

        /** Writes all rows in one transaction, or none of them. */
        void writeBatch(List<T> rows) throws SQLException;

        /** Writes one row in its own transaction. */
        void writeRow(T row) throws SQLException;

        /**
         * Drops the current connection if it is broken, so the next write opens a new
         * one.
         */
        void reconnect() throws SQLException;

        @Override
        void close();
    }

    private final Statements<T> statements;
    private final JdbcExecutionOptions options;
    private final ProcessingTimeService timers;
    private final Duration retryBackoff;
    private final Function<T, String> rowName;
    private final Counter skippedRows;
    /**
     * The database row that a row writes, or null when each row is written as it
     * is.
     */
    private final Function<T, ?> key;
    private final BinaryOperator<T> merge;
    private final List<T> buffer = new ArrayList<>();

    BatchingJdbcWriter(Statements<T> statements, JdbcExecutionOptions options, ProcessingTimeService timers,
        Duration retryBackoff, Function<T, String> rowName, Counter skippedRows, Function<T, ?> key,
        BinaryOperator<T> merge) {
        this.statements = statements;
        this.options = options;
        this.timers = timers;
        this.retryBackoff = retryBackoff;
        this.rowName = rowName;
        this.skippedRows = skippedRows;
        this.key = key;
        this.merge = merge;
    }

    @Override
    public void write(T row, Context context) throws IOException, InterruptedException {
        buffer.add(row);
        if (buffer.size() >= options.getBatchSize()) {
            flush(false);
        } else if (buffer.size() == 1 && options.getBatchIntervalMs() > 0) {
            timers
                .registerTimer(timers.getCurrentProcessingTime() + options.getBatchIntervalMs(),
                    time -> flush(false));
        }
    }

    @Override
    public void flush(boolean endOfInput) throws IOException, InterruptedException {
        if (buffer.isEmpty()) return;
        mergeRowsWithTheSameKey();

        for (int attempt = 0;; attempt++) {
            try {
                write(buffer);
                buffer.clear();
                return;
            } catch (SQLException exception) {
                if (attempt >= options.getMaxRetries()) {
                    throw new IOException("Writing a batch of " + buffer.size() + " rows failed after "
                        + attempt + " retries", exception);
                }
                LOG
                    .warn("Writing a batch of {} rows failed, retry {} of {}: SQLState {}, {}", buffer.size(),
                        attempt + 1, options.getMaxRetries(), exception.getSQLState(),
                        exception.getClass().getSimpleName());
                reconnect(exception);
                Thread.sleep(retryBackoff.toMillis() * (attempt + 1));
            }
        }
    }

    /**
     * Replaces the buffer with one row per key, merged in arrival order. The
     * stream is keyed, so one subtask sees every row of a key in order.
     */
    private void mergeRowsWithTheSameKey() {
        if (key == null) return;
        Map<Object, T> merged = new LinkedHashMap<>();
        for (T row : buffer) {
            merged.merge(key.apply(row), row, merge);
        }
        buffer.clear();
        buffer.addAll(merged.values());
    }

    private void write(List<T> rows) throws SQLException {
        try {
            statements.writeBatch(rows);
        } catch (SQLException exception) {
            LOG
                .warn("Writing a batch of {} rows failed, writing them one at a time: SQLState {}, {}", rows.size(),
                    exception.getSQLState(), exception.getClass().getSimpleName());
            // Drop each row once it is written or skipped, so a retry starts after it
            // and counts no skipped row twice.
            for (Iterator<T> pending = rows.iterator(); pending.hasNext();) {
                writeOrSkip(pending.next());
                pending.remove();
            }
        }
    }

    private void writeOrSkip(T row) throws SQLException {
        try {
            statements.writeRow(row);
        } catch (SQLException exception) {
            if (!isRejectedRow(exception)) throw exception;
            skippedRows.inc();
            LOG
                .warn("Skipping row {} that the database rejected: SQLState {}, {}: {}", rowName.apply(row),
                    exception.getSQLState(), exception.getClass().getSimpleName(), withoutRowData(exception));
        }
    }

    /**
     * The first line of the database's message, which names the constraint or the
     * type. Postgres adds the row's values after it ("Detail: Failing row contains
     * ..."), which can be large and hold personal data.
     */
    private static String withoutRowData(SQLException exception) {
        String message = String.valueOf(exception.getMessage());
        int end = message.length();
        for (String marker : List.of("\n", "Detail:", "Failing row")) {
            int index = message.indexOf(marker);
            if (index >= 0) end = Math.min(end, index);
        }
        return message.substring(0, end).strip();
    }

    /**
     * SQLState class 22 is a data exception and class 23 an integrity constraint
     * violation. Both depend only on the row, so writing it again fails again.
     */
    private static boolean isRejectedRow(SQLException exception) {
        String sqlState = exception.getSQLState();
        return sqlState != null && (sqlState.startsWith("22") || sqlState.startsWith("23"));
    }

    private void reconnect(SQLException cause) throws IOException {
        try {
            statements.reconnect();
        } catch (SQLException exception) {
            exception.addSuppressed(cause);
            throw new IOException("Reconnecting to the database failed", exception);
        }
    }

    @Override
    public void close() {
        statements.close();
    }
}
