package com.cdp.platform.shared.db.repositories;

import java.sql.Connection;
import java.sql.SQLException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.connector.jdbc.JdbcExecutionOptions;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.util.TimeUtils;

import com.cdp.platform.shared.config.DatabaseConfig;
import com.cdp.platform.shared.config.EnvironmentSettings;
import com.cdp.platform.shared.db.sinks.BatchingJdbcSink;
import com.cdp.platform.shared.db.sinks.JdbcSinkOptions;
import com.cdp.platform.shared.models.db.IdentityGraph;
import com.cdp.platform.shared.utils.JdbcUtil;

import com.zaxxer.hikari.HikariDataSource;
import org.jooq.Record;
import org.jooq.SQLDialect;
import org.jooq.conf.ParamType;
import org.jooq.exception.DataAccessException;
import org.jooq.impl.DSL;

/**
 * Repository dedicated to identity graph lookups and materialization.
 * Extends {@link AbstractDatabaseRepository} for connection pooling and query
 * execution.
 */
public final class IdentityGraphRepository extends AbstractDatabaseRepository {

    private static final String LOOKUP_CONCURRENCY_VARIABLE = "IDENTITY_LOOKUP_CONCURRENCY";
    private static final int DEFAULT_LOOKUP_CONCURRENCY = 4;
    // Each subtask holds this many primary connections, so a typo must not open
    // hundreds.
    private static final int MAX_LOOKUP_CONCURRENCY = 32;
    /** The most rows of one user that a lookup reads. */
    public static final int USER_ROW_LIMIT = 10;

    IdentityGraphRepository(HikariDataSource dataSource) {
        super(dataSource);
    }

    /**
     * Reads the primary that {@link #attach} writes, because a lagging replica
     * would hide rows the sink has written. A lookup waits at most
     * {@code IDENTITY_LOOKUP_TIMEOUT} for a connection, and again for the read.
     * The pool holds {@code IDENTITY_LOOKUP_CONCURRENCY} connections.
     */
    public static IdentityGraphRepository open(DatabaseConfig database) {
        Duration lookupTimeout = TimeUtils
            .parseDuration(System.getenv().getOrDefault("IDENTITY_LOOKUP_TIMEOUT", "1s"));
        int concurrency = lookupConcurrency(EnvironmentSettings.system());
        return new IdentityGraphRepository(JdbcUtil
            .createDataSource(database.jdbcUrl(), database.user(), database.password(), concurrency,
                lookupTimeout));
    }

    /**
     * {@code IDENTITY_LOOKUP_CONCURRENCY}: a whole number from 1 to
     * {@link #MAX_LOOKUP_CONCURRENCY}, 4 when unset or blank. Any other value
     * stops the job at startup with the variable's name.
     */
    static int lookupConcurrency(EnvironmentSettings settings) {
        int concurrency = settings.positiveInt(LOOKUP_CONCURRENCY_VARIABLE, DEFAULT_LOOKUP_CONCURRENCY);
        if (concurrency > MAX_LOOKUP_CONCURRENCY)
            throw new IllegalArgumentException(LOOKUP_CONCURRENCY_VARIABLE + " must be at most "
                + MAX_LOOKUP_CONCURRENCY + ", but is " + concurrency);
        return concurrency;
    }

    /** How many lookups can run at once, one per pooled connection. */
    public int lookupConcurrency() {
        return dataSource.getMaximumPoolSize();
    }

    /**
     * Upserts one row per device. The stream is keyed by {@code domain_userid}, so
     * one subtask writes each row. A batch holds one row per device, because
     * Postgres rejects a multi-row upsert that touches one row twice.
     */
    public static void attach(DataStream<IdentityGraph> mappings, DatabaseConfig database,
        JdbcExecutionOptions batches) {
        mappings
            .keyBy(IdentityGraph::domainUserid, Types.STRING)
            .sinkTo(new BatchingJdbcSink<>(IdentityGraphTable.upsertQuery().getSQL(ParamType.INDEXED),
                IdentityGraphTable::bind, batches, JdbcSinkOptions.connection(database),
                mapping -> "domainUserid=" + mapping.domainUserid(), IdentityGraph::domainUserid,
                IdentityGraphRepository::mergeInOrder))
            .name("Postgres Identity Graph Sink")
            .uid("postgres-identity-graph-sink");
    }

    /**
     * The device's row and the newest rows of the user, read in one query. A read
     * that fails or runs past the lookup timeout throws, so that the caller does
     * not take it for "no row".
     */
    public StoredRows findRows(String domainUserId, String userId) throws SQLException {
        try (Connection connection = dataSource.getConnection()) {
            // The pool resets the timeout when the connection returns to it.
            connection.setNetworkTimeout(Runnable::run, (int) dataSource.getConnectionTimeout());
            Optional<IdentityGraph> deviceRow = Optional.empty();
            List<IdentityGraph> userRows = new ArrayList<>();
            for (Record record : DSL
                .using(connection, SQLDialect.POSTGRES)
                .fetch(IdentityGraphTable.lookupQuery(domainUserId, userId))) {
                if (IdentityGraphTable.isDeviceRow(record)) deviceRow = Optional.of(IdentityGraphTable.mapping(record));
                else userRows.add(IdentityGraphTable.mapping(record));
            }
            return new StoredRows(deviceRow, userRows);
        } catch (DataAccessException exception) {
            throw new SQLException(exception.getMessage(), exception);
        }
    }

    /**
     * The rows that resolve an event: the device's own row, and up to
     * {@link #USER_ROW_LIMIT} rows of the user, newest first.
     *
     * @param userRows
     *            the rows of the event's {@code user_id}, or of the user on the
     *            device's row when the event has none
     */
    public record StoredRows(Optional<IdentityGraph> deviceRow, List<IdentityGraph> userRows) {

        public StoredRows {
            userRows = List.copyOf(userRows);
        }
    }

    /**
     * The row whose upsert has the same result as upserting {@code earlier} and
     * then {@code later}: the later {@code canon_id}, and the latest non-null
     * {@code user_id}.
     */
    static IdentityGraph mergeInOrder(IdentityGraph earlier, IdentityGraph later) {
        if (later.userId() != null) return later;
        return new IdentityGraph(later.domainUserid(), earlier.userId(), later.canonId());
    }
}
