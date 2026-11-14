package com.cdp.platform.shared.db.repositories;

import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Types;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;

import org.apache.flink.api.common.typeinfo.BasicTypeInfo;
import org.apache.flink.streaming.api.datastream.DataStream;

import com.cdp.platform.shared.config.DatabaseConfig;
import com.cdp.platform.shared.db.sinks.BatchingJdbcSink;
import com.cdp.platform.shared.db.sinks.JdbcSinkOptions;
import com.cdp.platform.shared.models.SegmentMembershipChange;

/** Flink persistence wiring for {@code segment_members}. */
public final class SegmentMemberRepository {

    private SegmentMemberRepository() {
    }

    /**
     * Keys the changes by {@code canon_id}, so one subtask writes every row of a
     * person (decision 0002), and sinks them. Changes for one row in one batch
     * collapse to the last, which leaves the row that applying them in order
     * would leave (PRW-FR-09).
     */
    public static void attach(DataStream<SegmentMembershipChange> changes, DatabaseConfig database) {
        changes
            .keyBy(SegmentMembershipChange::canonId, BasicTypeInfo.STRING_TYPE_INFO)
            .sinkTo(new BatchingJdbcSink<>(SegmentMembersTable.applyChangeSql(), SegmentMemberRepository::bind,
                JdbcSinkOptions.batches(), JdbcSinkOptions.connection(database),
                change -> "segmentId=" + change.segmentId() + " canonId=" + change.canonId(),
                SegmentMemberRepository::rowKey, SegmentMemberRepository::mergeInOrder))
            .name("Postgres Segment Member Sink")
            .uid("postgres-segment-member-sink");
    }

    /** The {@code segment_members} row that a change writes. */
    static List<String> rowKey(SegmentMembershipChange change) {
        return List.of(change.segmentId(), change.canonId());
    }

    /**
     * The later change alone decides the row: an entered change leaves the row
     * with its {@code since}, and an exited change leaves no row.
     */
    static SegmentMembershipChange mergeInOrder(SegmentMembershipChange earlier, SegmentMembershipChange later) {
        return later;
    }

    static void bind(PreparedStatement statement, SegmentMembershipChange change) throws SQLException {
        statement.setBoolean(1, change.entered());
        statement.setString(2, change.segmentId());
        statement.setString(3, change.canonId());
        if (change.entered()) {
            statement
                .setObject(4, OffsetDateTime.ofInstant(Instant.ofEpochMilli(change.eventTime()), ZoneOffset.UTC));
        } else {
            statement.setNull(4, Types.TIMESTAMP_WITH_TIMEZONE);
        }
    }
}
