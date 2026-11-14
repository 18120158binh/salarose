package com.cdp.platform.jobs.profilewriter.transforms;

import java.util.ArrayList;
import java.util.List;

import org.apache.flink.util.Collector;

import com.cdp.platform.shared.models.SegmentMembershipChange;
import com.cdp.platform.shared.models.SegmentMembershipChange.Change;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class SegmentMembershipChangeMapperTest {

    // The membership change example of the customer decision contract.
    private static final String ENTERED = """
        {
            "schema_version": 1,
            "canon_id": "customer-42",
            "segment_id": "SEG-3f9a0c1d7e2b4a65",
            "change": "entered",
            "event_id": "123e4567-e89b-12d3-a456-426614174000",
            "event_time": 1785800000000
        }
        """;

    @Test
    void decodesTheContractsExample() {
        assertEquals(List
            .of(new SegmentMembershipChange("customer-42", "SEG-3f9a0c1d7e2b4a65", Change.ENTERED,
                "123e4567-e89b-12d3-a456-426614174000", 1785800000000L)),
            decode(ENTERED));
    }

    @Test
    void decodesAnExitedChange() {
        List<SegmentMembershipChange> changes = decode(ENTERED.replace("\"entered\"", "\"exited\""));

        assertEquals(1, changes.size());
        assertEquals(Change.EXITED, changes.get(0).change());
    }

    @Test
    void ignoresFieldsItDoesNotKnow() {
        assertEquals(1, decode(ENTERED.replace("\"schema_version\": 1", "\"schema_version\": 2, \"extra\": true"))
            .size());
    }

    @Test
    void dropsWhatDoesNotDecodeAndKeepsGoing() {
        assertEquals(List.of(), decode("not json"));
        assertEquals(List.of(), decode("null"));
        assertEquals(List.of(), decode(ENTERED.replace("\"canon_id\": \"customer-42\",", "")));
        assertEquals(List.of(), decode(ENTERED.replace("\"customer-42\"", "\" \"")));
        assertEquals(List.of(), decode(ENTERED.replace("\"segment_id\": \"SEG-3f9a0c1d7e2b4a65\",", "")));
        assertEquals(List.of(), decode(ENTERED.replace("\"entered\"", "\"stayed\"")));
        assertEquals(List.of(), decode(ENTERED.replace("\"change\": \"entered\",", "")));
    }

    @Test
    void dropsAnEnteredChangeWithoutItsTime() {
        String withoutTime = ENTERED.replace(",\n    \"event_time\": 1785800000000", "");

        assertEquals(List.of(), decode(withoutTime));
        assertEquals(1, decode(withoutTime.replace("\"entered\"", "\"exited\"")).size());
    }

    private static List<SegmentMembershipChange> decode(String json) {
        List<SegmentMembershipChange> out = new ArrayList<>();
        new SegmentMembershipChangeMapper().flatMap(json, new Collector<>() {
            @Override
            public void collect(SegmentMembershipChange record) {
                out.add(record);
            }

            @Override
            public void close() {
            }
        });
        return out;
    }
}
