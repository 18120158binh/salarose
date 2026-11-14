package com.cdp.platform.shared.models.node;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import com.cdp.platform.shared.models.db.UserProfile;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * The relative-date operators and imported fields of the condition language
 * (DEC-FR-40, DEC-FR-42, DEC-FR-43).
 */
class RelativeDateConditionTest {

    private static final Instant NOV_8 = Instant.parse("2026-11-08T10:00:00+07:00");

    @Test
    void moreThanDaysAgoHoldsStrictlyBeforeTheBoundary() {
        Instant boundary = NOV_8.minusSeconds(60L * 86_400);
        assertTrue(lastOrderAt(boundary.minusSeconds(1).toString(), "more_than_days_ago", "60", NOV_8));
        assertFalse(lastOrderAt(boundary.toString(), "more_than_days_ago", "60", NOV_8));
    }

    @Test
    void withinLastDaysHoldsFromTheBoundaryToTheCheckTime() {
        Instant boundary = NOV_8.minusSeconds(7L * 86_400);
        assertTrue(lastOrderAt(boundary.toString(), "within_last_days", "7", NOV_8));
        assertTrue(lastOrderAt(NOV_8.toString(), "within_last_days", "7", NOV_8));
        assertFalse(lastOrderAt(boundary.minusSeconds(1).toString(), "within_last_days", "7", NOV_8));
        assertFalse(lastOrderAt(NOV_8.plusSeconds(1).toString(), "within_last_days", "7", NOV_8));
    }

    @Test
    void aRelativeDateWithoutACheckTimeOrAValueFails() {
        assertFalse(lastOrderAt("2026-09-01", "more_than_days_ago", "60", null));
        assertFalse(lastOrderAt(null, "more_than_days_ago", "60", NOV_8));
    }

    @Test
    void aDateAloneIsTheStartOfItsDayInUtc() {
        assertTrue(lastOrderAt("2026-09-01", "more_than_days_ago", "60", NOV_8));
        assertFalse(lastOrderAt("2026-09-01T10:00:00+0700", "more_than_days_ago", "60", NOV_8));
    }

    @Test
    void aRelativeDateOnAnEventPropertyFailsToParse() {
        assertFalse(RuleDocuments
            .trigger("""
                {"kind":"event","event":"purchase","filters":{"groups":[{"conditions":[
                 {"type":"event_property","field":"order.created_at","op":"more_than_days_ago","value":30}]}]}}""")
            .isValid());
    }

    @Test
    void aRelativeDateOfLessThanOneWholeDayFailsToParse() {
        for (String value : List.of("0", "-3", "1.5", "\"seven\"", "null")) {
            assertFalse(RuleDocuments.conditions(withinLastDays(value)).isValid(), value);
        }
        assertTrue(RuleDocuments.conditions(withinLastDays("7")).isValid());
        assertTrue(RuleDocuments.conditions(withinLastDays("\"7\"")).isValid());
    }

    @Test
    void anImportedFieldIsReadFromTheProfilesImportedFields() {
        UserProfile profile = UserProfile.empty().withImported(Map.of("orders.spend_90d", "12990000"));
        Predicate condition = RuleDocuments
            .conditions("""
                {"groups":[{"conditions":[
                 {"type":"profile_property","field":"orders.spend_90d","op":">=","value":5000000}]}]}""")
            .valueOrThrow()
            .groups()
            .getFirst()
            .profile()
            .getFirst();

        assertTrue(profile.evalPredicate(condition));
        assertFalse(UserProfile.empty().evalPredicate(condition));
    }

    private static String withinLastDays(String value) {
        return """
            {"groups":[{"conditions":[
             {"type":"profile_property","field":"orders.last_order_at","op":"within_last_days","value":%s}]}]}"""
            .formatted(value);
    }

    private static boolean lastOrderAt(String value, String op, String days, Instant checkTime) {
        Map<String, String> fields = value == null ? Map.of() : Map.of("profile.orders.last_order_at", value);
        return FieldPredicates
            .evaluate(new Comparison("profile.orders.last_order_at", op, days), fields::get, checkTime);
    }
}
