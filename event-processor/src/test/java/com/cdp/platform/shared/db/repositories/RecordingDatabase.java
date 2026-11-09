package com.cdp.platform.shared.db.repositories;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicInteger;

import com.cdp.platform.shared.models.db.UserMetric;

import com.zaxxer.hikari.HikariDataSource;
import org.jooq.DSLContext;
import org.jooq.Field;
import org.jooq.JSONB;
import org.jooq.Record;
import org.jooq.Result;
import org.jooq.SQLDialect;
import org.jooq.impl.DSL;
import org.jooq.tools.jdbc.MockConnection;
import org.jooq.tools.jdbc.MockExecuteContext;
import org.jooq.tools.jdbc.MockResult;

/**
 * A {@code user_metrics} table held in memory that counts the reads made of
 * it. Each read takes one connection.
 */
public final class RecordingDatabase extends HikariDataSource {

    private static final DSLContext SQL = DSL.using(SQLDialect.POSTGRES);
    // In the order of the repository's select.
    private static final List<Field<?>> ROW = List
        .of(UserMetricsTable.CANON_ID, UserMetricsTable.METRIC_ID, UserMetricsTable.SERIES_CLOCK,
            UserMetricsTable.BUCKETS, UserMetricsTable.LAST_BEHAVIOR_VERSION);

    private final List<UserMetric> rows;
    private final AtomicInteger reads = new AtomicInteger();
    private final List<String> seriesRead = new CopyOnWriteArrayList<>();
    private volatile CountDownLatch gate = new CountDownLatch(0);

    private volatile boolean down;

    public RecordingDatabase(UserMetric... rows) {
        this(List.of(rows));
    }

    /** A table that holds whatever the list holds when a read runs. */
    public RecordingDatabase(List<UserMetric> rows) {
        this.rows = rows;
    }

    /** Fails every read from now on, as when Postgres is unreachable. */
    public void goDown() {
        down = true;
    }

    /** A repository on this table. */
    public UserMetricRepository userMetrics() {
        return new UserMetricRepository(this);
    }

    /** The metric ids of every series read, in order. */
    public List<String> seriesRead() {
        return List.copyOf(seriesRead);
    }

    /** How many reads were made. */
    public int reads() {
        return reads.get();
    }

    /**
     * Holds every read from now on until the returned action runs, as when
     * Postgres is slow.
     */
    public Runnable holdReads() {
        CountDownLatch held = new CountDownLatch(1);
        gate = held;
        return held::countDown;
    }

    @Override
    public Connection getConnection() throws SQLException {
        reads.incrementAndGet();
        if (down) throw new SQLException("user_metrics is unreachable");
        try {
            gate.await();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new SQLException("Interrupted while the read was held", interrupted);
        }
        return new MockConnection(this::execute) {

            @Override
            public void setNetworkTimeout(Executor executor, int milliseconds) {
            }
        };
    }

    private MockResult[] execute(MockExecuteContext context) {
        Object[] bindings = context.bindings();
        if (context.sql().contains("max(")) {
            // The default of coalesce comes before the canon id.
            String canonId = (String) bindings[bindings.length - 1];
            Field<Long> last = DSL.field("max", Long.class);
            Result<Record> result = SQL.newResult(List.of(last));
            Record record = SQL.newRecord(List.of(last));
            record
                .set(last, rows
                    .stream()
                    .filter(row -> row.canonId().equals(canonId))
                    .mapToLong(UserMetric::lastBehaviorVersion)
                    .max()
                    .orElse(0L));
            result.add(record);
            return new MockResult[] {new MockResult(1, result)};
        }
        String canonId = (String) bindings[0];
        Set<Object> metricIds = Set.copyOf(Arrays.asList(bindings).subList(1, bindings.length));
        metricIds.forEach(metricId -> seriesRead.add((String) metricId));
        Result<Record> result = SQL.newResult(ROW);
        rows
            .stream()
            .filter(row -> row.canonId().equals(canonId) && metricIds.contains(row.metricId()))
            .forEach(row -> result.add(record(row)));
        return new MockResult[] {new MockResult(result.size(), result)};
    }

    private static Record record(UserMetric row) {
        Record record = SQL.newRecord(ROW);
        record
            .fromArray(row.canonId(), row.metricId(), row.seriesClock(),
                JSONB.valueOf(UserMetricsTable.bucketsJson(row.buckets())), row.lastBehaviorVersion());
        return record;
    }
}
