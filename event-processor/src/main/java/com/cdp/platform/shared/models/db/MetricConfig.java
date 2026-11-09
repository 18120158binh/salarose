package com.cdp.platform.shared.models.db;

import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;

import com.cdp.platform.shared.db.repositories.UserMetricDefinitionsTable;
import com.cdp.platform.shared.models.Event;
import com.cdp.platform.shared.models.node.FieldPredicates;
import com.cdp.platform.shared.models.node.MetricFunction;
import com.cdp.platform.shared.models.node.Predicate;
import com.cdp.platform.shared.utils.ParseResult;

import com.fasterxml.jackson.annotation.JsonProperty;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Configuration for accumulating a user metric from matching events.
 * Represents a row in the user_metric_definitions table.
 */
public record MetricConfig(
    @JsonProperty("id") String id,
    @JsonProperty("name") String name,
    @JsonProperty("userEventId") String userEventId,
    @JsonProperty("eventName") String eventName,
    @JsonProperty("defaultProperties") Predicate defaultProperties,
    @JsonProperty("filterConditions") Predicate filterConditions,
    @JsonProperty("aggOperator") String aggOperator,
    @JsonProperty("aggField") String aggField,
    @JsonProperty("valueType") String valueType,
    @JsonProperty("retentionMs") long retentionMs,
    @JsonProperty("enabled") boolean enabled) {

    private static final long DEFAULT_RETENTION_DURATION_MS = 30L * 86_400_000L;
    private static final Logger LOG = LoggerFactory.getLogger(MetricConfig.class);

    public static ParseResult<MetricConfig> fromRow(Row row) {
        String eventName = row.getFieldAs(UserMetricDefinitionsTable.EVENT_NAME);
        // A definition counts the events of one name. No event has a blank name,
        // and * is not a wildcard.
        if (eventName == null || eventName.isBlank() || "*".equals(eventName.trim())) {
            return ParseResult
                .failure(new IllegalArgumentException("event_name: '%s' names no event".formatted(eventName)));
        }
        ParseResult<Predicate> defaultProperties = parseCondition(
            row.getFieldAs(UserMetricDefinitionsTable.DEFAULT_PROPERTIES));
        if (!defaultProperties.isValid()) return invalid("default_properties", defaultProperties);
        ParseResult<Predicate> filterConditions = parseCondition(
            row.getFieldAs(UserMetricDefinitionsTable.FILTER_CONDITIONS));
        if (!filterConditions.isValid()) return invalid("filter_conditions", filterConditions);
        ParseResult<MetricValueType> valueType = MetricValueType
            .parse(row.getFieldAs(UserMetricDefinitionsTable.VALUE_TYPE));
        if (!valueType.isValid()) return invalid("value_type", valueType);

        Long retention = row.getFieldAs(UserMetricDefinitionsTable.RETENTION_MS);
        Boolean enabled = row.getFieldAs(UserMetricDefinitionsTable.ENABLED);
        String mode = row.getFieldAs(UserMetricDefinitionsTable.PROCESSING_MODE);
        String userEventId = row.getFieldAs(UserMetricDefinitionsTable.USER_EVENT_ID);
        boolean upsert = row.getKind() == RowKind.INSERT || row.getKind() == RowKind.UPDATE_AFTER;

        return ParseResult
            .success(new MetricConfig(
                row.getFieldAs(UserMetricDefinitionsTable.ID),
                row.getFieldAs(UserMetricDefinitionsTable.NAME),
                userEventId != null ? userEventId : "",
                eventName,
                defaultProperties.valueOrThrow(),
                filterConditions.valueOrThrow(),
                row.getFieldAs(UserMetricDefinitionsTable.AGG_OPERATOR),
                row.getFieldAs(UserMetricDefinitionsTable.AGG_FIELD),
                valueType.valueOrThrow().name(),
                retention == null || retention <= 0 ? DEFAULT_RETENTION_DURATION_MS : retention,
                upsert && "LIVE".equalsIgnoreCase(mode) && (enabled == null || enabled)));
    }

    /**
     * The definition in the row. A row that does not parse loads as a disabled
     * definition with the row's id, so it removes the definition it replaces. A
     * CDC snapshot sends an edited row as an insert, with no update-before row to
     * remove the old definition.
     */
    public static MetricConfig load(Row row) {
        ParseResult<MetricConfig> parsed = fromRow(row);
        if (parsed.isValid()) return parsed.valueOrThrow();
        LOG
            .warn("Disabling invalid metric definition {}: {}", row.getField(UserMetricDefinitionsTable.ID),
                parsed.failureMessage());
        return disabled(row.getFieldAs(UserMetricDefinitionsTable.ID));
    }

    private static MetricConfig disabled(String id) {
        return new MetricConfig(id, null, null, null, null, null, null, null, null, 0L, false);
    }

    // Studio and the column default store {} for a definition without a condition.
    private static ParseResult<Predicate> parseCondition(String json) {
        if (json != null && json.replaceAll("\\s", "").equals("{}")) return ParseResult.success(null);
        return FieldPredicates.fromJson(json);
    }

    private static <T> ParseResult<T> invalid(String column, ParseResult<?> result) {
        return ParseResult.failure(new IllegalArgumentException("%s: %s".formatted(column, result.failureMessage())));
    }

    /**
     * The value type. Broadcast state keeps it by name. A definition restored from
     * state keeps the name as its row had it, which a database without the
     * column's check may hold in another case, so the name is read in any case.
     */
    public MetricValueType type() {
        return MetricValueType.parse(valueType).valueOrThrow();
    }

    /**
     * The function the definition counts for, which decides what its buckets
     * hold. A missing or unknown function means COUNT.
     */
    public MetricFunction function() {
        return MetricFunction.fromString(aggOperator);
    }

    public boolean matches(Event event) {
        if (event == null || event.eventName() == null) return false;
        if (eventName != null && !eventName.equalsIgnoreCase(event.eventName())) {
            return false;
        }
        if (defaultProperties != null && !event.evalPredicate(defaultProperties)) {
            return false;
        }
        if (filterConditions != null && !event.evalPredicate(filterConditions)) {
            return false;
        }
        return true;
    }

    public long maxRetentionDurationMs() {
        return retentionMs > 0 ? retentionMs : DEFAULT_RETENTION_DURATION_MS;
    }
}
