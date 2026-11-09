package com.cdp.platform.jobs.customerdecision;

import java.util.ArrayList;
import java.util.List;

import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.table.api.bridge.java.StreamTableEnvironment;
import org.apache.flink.types.Row;
import org.apache.flink.util.CloseableIterator;

import com.cdp.platform.shared.models.Event;
import com.cdp.platform.shared.models.ParsedEvent;
import com.cdp.platform.shared.models.source.KafkaSourceConfig;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import org.junit.jupiter.api.Test;

/**
 * The job's parsed-events table, with its event time and watermark, and the
 * query that feeds step 1, over rows in place of Kafka. A field that does not
 * parse reads as null, and the event must still reach step 1, which drops it,
 * without failing the job (DEC-KI-36).
 */
class ParsedEventsStreamTest {

    private static final long T = 1_785_800_000_000L;

    /**
     * Acceptance criterion 2: an event whose event_timestamp read as null, and
     * that has no collector time, reaches step 1, and the later event is read.
     */
    @Test
    void anEventWithNoReadableTimeReachesStep1AndLaterEventsAreRead() {
        List<Event> events = assertDoesNotThrow(
            () -> eventsOf(row("customer-42", "event-1", null, null), row("customer-42", "event-2", T, null)));

        assertEquals(List.of("event-1", "event-2"), events.stream().map(Event::eventId).toList());
        assertNull(events.getFirst().eventTimestamp());
        assertEquals(T, events.get(1).eventTimestamp());
    }

    /**
     * Acceptance criterion 2, with a collector time: the event reaches step 1
     * with no event_timestamp.
     */
    @Test
    void anEventWithOnlyACollectorTimeReachesStep1() {
        List<Event> events = assertDoesNotThrow(() -> eventsOf(row("customer-42", "event-1", null, T)));

        assertEquals(1, events.size());
        assertNull(events.getFirst().eventTimestamp());
    }

    /**
     * Acceptance criterion 3: an event without an event_id reaches step 1, so
     * step 1 drops it and counts it.
     */
    @Test
    void anEventWithoutAnIdReachesStep1() {
        List<Event> events = assertDoesNotThrow(
            () -> eventsOf(row("customer-42", null, T, T), row("customer-42", "event-2", T, T)));

        assertEquals(2, events.size());
        assertNull(events.getFirst().eventId());
    }

    /**
     * The stream is keyed by canon_id, so an event without one is dropped before
     * step 1, and the job keeps running.
     */
    @Test
    void anEventWithoutACanonIdIsDroppedBeforeStep1() {
        List<Event> events = assertDoesNotThrow(
            () -> eventsOf(row(null, "event-1", null, null), row("customer-42", "event-2", T, T)));

        assertEquals(List.of("event-2"), events.stream().map(Event::eventId).toList());
    }

    private static Row row(String canonId, String eventId, Long eventTimestamp, Long collectorTimestamp) {
        Row row = new Row(ParsedEvent.ROW_TYPE.getArity());
        row.setField(ParsedEvent.ROW_TYPE.getFieldIndex("canon_id"), canonId);
        row.setField(ParsedEvent.ROW_TYPE.getFieldIndex("event_id"), eventId);
        row.setField(ParsedEvent.ROW_TYPE.getFieldIndex("event_name"), "add_to_cart");
        row.setField(ParsedEvent.ROW_TYPE.getFieldIndex("event_timestamp"), eventTimestamp);
        row.setField(ParsedEvent.ROW_TYPE.getFieldIndex("collector_timestamp"), collectorTimestamp);
        return row;
    }

    /** The events step 1 receives when the job's table holds the rows. */
    private static List<Event> eventsOf(Row... rows) throws Exception {
        StreamExecutionEnvironment environment = StreamExecutionEnvironment.getExecutionEnvironment();
        environment.setParallelism(1);
        StreamTableEnvironment tables = StreamTableEnvironment.create(environment);
        tables
            .createTemporaryView("parsed_events", tables
                .fromDataStream(environment.fromData(List.of(rows), ParsedEvent.ROW_TYPE),
                    CustomerDecisionJob
                        .parsedEventsTable(KafkaSourceConfig.of("redpanda:29092", "test", "snowplow-parsed"))
                        .getSchema()
                        .orElseThrow()));
        List<Event> events = new ArrayList<>();
        try (CloseableIterator<Event> read = CustomerDecisionJob
            .parsedEvents(tables, "parsed_events")
            .executeAndCollect()) {
            read.forEachRemaining(events::add);
        }
        return events;
    }
}
