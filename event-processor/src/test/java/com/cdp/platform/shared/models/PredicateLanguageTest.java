package com.cdp.platform.shared.models;

import com.cdp.platform.shared.models.db.UserProfile;
import com.cdp.platform.shared.models.node.Comparison;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * The operators of the predicate language must read the same on an event field
 * and on a profile field.
 */
class PredicateLanguageTest {

    @Test
    void likeTreatsCharactersOtherThanWildcardsAsLiterals() {
        assertTrue(onEvent("a(b", "LIKE", "%(b"));
        assertTrue(onProfile("a(b", "LIKE", "%(b"));
        assertTrue(onEvent("[sale] shoes", "LIKE", "[sale]%"));
        assertTrue(onProfile("[sale] shoes", "LIKE", "[sale]%"));
    }

    @Test
    void likeDotMatchesOnlyADot() {
        assertFalse(onEvent("add_to_cart", "LIKE", "add.to.cart"));
        assertFalse(onProfile("add_to_cart", "LIKE", "add.to.cart"));
    }

    @Test
    void likePercentMatchesAnyRunAndUnderscoreMatchesOneCharacter() {
        assertTrue(onEvent("add_to_cart", "LIKE", "add%"));
        assertTrue(onProfile("add_to_cart", "LIKE", "add%"));
        assertTrue(onEvent("add_to_cart", "LIKE", "add_to_car_"));
        assertTrue(onProfile("add_to_cart", "LIKE", "add_to_car_"));
        assertFalse(onEvent("add_to_cart", "LIKE", "add_to_ca_"));
        assertFalse(onProfile("add_to_cart", "LIKE", "add_to_ca_"));
    }

    @Test
    void inComparesItemsAsPlainStrings() {
        assertFalse(onEvent("addXto_cart", "IN", "add_to_cart,purchase"));
        assertFalse(onProfile("addXto_cart", "IN", "add_to_cart,purchase"));
        assertTrue(onEvent("purchase", "IN", "add_to_cart, purchase"));
        assertTrue(onProfile("purchase", "IN", "add_to_cart, purchase"));
    }

    @Test
    void inGivesTheSameAnswerOnAnEventFieldAndAProfileField() {
        String list = "(Hanoi, 'Da Nang')";

        assertTrue(onEvent("Da Nang", "IN", list));
        assertTrue(onProfile("Da Nang", "IN", list));
        assertTrue(onEvent("Hanoi", "IN", list));
        assertTrue(onProfile("Hanoi", "IN", list));
    }

    @Test
    void inMatchesAValueWithAQuoteOrAParenthesis() {
        assertTrue(onEvent("O'Brien", "IN", "O'Brien,Smith"));
        assertTrue(onProfile("O'Brien", "IN", "O'Brien,Smith"));
        assertTrue(onEvent("O'Brien", "IN", "('O'Brien', 'Smith')"));
        assertTrue(onProfile("Sale (50%)", "IN", "'Sale (50%)', Clearance"));
        assertTrue(onEvent("Sale (50%)", "IN", "(\"Sale (50%)\", Clearance)"));
        assertTrue(onEvent("say \"hi\"", "IN", "say \"hi\""));
    }

    @Test
    void inDoesNotDropAQuoteFromAValue() {
        assertFalse(onEvent("OBrien", "IN", "O'Brien,Smith"));
        assertFalse(onProfile("O'Brien", "IN", "OBrien,Smith"));
    }

    @Test
    void inReadsTheListFormatsStudioAndOlderRulesSave() {
        for (String list : new String[] {"Hanoi,Da Nang", " Hanoi , Da Nang ", "(Hanoi, Da Nang)",
            "('Hanoi','Da Nang')", "(\"Hanoi\", \"Da Nang\")", "'Hanoi', \"Da Nang\"", " ( 'Hanoi' , Da Nang ) "}) {
            assertTrue(onEvent("Da Nang", "IN", list), list);
            assertTrue(onProfile("Hanoi", "IN", list), list);
            assertTrue(onProfile(" Hanoi ", "IN", list), list);
            assertFalse(onEvent("Saigon", "IN", list), list);
        }
    }

    @Test
    void orderingComparesTwoIsoDatetimesInTime() {
        assertTrue(onEvent("2026-10-02T08:00:00Z", ">", "2026-10-01"));
        assertTrue(onProfile("2026-10-02T08:00:00Z", ">", "2026-10-01"));
        assertFalse(onEvent("2026-09-30T23:59:59Z", ">=", "2026-10-01"));
        assertFalse(onProfile("2026-09-30T23:59:59Z", ">=", "2026-10-01"));
        // 06:00 at +07:00 is 23:00 the day before in UTC.
        assertTrue(onEvent("2026-10-01T06:00:00+07:00", "<", "2026-10-01T00:00:00Z"));
        assertTrue(onProfile("2026-10-01T06:00:00+07:00", "<", "2026-10-01T00:00:00Z"));
        assertTrue(onEvent("2026-10-01T10:00:00.123Z", "<=", "2026-10-01T10:00:00.123Z"));
        assertTrue(onProfile("2026-10-01", "<=", "2026-10-01"));
    }

