package com.cdp.platform.jobs.customerdecision;

import java.util.List;

import org.apache.flink.table.data.RowData;

import com.cdp.platform.shared.models.ParsedEvent;
import com.cdp.platform.shared.models.source.KafkaSourceConfig;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * The value format of the job's parsed-events table, built from the table's own
 * options and fed the bytes a Kafka record holds. One bad message on
 * {@code snowplow-parsed} must not fail the job (DEC-KI-36).
 */
class ParsedEventsSourceTest {

    private static final String VALID = """
        {"canon_id":"customer-42","event_id":"event-1","event_name":"add_to_cart","event_timestamp":1785800000000}""";

    /**
     * Acceptance criterion 1: a message that is not JSON is skipped, and later
     * events are read.
     */
    @Test
    void aMessageThatIsNotJsonIsSkippedAndLaterEventsAreRead() {
        List<RowData> rows = assertDoesNotThrow(() -> read("this is not json", VALID));

        assertEquals(1, rows.size());
        assertEquals("event-1", rows.getFirst().getString(index("event_id")).toString());
    }

    /**
     * Acceptance criterion 1, at the edges: an empty message, a truncated object,
     * and a JSON value that is not an object. None may decode to a null row: the
     * Kafka source passes a null row on, and the operators after it read it.
     */
    @Test
    void emptyTruncatedAndNonObjectMessagesAreSkipped() {
        List<RowData> rows = assertDoesNotThrow(() -> read("", "{\"canon_id\":\"customer-42\"", "[1,2]", "42",
            VALID));

        assertEquals(1, rows.size());
        assertEquals("event-1", rows.getFirst().getString(index("event_id")).toString());
    }

    /**
     * Acceptance criterion 2: an event_timestamp that is not a number reads as
     * null, and the rest of the event is kept.
     */
    @Test
    void aTimestampThatIsNotANumberReadsAsNull() {
        List<RowData> rows = assertDoesNotThrow(() -> read("""
            {"canon_id":"customer-42","event_id":"event-2","event_name":"add_to_cart","event_timestamp":"soon"}""",
            VALID));

        assertEquals(2, rows.size());
        assertTrue(rows.getFirst().isNullAt(index("event_timestamp")));
        assertEquals("event-2", rows.getFirst().getString(index("event_id")).toString());
        assertEquals(1_785_800_000_000L, rows.get(1).getLong(index("event_timestamp")));
    }

    /**
     * Acceptance criterion 2, for the other time: a collector_timestamp that is
     * not a number reads as null too.
     */
    @Test
    void aCollectorTimestampThatIsNotANumberReadsAsNull() {
        List<RowData> rows = assertDoesNotThrow(() -> read("""
            {"canon_id":"customer-42","event_id":"event-3","event_name":"add_to_cart",\
            "event_timestamp":1785800000000,"collector_timestamp":{"at":1}}"""));

        assertEquals(1, rows.size());
        assertTrue(rows.getFirst().isNullAt(index("collector_timestamp")));
        assertEquals(1_785_800_000_000L, rows.getFirst().getLong(index("event_timestamp")));
    }

    private static int index(String column) {
        return List.of(ParsedEvent.ROW_TYPE.getFieldNames()).indexOf(column);
    }

    private static List<RowData> read(String... messages) throws Exception {
        return TableFormats
            .read(CustomerDecisionJob
                .parsedEventsTable(KafkaSourceConfig.of("redpanda:29092", "test", "snowplow-parsed")), messages);
    }
}
