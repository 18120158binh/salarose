package com.cdp.platform.shared.db.repositories;

import org.apache.flink.table.api.DataTypes;
import org.apache.flink.table.api.Schema;

/**
 * The table {@code user_metric_definitions}: one row per metric that studio
 * defines. Customer decision reads it through CDC.
 */
public final class UserMetricDefinitionsTable {

    public static final String TABLE_NAME = "user_metric_definitions";
    public static final String PUBLICATION_NAME = "metric_defs_pub";

    public static final String ID = "id";
    public static final String NAME = "name";
    public static final String PROCESSING_MODE = "processing_mode";
    public static final String USER_EVENT_ID = "user_event_id";
    public static final String EVENT_NAME = "event_name";
    public static final String DEFAULT_PROPERTIES = "default_properties";
    public static final String FILTER_CONDITIONS = "filter_conditions";
    public static final String AGG_OPERATOR = "agg_operator";
    public static final String AGG_FIELD = "agg_field";
    public static final String METRIC_TYPE = "metric_type";
    public static final String VALUE_TYPE = "value_type";
    public static final String RETENTION_MS = "retention_ms";
    public static final String ENABLED = "enabled";

    private UserMetricDefinitionsTable() {
    }

    /** The columns customer decision reads through CDC. */
    public static Schema cdcSchema() {
        return Schema
            .newBuilder()
            .column(ID, DataTypes.STRING().notNull())
            .column(NAME, DataTypes.STRING().notNull())
            .column(PROCESSING_MODE, DataTypes.STRING())
            .column(USER_EVENT_ID, DataTypes.STRING())
            .column(EVENT_NAME, DataTypes.STRING())
            .column(DEFAULT_PROPERTIES, DataTypes.STRING())
            .column(FILTER_CONDITIONS, DataTypes.STRING())
            .column(AGG_OPERATOR, DataTypes.STRING())
            .column(AGG_FIELD, DataTypes.STRING())
            .column(METRIC_TYPE, DataTypes.STRING())
            .column(VALUE_TYPE, DataTypes.STRING())
            .column(RETENTION_MS, DataTypes.BIGINT())
            .column(ENABLED, DataTypes.BOOLEAN())
            .primaryKey(ID)
            .build();
    }
}