    @Test
    void orderingReadsADatetimeWithoutAnOffsetAsUtc() {
        assertTrue(onEvent("2026-10-01T00:00:00", ">=", "2026-10-01T00:00:00Z"));
        assertTrue(onProfile("2026-10-01T00:00:00", ">=", "2026-10-01T00:00:00Z"));
        assertFalse(onEvent("2026-10-01T00:00:00", ">", "2026-10-01T00:00:00Z"));
        assertFalse(onProfile("2026-10-01T00:00:00", ">", "2026-10-01T00:00:00Z"));
    }

    @Test
    void orderingReadsADateOnTheRightAsTheWholeDayInUtc() {
        assertTrue(onEvent("2026-10-01T10:00:00Z", "<=", "2026-10-01"));
        assertTrue(onProfile("2026-10-01T10:00:00Z", "<=", "2026-10-01"));
        assertFalse(onEvent("2026-10-01T10:00:00Z", ">", "2026-10-01"));
        assertFalse(onProfile("2026-10-01T10:00:00Z", ">", "2026-10-01"));
        assertTrue(onEvent("2026-10-01T10:00:00Z", ">=", "2026-10-01"));
        assertFalse(onEvent("2026-10-01T10:00:00Z", "<", "2026-10-01"));
        assertTrue(onEvent("2026-10-01T23:59:59.999Z", "<=", "2026-10-01"));
        assertFalse(onEvent("2026-10-02T00:00:00Z", "<=", "2026-10-01"));
        assertTrue(onEvent("2026-10-02T00:00:00Z", ">", "2026-10-01"));
        // 06:00 at +07:00 on 2 October is 23:00 on 1 October in UTC.
        assertTrue(onEvent("2026-10-02T06:00:00+07:00", "<=", "2026-10-01"));
    }

    @Test
    void orderingIsFalseForDatetimeFormsOutsideIso8601() {
        assertFalse(onEvent("2026-10-01T10:00:00+0700", ">", "2026-09-01"));
        assertFalse(onEvent("2026-10-01 10:00:00", ">", "2026-09-01"));
        assertFalse(onEvent("1759312800000", ">", "2026-09-01"));
        assertFalse(onProfile("1759312800000", "<", "2026-09-01"));
    }

    @Test
    void orderingStillComparesNumbersAsNumbers() {
        assertTrue(onEvent("10", ">", "9"));
        assertTrue(onProfile("10", ">", "9"));
    }

    @Test
    void orderingIsFalseWhenTheSidesAreNotBothNumbersOrBothDatetimes() {
        assertFalse(onEvent("2026-10-01", ">", "5"));
        assertFalse(onProfile("2026-10-01", ">", "5"));
        assertFalse(onEvent("next week", "<", "2026-10-01"));
        assertFalse(onProfile("next week", "<", "2026-10-01"));
    }

    @Test
    void comparisonWithoutOperatorDoesNotMatch() {
        // A rule loaded before operators were checked at parse time can still sit in
        // restored state.
        assertFalse(onEvent("add_to_cart", null, "add_to_cart"));
        assertFalse(onProfile("add_to_cart", null, "add_to_cart"));
    }

    @Test
    void comparisonWithoutLeftDoesNotMatch() {
        Event event = new Event("domain-1", "user-1", "add_to_cart", 1_760_346_764_120L, null, null, null, null, "web",
            null);
        UserProfile profile = new UserProfile(null, null, null, null, null, null, null, null, null, null, "Hanoi",
            null, null, null, null);

        assertFalse(event.evalPredicate(new Comparison(null, "=", "add_to_cart")));
        assertFalse(profile.evalPredicate(new Comparison(null, "=", "Hanoi")));
    }

    private static boolean onEvent(String value, String op, String right) {
        Event event = new Event("domain-1", "user-1", value, 1_760_346_764_120L, null, null, null, null, "web", null);
        return event.evalPredicate(new Comparison("event.name", op, right));
    }

    private static boolean onProfile(String value, String op, String right) {
        UserProfile profile = new UserProfile(null, null, null, null, null, null, null, null, null, null, value, null,
            null, null, null);
        return profile.evalPredicate(new Comparison("profile.city", op, right));
    }
}
