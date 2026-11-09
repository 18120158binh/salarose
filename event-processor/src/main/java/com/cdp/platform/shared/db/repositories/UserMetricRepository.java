package com.cdp.platform.shared.db.repositories;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.Duration;
import java.util.Collection;
import java.util.Collections;
import java.util.List;
import java.util.function.Function;

import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.util.TimeUtils;

import com.cdp.platform.shared.config.DatabaseConfig;
import com.cdp.platform.shared.db.sinks.BatchingJdbcSink;
import com.cdp.platform.shared.db.sinks.JdbcSinkOptions;
import com.cdp.platform.shared.models.db.UserMetric;
import com.cdp.platform.shared.utils.JdbcUtil;

import static com.cdp.platform.shared.db.repositories.UserMetricsTable.BUCKETS;
import static com.cdp.platform.shared.db.repositories.UserMetricsTable.CANON_ID;
import static com.cdp.platform.shared.db.repositories.UserMetricsTable.LAST_BEHAVIOR_VERSION;
import static com.cdp.platform.shared.db.repositories.UserMetricsTable.METRIC_ID;
import static com.cdp.platform.shared.db.repositories.UserMetricsTable.SERIES_CLOCK;
import static com.cdp.platform.shared.db.repositories.UserMetricsTable.STORED_LAST_BEHAVIOR_VERSION;
import static com.cdp.platform.shared.db.repositories.UserMetricsTable.TABLE;
import static com.cdp.platform.shared.db.repositories.UserMetricsTable.UPDATED_AT;

import com.zaxxer.hikari.HikariDataSource;
import org.jooq.DSLContext;
import org.jooq.Query;
import org.jooq.Record1;
import org.jooq.ResultQuery;
import org.jooq.SQLDialect;
import org.jooq.conf.ParamType;
import org.jooq.exception.DataAccessException;
import org.jooq.impl.DSL;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** PostgreSQL access and Flink persistence wiring for user metrics. */
public final class UserMetricRepository extends AbstractDatabaseRepository {

    private static final Logger LOG = LoggerFactory.getLogger(UserMetricRepository.class);
    private static final String READ_TIMEOUT_VARIABLE = "USER_METRICS_READ_TIMEOUT";
    private static final Duration DEFAULT_READ_TIMEOUT = Duration.ofSeconds(5);
    // The pool rejects a connection timeout below 250 ms.
    private static final Duration MIN_READ_TIMEOUT = Duration.ofMillis(250);

    UserMetricRepository(HikariDataSource dataSource) {
        super(dataSource);
    }

    /**
     * Reads the database's read replica. A read waits at most
     * {@code USER_METRICS_READ_TIMEOUT} for a connection, and again for its result.
     */
    public static UserMetricRepository open(DatabaseConfig database, int maxPoolSize) {
        Duration readTimeout = readTimeout(System.getenv(READ_TIMEOUT_VARIABLE));
        return new UserMetricRepository(JdbcUtil
            .createDataSource(database.readJdbcUrl(), database.user(), database.password(), maxPoolSize,
                readTimeout));
    }

    /**
     * The configured read timeout, {@link #DEFAULT_READ_TIMEOUT} when unset, and
     * at least {@link #MIN_READ_TIMEOUT}.
     */
    static Duration readTimeout(String configured) {
        if (configured == null || configured.isBlank()) return DEFAULT_READ_TIMEOUT;
        Duration timeout;
        try {
            timeout = TimeUtils.parseDuration(configured);
        } catch (IllegalArgumentException invalid) {
            throw new IllegalArgumentException(READ_TIMEOUT_VARIABLE + " is not a duration: " + configured, invalid);
        }
        if (timeout.compareTo(MIN_READ_TIMEOUT) >= 0) return timeout;
        LOG
            .warn("{}={} is below the minimum, using {} ms", READ_TIMEOUT_VARIABLE, configured,
                MIN_READ_TIMEOUT.toMillis());
        return MIN_READ_TIMEOUT;
    }

    /**
     * The longest a read can take before it fails: the wait for a connection and
     * then the wait for the result.
     */
    public Duration longestRead() {
        return Duration.ofMillis(2 * dataSource.getConnectionTimeout());
    }

    public static void attach(DataStream<UserMetric> metrics, DatabaseConfig database) {
        metrics
            .keyBy(UserMetric::canonId, Types.STRING)
            .sinkTo(new BatchingJdbcSink<>(upsertQuery().getSQL(ParamType.INDEXED), UserMetricRepository::bind,
                JdbcSinkOptions.batches(), JdbcSinkOptions.connection(database),
                metric -> "canonId=" + metric.canonId() + " metricId=" + metric.metricId(),
                UserMetricRepository::rowKey, UserMetricRepository::mergeInOrder))
            .name("Postgres User Metric Sink")
            .uid("postgres-user-metric-sink");
    }

