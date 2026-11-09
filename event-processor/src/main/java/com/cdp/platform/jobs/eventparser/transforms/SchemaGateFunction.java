package com.cdp.platform.jobs.eventparser.transforms;

import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import org.apache.flink.api.common.functions.OpenContext;
import org.apache.flink.api.common.state.BroadcastState;
import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.streaming.api.functions.co.BroadcastProcessFunction;
import org.apache.flink.types.Either;
import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;
import org.apache.flink.util.Collector;

import com.cdp.platform.jobs.eventparser.transforms.DroppedEvents.Reason;
import com.cdp.platform.shared.db.repositories.UserEventsTable;
import com.cdp.platform.shared.models.ParsedEvent;
import com.cdp.platform.shared.models.db.CatalogAttribute;
import com.cdp.platform.shared.models.db.CatalogEvent;
import com.cdp.platform.shared.utils.JacksonMapper;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * Drops each parsed event whose catalog event has its schema gate on and whose
 * {@code event_json} does not match the event's catalog attributes. Other
 * events
 * pass unchanged. A dropped event goes to {@link DeadLetter#OUTPUT}. The
 * broadcast side carries the catalog: {@code user_events}
 * rows on the left, {@code user_event_fields} rows on the right.
 */
public final class SchemaGateFunction extends BroadcastProcessFunction<ParsedEvent, Either<Row, Row>, ParsedEvent> {

    public static final MapStateDescriptor<String, CatalogEvent> CATALOG_EVENTS = new MapStateDescriptor<>(
        "catalog-events", String.class, CatalogEvent.class);
    public static final MapStateDescriptor<String, CatalogAttribute> CATALOG_ATTRIBUTES = new MapStateDescriptor<>(
        "catalog-attributes", String.class, CatalogAttribute.class);

    private transient ObjectMapper mapper;
    private transient DroppedEvents droppedEvents;

    /**
     * The schemas of the gated events by event name. Built from the broadcast
     * state on the first event after a start, a restore, or a catalog change.
     */
    private transient Map<String, EventSchema> schemas;

    @Override
    public void open(OpenContext openContext) {
        mapper = JacksonMapper.instance();
        droppedEvents = new DroppedEvents(getRuntimeContext().getMetricGroup(), EnumSet.of(Reason.SCHEMA_INVALID));
    }

    @Override
    public void processBroadcastElement(Either<Row, Row> update, Context context, Collector<ParsedEvent> output)
        throws Exception {
        if (update.isLeft()) {
            Row row = update.left();
            apply(context.getBroadcastState(CATALOG_EVENTS), row.getFieldAs(UserEventsTable.ID), row,
                CatalogEvent.load(row));
        } else {
            Row row = update.right();
            apply(context.getBroadcastState(CATALOG_ATTRIBUTES), CatalogAttribute.stateKey(row), row,
                CatalogAttribute.load(row));
        }
        schemas = null;
    }

    @Override
    public void processElement(ParsedEvent event, ReadOnlyContext context, Collector<ParsedEvent> output)
        throws Exception {
        if (schemas == null) {
            schemas = schemas(context.getBroadcastState(CATALOG_EVENTS).immutableEntries(),
                context.getBroadcastState(CATALOG_ATTRIBUTES).immutableEntries());
        }
        String eventName = event.eventName();
        EventSchema schema = eventName == null ? null : schemas.get(eventName);
        if (schema == null) {
            output.collect(event);
            return;
        }
        Optional<String> violation = schema.violation(eventJson(event.eventJson()));
        if (violation.isPresent()) {
            droppedEvents.drop(Reason.SCHEMA_INVALID, violation.get());
            context
                .output(DeadLetter.OUTPUT, DeadLetter
                    .event(Reason.SCHEMA_INVALID, violation.get(), context.currentProcessingTime(), null,
                        JacksonMapper.writeValueAsString(event), eventName, event.collectorTimestamp()));
            return;
        }
        output.collect(event);
    }

    /**
     * Skips an update's before image: its key is the row's primary key, which an
     * update never changes, and removing the entry until the after image arrives
     * would let events in between pass unchecked. A key change reaches CDC as a
     * delete and an insert.
     */
    private static <T> void apply(BroadcastState<String, T> state, String key, Row row, Optional<T> value)
        throws Exception {
        RowKind kind = row.getKind();
        if (kind == RowKind.UPDATE_BEFORE) return;
        if (kind == RowKind.DELETE || value.isEmpty()) {
            state.remove(key);
        } else {
            state.put(key, value.get());
        }
    }

    private static Map<String, EventSchema> schemas(Iterable<Map.Entry<String, CatalogEvent>> events,
        Iterable<Map.Entry<String, CatalogAttribute>> attributes) {
        Map<String, List<CatalogAttribute>> attributesByEventId = new HashMap<>();
        attributes
            .forEach(entry -> attributesByEventId
                .computeIfAbsent(entry.getValue().eventId(), eventId -> new ArrayList<>())
                .add(entry.getValue()));

        Map<String, EventSchema> schemas = new HashMap<>();
        for (Map.Entry<String, CatalogEvent> entry : events) {
            CatalogEvent event = entry.getValue();
            if (!event.enforceSchema()) continue;
            schemas.put(event.eventName(), new EventSchema(attributesByEventId.getOrDefault(event.id(), List.of())));
        }
        return schemas;
    }

    /** The event's attributes, or an empty object when it has none. */
    private JsonNode eventJson(String json) {
        if (json == null || json.isBlank()) return mapper.createObjectNode();
        try {
            JsonNode node = mapper.readTree(json);
            return node.isObject() ? node : mapper.createObjectNode();
        } catch (JsonProcessingException unreadable) {
            return mapper.createObjectNode();
        }
    }
}
