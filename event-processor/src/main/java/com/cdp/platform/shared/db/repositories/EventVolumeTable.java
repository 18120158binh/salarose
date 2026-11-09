package com.cdp.platform.shared.db.repositories;

import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.OffsetDateTime;

import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.connector.jdbc.JdbcExecutionOptions;
import org.apache.flink.streaming.api.datastream.DataStream;

import com.cdp.platform.shared.config.DatabaseConfig;
import com.cdp.platform.shared.db.sinks.BatchingJdbcSink;
import com.cdp.platform.shared.db.sinks.JdbcSinkOptions;
import com.cdp.platform.shared.models.db.EventVolume;

import org.jooq.Field;
import org.jooq.Query;
import org.jooq.SQLDialect;
import org.jooq.Table;
import org.jooq.conf.ParamType;
import org.jooq.impl.DSL;

/**
 * The table {@code event_volume}: per event name, hour, and outcome, how many
 * events the event parse job saw and when it saw the latest. Studio reads it
 * for the Data pages.
 */
public final class EventVolumeTable {

    public static final String TABLE_NAME = "event_volume";

    public static final String EVENT_NAME = "event_name";
    public static final String BUCKET_START = "bucket_start";
    public static final String OUTCOME = "outcome";
    public static final String COUNT = "count";
    public static final String LAST_SEEN_AT = "last_seen_at";

    static final Table<?> TABLE = DSL.table(DSL.name(TABLE_NAME));
    static final Field<String> EVENT_NAME_FIELD = DSL.field(DSL.name(EVENT_NAME), String.class);
    static final Field<OffsetDateTime> BUCKET_START_FIELD = DSL.field(DSL.name(BUCKET_START), OffsetDateTime.class);
    static final Field<String> OUTCOME_FIELD = DSL.field(DSL.name(OUTCOME), String.class);
    static final Field<Long> COUNT_FIELD = DSL.field(DSL.name(COUNT), Long.class);
    static final Field<OffsetDateTime> LAST_SEEN_AT_FIELD = DSL.field(DSL.name(LAST_SEEN_AT), OffsetDateTime.class);
    // Qualified because the excluded row also has these columns in the upsert.
    static final Field<Long> STORED_COUNT_FIELD = DSL.field(DSL.name(TABLE_NAME, COUNT), Long.class);
    static final Field<OffsetDateTime> STORED_LAST_SEEN_AT_FIELD = DSL
        .field(DSL.name(TABLE_NAME, LAST_SEEN_AT), OffsetDateTime.class);

    private EventVolumeTable() {
    }

    /**
     * Upserts each row's running total. The stream is keyed by the row's primary
     * key, so one subtask writes each row, and a batch keeps only the latest
     * total of each row.
     */
    public static void attach(DataStream<EventVolume> totals, DatabaseConfig database,
        JdbcExecutionOptions batches) {
        totals
            .keyBy(EventVolume::key, Types.STRING)
            .sinkTo(new BatchingJdbcSink<>(upsertQuery().getSQL(ParamType.INDEXED), EventVolumeTable::bind, batches,
                JdbcSinkOptions.connection(database), EventVolume::key, row -> row.key(),
                (earlier, later) -> later))
            .name("Postgres Event Volume Sink")
            .uid("postgres-event-volume-sink");
    }

    /**
     * Writes a row's running total. It keeps the larger count and time, so a
     * total replayed after a restore, or a smaller one that restarted after its
     * state expired, never lowers the row. {@link #bind} fills its parameters.
     */
    static Query upsertQuery() {
        return DSL
            .using(SQLDialect.POSTGRES)
            .insertInto(TABLE)
            .columns(EVENT_NAME_FIELD, BUCKET_START_FIELD, OUTCOME_FIELD, COUNT_FIELD, LAST_SEEN_AT_FIELD)
            .values(DSL.val(null, EVENT_NAME_FIELD), DSL.val(null, BUCKET_START_FIELD), DSL.val(null, OUTCOME_FIELD),
                DSL.val(null, COUNT_FIELD), DSL.val(null, LAST_SEEN_AT_FIELD))
            .onConflict(EVENT_NAME_FIELD, BUCKET_START_FIELD, OUTCOME_FIELD)
            .doUpdate()
            .set(COUNT_FIELD, DSL.greatest(STORED_COUNT_FIELD, DSL.excluded(COUNT_FIELD)))
            .set(LAST_SEEN_AT_FIELD, DSL.greatest(STORED_LAST_SEEN_AT_FIELD, DSL.excluded(LAST_SEEN_AT_FIELD)));
    }

    /** Fills the parameters of {@link #upsertQuery} with one row. */
    static void bind(PreparedStatement statement, EventVolume row) throws SQLException {
        statement.setString(1, row.eventName());
        statement.setTimestamp(2, new Timestamp(row.bucketStart()));
        statement.setString(3, row.outcome());
        statement.setLong(4, row.count());
        statement.setTimestamp(5, new Timestamp(row.lastSeenAt()));
    }
}