    /** The {@code user_metrics} row that a metric writes. */
    static List<String> rowKey(UserMetric metric) {
        return List.of(metric.canonId(), metric.metricId());
    }

    /**
     * The row that the upsert leaves after writing {@code earlier} and then
     * {@code later}: the later row replaces the earlier one only with a higher
     * {@code last_behavior_version}.
     */
    static UserMetric mergeInOrder(UserMetric earlier, UserMetric later) {
        return later.lastBehaviorVersion() > earlier.lastBehaviorVersion() ? later : earlier;
    }

    /**
     * The person's stored series among {@code metricIds}. A failed or timed-out
     * read throws, so the caller cannot mistake it for a person with no series and
     * write a new series over the stored one.
     */
    public List<UserMetric> findMetrics(String canonId, Collection<String> metricIds) {
        if (metricIds == null || metricIds.isEmpty()) return Collections.emptyList();
        return read("the series", canonId,
            sql -> sql.fetch(selectQuery(canonId, metricIds)).map(UserMetricsTable::metric));
    }

    /**
     * The highest {@code last_behavior_version} among the person's rows, or 0 when
     * the person has none. A failed or timed-out read throws, so the caller cannot
     * mistake it for a person with no rows and restart the counter below the
     * stored version.
     */
    public long findLastBehaviorVersion(String canonId) {
        return read("the behavior version", canonId, sql -> sql.fetchOne(lastBehaviorVersionQuery(canonId)).value1());
    }

    private <T> T read(String what, String canonId, Function<DSLContext, T> query) {
        try (Connection connection = dataSource.getConnection()) {
            // The pool resets the timeout when the connection returns to it.
            connection.setNetworkTimeout(Runnable::run, (int) dataSource.getConnectionTimeout());
            return query.apply(DSL.using(connection, SQLDialect.POSTGRES));
        } catch (SQLException | DataAccessException exception) {
            throw new IllegalStateException("Cannot load " + what + " for canonId=" + canonId, exception);
        }
    }

    static ResultQuery<Record1<Long>> lastBehaviorVersionQuery(String canonId) {
        return DSL
            .using(SQLDialect.POSTGRES)
            .select(DSL.coalesce(DSL.max(LAST_BEHAVIOR_VERSION), 0L))
            .from(TABLE)
            .where(CANON_ID.eq(canonId));
    }

    static ResultQuery<?> selectQuery(String canonId, Collection<String> metricIds) {
        return DSL
            .using(SQLDialect.POSTGRES)
            .select(CANON_ID, METRIC_ID, SERIES_CLOCK, BUCKETS, LAST_BEHAVIOR_VERSION)
            .from(TABLE)
            .where(CANON_ID.eq(canonId))
            .and(METRIC_ID.in(metricIds));
    }

    static Query upsertQuery() {
        return DSL
            .using(SQLDialect.POSTGRES)
            .insertInto(TABLE)
            .columns(CANON_ID, METRIC_ID, SERIES_CLOCK, BUCKETS, LAST_BEHAVIOR_VERSION)
            .values(DSL.val(null, CANON_ID), DSL.val(null, METRIC_ID), DSL.val(null, SERIES_CLOCK),
                DSL.val(null, BUCKETS), DSL.val(null, LAST_BEHAVIOR_VERSION))
            .onConflict(CANON_ID, METRIC_ID)
            .doUpdate()
            .set(SERIES_CLOCK, DSL.excluded(SERIES_CLOCK))
            .set(BUCKETS, DSL.excluded(BUCKETS))
            .set(LAST_BEHAVIOR_VERSION, DSL.excluded(LAST_BEHAVIOR_VERSION))
            .set(UPDATED_AT, DSL.currentOffsetDateTime())
            .where(STORED_LAST_BEHAVIOR_VERSION.lt(DSL.excluded(LAST_BEHAVIOR_VERSION)));
    }

    private static void bind(PreparedStatement statement, UserMetric metric) throws SQLException {
        statement.setString(1, metric.canonId());
        statement.setString(2, metric.metricId());
        statement.setLong(3, metric.seriesClock());
        statement.setString(4, UserMetricsTable.bucketsJson(metric.buckets()));
        statement.setLong(5, metric.lastBehaviorVersion());
    }
}
