package com.cdp.platform.shared.db.sinks;

import java.io.IOException;
import java.sql.BatchUpdateException;
import java.sql.SQLException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ScheduledFuture;
import java.util.function.BinaryOperator;
import java.util.function.Function;

import org.apache.flink.api.common.operators.ProcessingTimeService;
import org.apache.flink.connector.jdbc.JdbcExecutionOptions;
import org.apache.flink.metrics.SimpleCounter;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

class BatchingJdbcWriterTest {

    private static final String FOREIGN_KEY_VIOLATION = "23503";
    private static final String CHECK_VIOLATION = "23514";
    private static final String INVALID_TEXT_REPRESENTATION = "22P02";
    private static final String CONNECTION_FAILURE = "08006";
    private static final String DEADLOCK_DETECTED = "40P01";

    private final FakeDatabase database = new FakeDatabase();
    private final FakeTimers timers = new FakeTimers();
    private final SimpleCounter skippedRows = new SimpleCounter();

    /**
     * Rows are named like "a1", and rows that share a first letter write the same
     * database row.
     */
    private static final Function<String, Object> SAME_LETTER = row -> row.charAt(0);
    private static final BinaryOperator<String> KEEP_LATER = (earlier, later) -> later;

    private BatchingJdbcWriter<String> writer(int batchSize) {
        return writer(batchSize, null, null);
    }

    private BatchingJdbcWriter<String> writer(int batchSize, Function<String, Object> key,
        BinaryOperator<String> merge) {
        JdbcExecutionOptions options = JdbcExecutionOptions
            .builder()
            .withBatchSize(batchSize)
            .withBatchIntervalMs(500)
            .withMaxRetries(3)
            .build();
        return new BatchingJdbcWriter<>(database, options, timers, Duration.ZERO, row -> row, skippedRows, key,
            merge);
    }

    private void writeAndFlush(String... rows) throws Exception {
        BatchingJdbcWriter<String> writer = writer(100);
        for (String row : rows) {
            writer.write(row, null);
        }
        writer.flush(false);
    }

    private void writeAndFlushMerging(BinaryOperator<String> merge, String... rows) throws Exception {
        BatchingJdbcWriter<String> writer = writer(100, SAME_LETTER, merge);
        for (String row : rows) {
            writer.write(row, null);
        }
        writer.flush(false);
    }

    @Test
    void twoRowsForOneKeyReachTheBatchAsTheLaterOne() throws Exception {
        writeAndFlushMerging(KEEP_LATER, "a1", "b1", "a2");

        assertEquals(List.of(List.of("a2", "b1")), database.batches);
    }

    @Test
    void rowsForOneKeyAreMergedInArrivalOrder() throws Exception {
        writeAndFlushMerging((earlier, later) -> earlier + "+" + later, "a1", "a2", "a3");

        assertEquals(List.of(List.of("a1+a2+a3")), database.batches);
    }

    @Test
    void withoutAKeyBothRowsForOneDatabaseRowAreWritten() throws Exception {
        writeAndFlush("a1", "a2");

        assertEquals(List.of(List.of("a1", "a2")), database.batches);
    }

    @Test
    void rowByRowFallbackWritesTheMergedRowsAndSkipsEachRejectedRowOnce() throws Exception {
        database.failEveryTime("b1", FOREIGN_KEY_VIOLATION);
        database.failOnce("c1", CONNECTION_FAILURE);

        writeAndFlushMerging(KEEP_LATER, "a1", "b1", "a2", "c1");

        assertEquals(List.of("a2", "c1"), database.storedRows());
        assertEquals(List.of("a2", "b1", "c1"), database.singleRows);
        assertEquals(List.of(List.of("a2", "b1", "c1"), List.of("c1")), database.batches);
        assertEquals(1, skippedRows.getCount());
    }

    @Test
    void rowsAreWrittenOnFlush() throws Exception {
        writeAndFlush("a", "b");

        assertEquals(List.of("a", "b"), database.storedRows());
    }

    @Test
    void rowWithUnknownForeignKeyIsSkippedAndTheOthersAreWritten() throws Exception {
        database.failEveryTime("b", FOREIGN_KEY_VIOLATION);

        writeAndFlush("a", "b", "c");

        assertEquals(List.of("a", "c"), database.storedRows());
    }

    @Test
    void rowThatFailsACheckConstraintIsSkipped() throws Exception {
        database.failEveryTime("a", CHECK_VIOLATION);

        writeAndFlush("a", "b");

        assertEquals(List.of("b"), database.storedRows());
    }

    @Test
    void rowWithADataExceptionIsSkipped() throws Exception {
        database.failEveryTime("b", INVALID_TEXT_REPRESENTATION);

        writeAndFlush("a", "b");

        assertEquals(List.of("a"), database.storedRows());
    }

    @Test
    void eachSkippedRowIsCounted() throws Exception {
        database.failEveryTime("a", FOREIGN_KEY_VIOLATION);
        database.failEveryTime("c", CHECK_VIOLATION);

        writeAndFlush("a", "b", "c");

        assertEquals(2, skippedRows.getCount());
    }

