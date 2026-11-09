package com.cdp.platform.jobs.customerdecision;

import java.util.List;

import org.apache.flink.table.api.TableDescriptor;
import org.apache.flink.table.data.conversion.DataStructureConverter;
import org.apache.flink.table.data.conversion.DataStructureConverters;
import org.apache.flink.types.Row;

import com.cdp.platform.shared.models.SegmentCheck;
import com.cdp.platform.shared.models.source.KafkaSourceConfig;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

/**
 * The job's segment check table, from the bytes a Kafka record holds to the
 * checks the job keeps: the table's value format, the row the job receives, and
 * the check it parses from that row. One bad message on
 * {@code journey-engine-segment-checks} must not fail the job (DEC-KI-43).
 */
class SegmentChecksSourceTest {

    private static final String VALID = """
        {"schema_version":1,"event_id":"event-1","canon_id":"customer-42","domain_userid":"d-1",\
        "network_userid":"n-1","user_id":"u-1","campaign_id":"campaign-7","node_id":"node-3",\
        "event_name":"add_to_cart","event_time":1785800000000}""";
    private static final SegmentCheck VALID_CHECK = new SegmentCheck(1, "event-1", "customer-42", "d-1", "n-1",
        "u-1", "campaign-7", "node-3", "add_to_cart", 1_785_800_000_000L);

    /**
     * Acceptance criterion 1: a truncated JSON object is skipped, and later checks
     * are read.
     */
    @Test
    void aTruncatedObjectIsSkippedAndLaterChecksAreRead() {
        List<SegmentCheck> checks = assertDoesNotThrow(() -> read("{\"canon_id\":\"customer-42\"", VALID));

        assertEquals(List.of(VALID_CHECK), checks);
    }

    /**
     * Acceptance criterion 1, for the other shapes: an array, an empty message, a
     * JSON value that is not an object, and text that is not JSON.
     */
    @Test
    void arraysEmptyAndNonJsonMessagesAreSkipped() {
        List<SegmentCheck> checks = assertDoesNotThrow(() -> read("[1,2]", "[]", "", "42", "this is not json",
            VALID));

        assertEquals(List.of(VALID_CHECK), checks);
    }

    /**
     * Acceptance criterion 2: a check without a person, a campaign, a node, or an
     * event time is dropped, and the checks around it are kept.
     */
    @Test
    void aCheckWithoutARequiredFieldIsDropped() {
        List<SegmentCheck> checks = assertDoesNotThrow(() -> read(VALID,
            "{\"campaign_id\":\"campaign-7\",\"node_id\":\"node-3\",\"event_time\":1}",
            "{\"canon_id\":\" \",\"campaign_id\":\"campaign-7\",\"node_id\":\"node-3\",\"event_time\":1}",
            "{\"canon_id\":\"customer-42\",\"node_id\":\"node-3\",\"event_time\":1}",
            "{\"canon_id\":\"customer-42\",\"campaign_id\":\"campaign-7\",\"event_time\":1}",
            "{\"canon_id\":\"customer-42\",\"campaign_id\":\"campaign-7\",\"node_id\":\"node-3\"}",
            VALID));

        assertEquals(List.of(VALID_CHECK, VALID_CHECK), checks);
    }

    /**
     * Acceptance criterion 2, at the type boundary: an event_time that is not a
     * number reads as null, so the check has no event time and is dropped.
     */
    @Test
    void aCheckWhoseEventTimeIsNotANumberIsDropped() {
        List<SegmentCheck> checks = assertDoesNotThrow(() -> read("""
            {"canon_id":"customer-42","campaign_id":"campaign-7","node_id":"node-3","event_time":"soon"}""",
            VALID));

        assertEquals(List.of(VALID_CHECK), checks);
    }

    /**
     * Decodes each message with the job's segment check table, converts each row
     * as the job's table-to-stream step does, and keeps the checks that parse.
     */
    private static List<SegmentCheck> read(String... messages) throws Exception {
        TableDescriptor table = CustomerDecisionJob
            .segmentChecksTable(KafkaSourceConfig.of("redpanda:29092", "test", "journey-engine-segment-checks"));
        DataStructureConverter<Object, Object> converter = DataStructureConverters
            .getConverter(TableFormats.physicalType(table));
        converter.open(SegmentChecksSourceTest.class.getClassLoader());
        return TableFormats
            .read(table, messages)
            .stream()
            .map(row -> (Row) converter.toExternalOrNull(row))
            .flatMap(row -> SegmentCheck.fromRow(row).stream())
            .toList();
    }
}
