package com.cdp.platform.jobs.segmentpass;

import java.time.Instant;
import java.util.Map;

import com.cdp.platform.shared.models.db.Segment;
import com.cdp.platform.shared.models.db.UserProfile;
import com.cdp.platform.shared.models.node.RuleDocuments;
import com.cdp.platform.shared.utils.JacksonMapper;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * Relative-date conditions in the nightly pass measure from {@code as_of}, as
 * customer decision measures from the check time (SMP-FR-03, DEC-FR-42).
 */
class SegmentEvaluatorTest {

    private static final Instant AS_OF = Instant.parse("2026-11-14T17:00:00Z");

    @Test
    void moreThanDaysAgoMeasuresFromAsOf() {
        SegmentEvaluator lapsed = evaluator("more_than_days_ago", 60);

        assertTrue(lapsed.isMember(lastOrderDaysBeforeAsOf(90)));
        assertFalse(lapsed.isMember(lastOrderDaysBeforeAsOf(30)));
    }

    @Test
    void withinLastDaysMeasuresFromAsOf() {
        SegmentEvaluator recent = evaluator("within_last_days", 60);

        assertTrue(recent.isMember(lastOrderDaysBeforeAsOf(30)));
        assertFalse(recent.isMember(lastOrderDaysBeforeAsOf(90)));
    }

    private static SegmentEvaluator evaluator(String op, int days) {
        String json = """
            {"groups":[{"conditions":[
             {"type":"profile_property","field":"orders.last_order_at","op":"%s","value":%d}]}]}"""
            .formatted(op, days);
        Segment segment = new Segment("seg-1", RuleDocuments.segmentConditions(json).valueOrThrow());
        return SegmentEvaluator.of(segment, AS_OF).valueOrThrow();
    }

    private static ImportedCustomer lastOrderDaysBeforeAsOf(long days) {
        String lastOrderAt = AS_OF.minusSeconds(days * 86_400).toString();
        return new ImportedCustomer("0912345678", UserProfile.empty(),
            Map.of("orders", JacksonMapper.readTree("{\"last_order_at\":\"" + lastOrderAt + "\"}")));
    }
}
