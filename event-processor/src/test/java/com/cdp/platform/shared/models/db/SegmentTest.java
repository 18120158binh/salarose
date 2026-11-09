package com.cdp.platform.shared.models.db;

import java.util.List;
import java.util.Set;

import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;

import com.cdp.platform.shared.models.node.RuleDocuments;
import com.cdp.platform.shared.models.node.SegmentMembership;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/** Parsing {@code segments} rows and {@code segment_membership} conditions. */
class SegmentTest {

    private static final String HANOI = """
        {"type":"profile_property","field":"city","op":"IN","value":["Hanoi"]}""";
    private static final String ADDED_TO_CART = """
        {"type":"behavior","metric_id":"m_add_to_cart_count","event":"add_to_cart","measure":"COUNT","op":">=",
         "value":3,"window":{"value":7,"unit":"DAYS"}}""";

    @Test
    void aSegmentRowLoadsItsGroupsAndTheMetricsTheyRead() {
        Segment segment = Segment
            .load(row("{\"groups\":[{\"conditions\":[" + HANOI + "]},{\"conditions\":[" + ADDED_TO_CART + "]}]}"))
            .orElseThrow();

        assertEquals("SEG-3f9a0c1d7e2b4a65", segment.id());
        assertEquals(2, segment.conditions().groups().size());
        assertEquals(Set.of("m_add_to_cart_count"), segment.conditions().metricIds());
    }

    @Test
    void aSegmentWithASegmentMembershipOrWithoutGroupsDoesNotLoad() {
        String membership = "{\"type\":\"segment_membership\",\"segment_id\":\"SEG-00000000000000b1\",\"op\":\"in\"}";

        assertFalse(Segment.load(row("{\"groups\":[{\"conditions\":[" + membership + "]}]}")).isPresent());
        assertFalse(Segment.load(row("{\"groups\":[]}")).isPresent());
        assertFalse(Segment.load(row("{\"groups\":[{\"conditions\":[]}]}")).isPresent());
        assertFalse(Segment.load(row("not json")).isPresent());
    }

    @Test
    void aSegmentMembershipNamesTheSegmentAndInOrNotIn() {
        var conditions = RuleDocuments
            .conditions("""
                {"groups":[{"conditions":[
                 {"type":"segment_membership","segment_id":"SEG-3f9a0c1d7e2b4a65","op":"in"},
                 {"type":"segment_membership","segment_id":"SEG-00000000000000b1","op":"not_in"}]}]}""")
            .valueOrThrow();

        assertEquals(List
            .of(new SegmentMembership("SEG-3f9a0c1d7e2b4a65", true),
                new SegmentMembership("SEG-00000000000000b1", false)),
            conditions.groups().getFirst().segments());
    }

    @Test
    void aSegmentMembershipWithAnotherOperatorOrNoSegmentDoesNotParse() {
        assertFalse(RuleDocuments
            .conditions(
                "{\"groups\":[{\"conditions\":[{\"type\":\"segment_membership\",\"segment_id\":\"SEG-3f9a0c1d7e2b4a65\",\"op\":\"IN\"}]}]}")
            .isValid());
        assertFalse(RuleDocuments
            .conditions("{\"groups\":[{\"conditions\":[{\"type\":\"segment_membership\",\"op\":\"in\"}]}]}")
            .isValid());
        assertTrue(RuleDocuments
            .conditions(
                "{\"groups\":[{\"conditions\":[{\"type\":\"segment_membership\",\"segment_id\":\"SEG-3f9a0c1d7e2b4a65\",\"op\":\"not_in\"}]}]}")
            .isValid());
    }

    private static Row row(String conditionsJson) {
        Row row = Row.withNames(RowKind.INSERT);
        row.setField("id", "SEG-3f9a0c1d7e2b4a65");
        row.setField("conditions_json", conditionsJson);
        return row;
    }
}
