package com.cdp.platform.shared.db.repositories;

import java.time.OffsetDateTime;
import java.util.List;

import com.cdp.platform.shared.models.MetricBucket;
import com.cdp.platform.shared.models.db.UserMetric;
import com.cdp.platform.shared.utils.JacksonMapper;

import org.jooq.Field;
import org.jooq.JSONB;
import org.jooq.Record;
import org.jooq.Table;
import org.jooq.impl.DSL;

/**
 * The table {@code user_metrics}: one stored series per person and metric.
 * The profile writer writes it, and customer decision reads it when its state
 * lacks a series.
 */
public final class UserMetricsTable {

    public static final String TABLE_NAME = "user_metrics";

    static final Table<?> TABLE = DSL.table(DSL.name(TABLE_NAME));
    static final Field<String> CANON_ID = DSL.field(DSL.name("canon_id"), String.class);
    static final Field<String> METRIC_ID = DSL.field(DSL.name("metric_id"), String.class);
    static final Field<Long> SERIES_CLOCK = DSL.field(DSL.name("series_clock"), Long.class);
    static final Field<JSONB> BUCKETS = DSL.field(DSL.name("buckets"), JSONB.class);
    static final Field<Long> LAST_BEHAVIOR_VERSION = DSL.field(DSL.name("last_behavior_version"), Long.class);
    // Qualified because the excluded row also has this column in the ON CONFLICT
    // WHERE clause.
    static final Field<Long> STORED_LAST_BEHAVIOR_VERSION = DSL
        .field(DSL.name(TABLE_NAME, LAST_BEHAVIOR_VERSION.getName()), Long.class);
    static final Field<OffsetDateTime> UPDATED_AT = DSL.field(DSL.name("updated_at"), OffsetDateTime.class);

    private UserMetricsTable() {
    }

    /** The series in a row read with every column but {@code updated_at}. */
    static UserMetric metric(Record record) {
        JSONB buckets = record.get(BUCKETS);
        return new UserMetric(record.get(CANON_ID), record.get(METRIC_ID), record.get(SERIES_CLOCK),
            buckets == null ? List.of() : List.of(JacksonMapper.readValue(buckets.data(), MetricBucket[].class)),
            record.get(LAST_BEHAVIOR_VERSION));
    }

    /** The buckets as the {@code buckets} column stores them. */
    static String bucketsJson(List<MetricBucket> buckets) {
        return JacksonMapper.writeValueAsString(buckets);
    }
}
