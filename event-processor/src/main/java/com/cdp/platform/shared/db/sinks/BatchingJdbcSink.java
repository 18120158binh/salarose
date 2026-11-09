package com.cdp.platform.shared.db.sinks;

import java.io.Serializable;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.Duration;
import java.util.List;
import java.util.function.BinaryOperator;

import org.apache.flink.api.connector.sink2.Sink;
import org.apache.flink.api.connector.sink2.SinkWriter;
import org.apache.flink.api.connector.sink2.WriterInitContext;
import org.apache.flink.connector.jdbc.JdbcConnectionOptions;
import org.apache.flink.connector.jdbc.JdbcExecutionOptions;
import org.apache.flink.connector.jdbc.JdbcStatementBuilder;
import org.apache.flink.connector.jdbc.datasource.connections.JdbcConnectionProvider;
import org.apache.flink.connector.jdbc.datasource.connections.SimpleJdbcConnectionProvider;
import org.apache.flink.util.function.SerializableFunction;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * At-least-once sink that writes each row with one SQL statement, in batches.
 * A row that the database rejects is logged by {@code rowName} and skipped
 * instead of failing the job. Every write must be idempotent, because Flink
 * replays rows after a restart.
 *
 * <p>
 * A sink built with a key merges the buffered rows that share a key into one
 * row before each batch. The merge must give the row whose write has the same
 * result as writing the earlier row and then the later one.
 */
public final class BatchingJdbcSink<T> implements Sink<T> {

    private static final Duration RETRY_BACKOFF = Duration.ofSeconds(1);

    private final String sql;
    private final JdbcStatementBuilder<T> binder;
    private final JdbcExecutionOptions executionOptions;
    private final JdbcConnectionOptions connectionOptions;
    private final SerializableFunction<T, String> rowName;
    private final SerializableFunction<T, ?> key;
    private final Merge<T> merge;

    /** Merges two rows with the same key, given in arrival order. */
    @FunctionalInterface
    public interface Merge<T> extends BinaryOperator<T>, Serializable {
    }

    /** Writes every row as it is. */
    public BatchingJdbcSink(String sql, JdbcStatementBuilder<T> binder, JdbcExecutionOptions executionOptions,
        JdbcConnectionOptions connectionOptions, SerializableFunction<T, String> rowName) {
        this(sql, binder, executionOptions, connectionOptions, rowName, null, null);
    }

    /** Writes one row per key in each batch, merged in arrival order. */
    public BatchingJdbcSink(String sql, JdbcStatementBuilder<T> binder, JdbcExecutionOptions executionOptions,
        JdbcConnectionOptions connectionOptions, SerializableFunction<T, String> rowName,
        SerializableFunction<T, ?> key, Merge<T> merge) {
        this.sql = sql;
        this.binder = binder;
        this.executionOptions = executionOptions;
        this.connectionOptions = connectionOptions;
        this.rowName = rowName;
        this.key = key;
        this.merge = merge;
    }

    @Override
    public SinkWriter<T> createWriter(WriterInitContext context) {
        JdbcStatements<T> statements = new JdbcStatements<>(new SimpleJdbcConnectionProvider(connectionOptions),
            sql, binder);
        return new BatchingJdbcWriter<>(statements, executionOptions, context.getProcessingTimeService(),
            RETRY_BACKOFF, rowName, context.metricGroup().counter("numRowsSkipped"), key, merge);
    }

    /** Runs the statement on one connection, with one transaction per write. */
    private static final class JdbcStatements<T> implements BatchingJdbcWriter.Statements<T> {

        private static final Logger LOG = LoggerFactory.getLogger(JdbcStatements.class);

        private final JdbcConnectionProvider connections;
        private final String sql;
        private final JdbcStatementBuilder<T> binder;
        private PreparedStatement statement;

        JdbcStatements(JdbcConnectionProvider connections, String sql, JdbcStatementBuilder<T> binder) {
            this.connections = connections;
            this.sql = sql;
            this.binder = binder;
        }

        @Override
        public void writeBatch(List<T> rows) throws SQLException {
            PreparedStatement prepared = prepare();
            try {
                prepared.clearBatch();
                for (T row : rows) {
                    binder.accept(prepared, row);
                    prepared.addBatch();
                }
                prepared.executeBatch();
                prepared.getConnection().commit();
            } catch (SQLException exception) {
                rollback(prepared.getConnection(), exception);
                throw exception;
            }
        }

        @Override
        public void writeRow(T row) throws SQLException {
            PreparedStatement prepared = prepare();
            try {
                binder.accept(prepared, row);
                prepared.executeUpdate();
                prepared.getConnection().commit();
            } catch (SQLException exception) {
                rollback(prepared.getConnection(), exception);
                throw exception;
            }
        }

        @Override
        public void reconnect() throws SQLException {
            closeStatement();
            if (!connections.isConnectionValid()) connections.closeConnection();
        }

        @Override
        public void close() {
            closeStatement();
            connections.closeConnection();
        }

        private PreparedStatement prepare() throws SQLException {
            if (statement != null) return statement;
            try {
                Connection connection = connections.getOrEstablishConnection();
                connection.setAutoCommit(false);
                statement = connection.prepareStatement(sql);
                return statement;
            } catch (ClassNotFoundException exception) {
                throw new SQLException("JDBC driver not found", exception);
            }
        }

        private static void rollback(Connection connection, SQLException cause) {
            try {
                connection.rollback();
            } catch (SQLException exception) {
                cause.addSuppressed(exception);
            }
        }

        private void closeStatement() {
            if (statement == null) return;
            try {
                statement.close();
            } catch (SQLException exception) {
                LOG.debug("Closing the prepared statement failed: {}", exception.getMessage());
            }
            statement = null;
        }
    }
}