    @Test
    void writtenRowsAreNotCounted() throws Exception {
        writeAndFlush("a", "b");

        assertEquals(0, skippedRows.getCount());
    }

    @Test
    void brokenConnectionIsReconnectedAndLosesNoRow() throws Exception {
        database.breakConnection();

        writeAndFlush("a", "b");

        assertEquals(1, database.reconnects);
        assertEquals(List.of("a", "b"), database.storedRows());
    }

    @Test
    void connectionFailureWhileWritingRowByRowIsRetriedNotSkipped() throws Exception {
        database.failEveryTime("b", FOREIGN_KEY_VIOLATION);
        database.failOnce("c", CONNECTION_FAILURE);

        writeAndFlush("a", "b", "c");

        assertEquals(List.of("a", "c"), database.storedRows());
        assertEquals(1, database.reconnects);
        assertEquals(1, skippedRows.getCount());
    }

    @Test
    void connectionThatStaysDownFailsTheFlushAfterThreeRetries() throws Exception {
        database.failEveryTime("a", CONNECTION_FAILURE);
        BatchingJdbcWriter<String> writer = writer(100);
        writer.write("a", null);
        writer.write("b", null);

        IOException failure = assertThrows(IOException.class, () -> writer.flush(false));

        assertEquals(CONNECTION_FAILURE, ((SQLException) failure.getCause()).getSQLState());
        assertEquals(4, database.batchAttempts);
        assertEquals(List.of(), database.storedRows());
    }

    @Test
    void errorThatIsNotAboutTheRowFailsTheFlush() throws Exception {
        database.failEveryTime("a", DEADLOCK_DETECTED);
        BatchingJdbcWriter<String> writer = writer(100);
        writer.write("a", null);

        IOException failure = assertThrows(IOException.class, () -> writer.flush(false));

        assertEquals(DEADLOCK_DETECTED, ((SQLException) failure.getCause()).getSQLState());
    }

    @Test
    void fullBatchIsWrittenWithoutWaitingForAFlush() throws Exception {
        BatchingJdbcWriter<String> writer = writer(2);

        writer.write("a", null);
        writer.write("b", null);

        assertEquals(List.of("a", "b"), database.storedRows());
    }

    @Test
    void partialBatchIsWrittenWhenTheBatchIntervalEnds() throws Exception {
        BatchingJdbcWriter<String> writer = writer(100);
        writer.write("a", null);

        timers.fireAll();

        assertEquals(List.of("a"), database.storedRows());
    }

    /**
     * A table with an upsert on the row. A batch is one transaction. A row set to
     * fail every time fails each write that holds it. A row set to fail once fails
     * only the next one. A broken connection fails every write until a reconnect.
     */
    private static final class FakeDatabase implements BatchingJdbcWriter.Statements<String> {

        private final Map<String, String> alwaysFailing = new HashMap<>();
        private final Map<String, String> failingOnce = new HashMap<>();
        private final Set<String> table = new LinkedHashSet<>();
        private boolean connectionBroken;
        private final List<List<String>> batches = new ArrayList<>();
        private final List<String> singleRows = new ArrayList<>();
        private int batchAttempts;
        private int reconnects;

        void failEveryTime(String row, String sqlState) {
            alwaysFailing.put(row, sqlState);
        }

        void failOnce(String row, String sqlState) {
            failingOnce.put(row, sqlState);
        }

        void breakConnection() {
            connectionBroken = true;
        }

        List<String> storedRows() {
            return List.copyOf(table);
        }

        @Override
        public void writeBatch(List<String> rows) throws SQLException {
            batchAttempts++;
            batches.add(List.copyOf(rows));
            if (connectionBroken) throw new BatchUpdateException("Connection lost", CONNECTION_FAILURE, new int[0]);
            for (String row : rows) {
                String sqlState = failure(row);
                if (sqlState != null)
                    throw new BatchUpdateException("Batch entry " + row + " was aborted", sqlState, new int[0]);
            }
            table.addAll(rows);
        }

        @Override
        public void writeRow(String row) throws SQLException {
            singleRows.add(row);
            if (connectionBroken) throw new SQLException("Connection lost", CONNECTION_FAILURE);
            String sqlState = failure(row);
            if (sqlState != null) throw new SQLException("Row " + row + " failed", sqlState);
            table.add(row);
        }

        private String failure(String row) {
            String once = failingOnce.remove(row);
            return once != null ? once : alwaysFailing.get(row);
        }

        @Override
        public void reconnect() {
            reconnects++;
            connectionBroken = false;
        }

        @Override
        public void close() {
        }
    }

    private static final class FakeTimers implements ProcessingTimeService {

        private final List<ProcessingTimeCallback> callbacks = new ArrayList<>();
        @Override
        public long getCurrentProcessingTime() {
            return 0;
        }

        @Override
        public ScheduledFuture<?> registerTimer(long timestamp, ProcessingTimeCallback target) {
            callbacks.add(target);
            return null;
        }

        void fireAll() throws Exception {
            for (ProcessingTimeCallback callback : List.copyOf(callbacks)) {
                callback.onProcessingTime(500);
            }
            callbacks.clear();
        }
    }
}
