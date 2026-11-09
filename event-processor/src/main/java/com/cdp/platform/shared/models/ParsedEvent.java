package com.cdp.platform.shared.models;

import java.lang.reflect.Method;
import java.lang.reflect.RecordComponent;
import java.util.Arrays;
import java.util.List;

import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.api.java.typeutils.RowTypeInfo;
import org.apache.flink.table.api.DataTypes;
import org.apache.flink.table.api.Schema;
import org.apache.flink.types.Row;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * One event as published on {@code snowplow-parsed}. The record components are
 * the only list of its fields: each one's {@link JsonProperty} name is its
 * column, in this order, and {@link #schema()} and {@link #toRow()} are derived
 * from them.
 *
 * <p>
 * The identity stitcher keeps events that wait for a read in keyed state, so a
 * change to the components must stay savepoint-compatible. Flink's POJO
 * serializer restores a savepoint after a component is added or removed, but
 * not after one is renamed or retyped. Test a restore before such a change.
 */
public record ParsedEvent(
    @JsonProperty("ip") String ip,
    @JsonProperty("user_agent") String userAgent,
    @JsonProperty("network_userid") String networkUserid,
    @JsonProperty("event_timestamp") Long eventTimestamp,
    @JsonProperty("collector_timestamp") Long collectorTimestamp,
    @JsonProperty("app_id") String appId,
    @JsonProperty("event_name") String eventName,
    @JsonProperty("user_id") String userId,
    @JsonProperty("referrer_url") String referrerUrl,
    @JsonProperty("screen_location") String screenLocation,
    @JsonProperty("product_name") String productName,
    @JsonProperty("url") String url,
    @JsonProperty("domain_userid") String domainUserid,
    @JsonProperty("platform") String platform,
    @JsonProperty("event_json") String eventJson,
    @JsonProperty("canon_id") String canonId,
    @JsonProperty("event_id") String eventId) {

    private static final List<Column> COLUMNS = Arrays
        .stream(ParsedEvent.class.getRecordComponents())
        .map(Column::of)
        .toList();

    /** The row type of {@link #toRow()}, with the column names. */
    public static final RowTypeInfo ROW_TYPE = new RowTypeInfo(
        COLUMNS.stream().map(Column::rowType).toArray(TypeInformation[]::new),
        COLUMNS.stream().map(Column::name).toArray(String[]::new));

    public static Schema schema() {
        Schema.Builder builder = Schema.newBuilder();
        for (Column column : COLUMNS) {
            builder.column(column.name(), column.isLong() ? DataTypes.BIGINT() : DataTypes.STRING());
        }
        return builder.build();
    }

    /** The same event with the {@code canon_id} that identity stitching gave it. */
    public ParsedEvent withCanonId(String stitchedCanonId) {
        return new ParsedEvent(ip, userAgent, networkUserid, eventTimestamp, collectorTimestamp, appId, eventName,
            userId, referrerUrl, screenLocation, productName, url, domainUserid, platform, eventJson, stitchedCanonId,
            eventId);
    }

    /** The event as a positional row of {@link #ROW_TYPE}. */
    public Row toRow() {
        Row row = new Row(COLUMNS.size());
        for (int i = 0; i < COLUMNS.size(); i++) {
            row.setField(i, COLUMNS.get(i).read(this));
        }
        return row;
    }

    private record Column(String name, boolean isLong, Method accessor) {

        static Column of(RecordComponent component) {
            Class<?> type = component.getType();
            if (type != String.class && type != Long.class)
                throw new IllegalStateException("No column type for " + component);
            // JsonProperty does not target record components, so Java puts it on the
            // accessor.
            return new Column(component.getAccessor().getAnnotation(JsonProperty.class).value(), type == Long.class,
                component.getAccessor());
        }

        TypeInformation<?> rowType() {
            return isLong ? Types.LONG : Types.STRING;
        }

        Object read(ParsedEvent event) {
            try {
                return accessor.invoke(event);
            } catch (ReflectiveOperationException e) {
                throw new IllegalStateException("Cannot read " + name, e);
            }
        }
    }
}
