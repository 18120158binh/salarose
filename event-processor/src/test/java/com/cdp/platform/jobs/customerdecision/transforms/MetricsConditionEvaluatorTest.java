package com.cdp.platform.jobs.customerdecision.transforms;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import com.cdp.platform.shared.models.MetricSeries;
import com.cdp.platform.shared.models.node.And;
import com.cdp.platform.shared.models.node.Comparison;
import com.cdp.platform.shared.models.node.MetricFunction;
import com.cdp.platform.shared.models.node.MetricPredicate;
import com.cdp.platform.shared.models.node.Or;
import com.cdp.platform.shared.models.node.Predicate;
import com.cdp.platform.shared.models.node.TimeWindow;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class MetricsConditionEvaluatorTest {

    private static final long HOUR = 3_600_000L;
    private static final long DAY = 24 * HOUR;
    private static final long T = 1_785_800_000_000L;
    private static final TimeWindow ONE_DAY = new TimeWindow(1, "DAYS");
    private static final long RETENTION = 365 * DAY;

    private final MetricsConditionEvaluator evaluator = new MetricsConditionEvaluator();

    @Test
    void inactionPassesForAPersonWithNoSeries() {
        Comparison didNotPurchase = new Comparison("m_purchase_count", "=", "0", ONE_DAY, "INACTION");

        assertTrue(evaluate(didNotPurchase, Map.of(), T));
    }

    @Test
    void anAbsentSeriesCountsAsEmptyNextToOneThatIsPresent() {
        Comparison viewedPage = new Comparison("m_view_page_count", ">=", "1", ONE_DAY, "COUNT");
        Comparison didNotPurchase = new Comparison("m_purchase_count", "=", "0", ONE_DAY, "INACTION");

        assertTrue(evaluate(new And(List.of(viewedPage, didNotPurchase)),
            Map.of("m_view_page_count", series("m_view_page_count", T - HOUR)), T));
    }

    @Test
    void anAbsentSeriesFailsACountThatNeedsAnOccurrence() {
        Comparison purchased = new Comparison("m_purchase_count", ">=", "1", ONE_DAY, "COUNT");

        assertFalse(evaluate(purchased, Map.of(), T));
    }

    @Test
    void inactionFailsWhenThePersonDidItInTheWindow() {
        Comparison didNotPurchase = new Comparison("m_purchase_count", "=", "0", ONE_DAY, "INACTION");

        assertFalse(evaluate(didNotPurchase, Map.of("m_purchase_count", series("m_purchase_count", T - HOUR)), T));
    }

    @Test
    void inactionPassesWhenThePersonDidItOnlyBeforeTheWindow() {
        Comparison didNotPurchase = new Comparison("m_purchase_count", "=", "0", ONE_DAY, "INACTION");

        assertTrue(evaluate(didNotPurchase, Map.of("m_purchase_count", series("m_purchase_count", T - 25 * HOUR)), T));
    }

    @Test
    void aComparisonWithoutAnOperatorMeansAtLeast() {
        Map<String, MetricSeries> oneView = Map.of("m_view_page_count", series("m_view_page_count", T - HOUR));

        assertTrue(evaluate(new Comparison("m_view_page_count", null, "1", ONE_DAY, "COUNT"), oneView, T));
        assertFalse(evaluate(new Comparison("m_view_page_count", "", "2", ONE_DAY, "COUNT"), oneView, T));
    }

    /** A rule restored from state may predate the parse-time check on groups. */
    @Test
    void aGroupWithoutExpressionsParsesAsAnEmptyGroup() {
        assertTrue(evaluate(new And(null), Map.of(), T));
        assertFalse(evaluate(new Or(null), Map.of(), T));
    }

    @Test
    void aWeekIsSevenDays() {
        Comparison carted = new Comparison("m_add_to_cart_count", ">=", "1", new TimeWindow(2, "WEEKS"), "COUNT");

        assertTrue(evaluate(carted, Map.of("m_add_to_cart_count", series("m_add_to_cart_count", T - 13 * DAY)), T));
        assertFalse(evaluate(carted, Map.of("m_add_to_cart_count", series("m_add_to_cart_count", T - 15 * DAY)), T));
    }

    @Test
    void aMonthIsThirtyDays() {
        Comparison carted = new Comparison("m_add_to_cart_count", ">=", "1", new TimeWindow(1, "MONTHS"), "COUNT");

        assertTrue(evaluate(carted, Map.of("m_add_to_cart_count", series("m_add_to_cart_count", T - 29 * DAY)), T));
        assertFalse(evaluate(carted, Map.of("m_add_to_cart_count", series("m_add_to_cart_count", T - 31 * DAY)), T));
    }

    @Test
    void eventsMonthsOldAreNotInAWindowOfTwoWeeks() {
        Comparison cartedThrice = new Comparison("m_add_to_cart_count", ">=", "3", new TimeWindow(2, "WEEKS"),
            "COUNT");
        MetricSeries monthsOld = series("m_add_to_cart_count", T - 92 * DAY, T - 91 * DAY, T - 90 * DAY);

        assertFalse(evaluate(cartedThrice, Map.of("m_add_to_cart_count", monthsOld), T));
    }

    @Test
    void anOccurrenceWithNoValueIsCountedButAddsNoValue() {
        assertTrue(
            evaluateValues(new Comparison("m_cart_value", "=", "4", ONE_DAY, "COUNT"), T, 10.0, null, 30.0, null));
        assertTrue(
            evaluateValues(new Comparison("m_cart_value", "=", "4", ONE_DAY, "INACTION"), T, 10.0, null, 30.0, null));
        assertTrue(
            evaluateValues(new Comparison("m_cart_value", "=", "40", ONE_DAY, "SUM"), T, 10.0, null, 30.0, null));
        assertTrue(
            evaluateValues(new Comparison("m_cart_value", "=", "20", ONE_DAY, "AVG"), T, 10.0, null, 30.0, null));
        assertTrue(
            evaluateValues(new Comparison("m_cart_value", "=", "10", ONE_DAY, "MIN"), T, 10.0, null, 30.0, null));
        assertTrue(
            evaluateValues(new Comparison("m_cart_value", "=", "30", ONE_DAY, "MAX"), T, 10.0, null, 30.0, null));
        assertTrue(
            evaluateValues(new Comparison("m_cart_value", "=", "20", ONE_DAY, "MEDIAN"), T, 10.0, null, 30.0, null));
        assertTrue(
            evaluateValues(new Comparison("m_cart_value", "=", "30", ONE_DAY, "LATEST"), T, 10.0, null, 30.0, null));
        assertTrue(evaluateValues(new Comparison("m_cart_value", "=", "2", ONE_DAY, "DISTINCT_COUNT"), T, 10.0, null,
            30.0, null));
        assertTrue(
            evaluateValues(new Comparison("m_cart_value", "=", "-20", ONE_DAY, "DIFF"), T, 10.0, null, 30.0, null));
        assertTrue(evaluateValues(new Comparison("m_cart_value", "=", "-20", ONE_DAY, "PRICE_DROP"), T, 10.0, null,
            30.0, null));
    }

    @Test
    void aValueThatIsNotANumberIsLeftOutOfNumericFunctions() {
        assertTrue(evaluateValues(new Comparison("m_cart_value", "=", "10", ONE_DAY, "AVG"), T, 10.0, "gold"));
        assertTrue(evaluateValues(new Comparison("m_cart_value", "=", "10", ONE_DAY, "MIN"), T, 10.0, "gold"));
        assertTrue(evaluateValues(new Comparison("m_cart_value", "=", "10", ONE_DAY, "LATEST"), T, 10.0, "gold"));
    }

    /**
     * With no value in the window, SUM and DISTINCT_COUNT are 0, and every other
     * value function has no value, so every comparison with it fails.
     */
    @Test
    void occurrencesWithNoValueGiveAValueFunctionNoValue() {
        assertTrue(evaluateValues(new Comparison("m_cart_value", "=", "2", ONE_DAY, "COUNT"), T, null, null));
        assertTrue(evaluateValues(new Comparison("m_cart_value", "=", "0", ONE_DAY, "SUM"), T, null, null));
        assertTrue(evaluateValues(new Comparison("m_cart_value", "=", "0", ONE_DAY, "DISTINCT_COUNT"), T, null, null));
        for (String function : List.of("AVG", "MIN", "MAX", "MEDIAN", "LATEST", "DIFF", "PRICE_DROP")) {
            for (String operator : List.of("=", "!=", "<", ">=")) {
                Comparison comparison = new Comparison("m_cart_value", operator, "0", ONE_DAY, function);

                assertFalse(evaluateValues(comparison, T, null, null), function + " " + operator + " 0");
            }
        }
    }

    @Test
    void anEmptyWindowGivesAValueFunctionNoValue() {
        long dayLater = T + DAY;

        assertTrue(evaluateValues(new Comparison("m_cart_value", "=", "0", ONE_DAY, "COUNT"), dayLater, 10.0));
        assertTrue(evaluateValues(new Comparison("m_cart_value", "=", "0", ONE_DAY, "SUM"), dayLater, 10.0));
        assertFalse(evaluateValues(new Comparison("m_cart_value", "<", "5", ONE_DAY, "MAX"), dayLater, 10.0));
        assertFalse(evaluate(new Comparison("m_cart_value", "<", "5", ONE_DAY, "MAX"), Map.of(), T));
    }

    @Test
    void aDiffNeedsTwoValues() {
        assertFalse(evaluateValues(new Comparison("m_price", "=", "0", ONE_DAY, "PRICE_DROP"), T, null, 100.0, null));
        assertFalse(evaluateValues(new Comparison("m_price", "!=", "0", ONE_DAY, "PRICE_DROP"), T, null, 100.0, null));
    }

    /** 5,000 occurrences over 3 days all count, far past the old cap of 100. */
    @Test
    void everyOccurrenceInTheWindowCounts() {
        MetricSeries carts = MetricSeries.empty("m_add_to_cart_count", "PRESENCE");
        for (int index = 0; index < 5_000; index++) {
            long time = T - 3 * DAY + index * 50_000L;
            carts = carts.add("cart-" + index, time, null, MetricFunction.COUNT, 30 * DAY, 0);
        }
        Map<String, MetricSeries> byId = Map.of("m_add_to_cart_count", carts);
        TimeWindow sevenDays = new TimeWindow(7, "DAYS");

        assertTrue(evaluate(new Comparison("m_add_to_cart_count", ">=", "5000", sevenDays, "COUNT"), byId, T));
        assertTrue(evaluate(new Comparison("m_add_to_cart_count", "=", "5000", sevenDays, "COUNT"), byId, T));
    }

    @Test
    void inactionPassesAfterManyOccurrencesBeforeTheWindow() {
        MetricSeries carts = MetricSeries.empty("m_add_to_cart_count", "PRESENCE");
        long dayOne = T - 12 * DAY - 12 * HOUR;
        for (int index = 0; index < 500; index++) {
            carts = carts
                .add("cart-" + index, dayOne + index * (5 * DAY / 500), null, MetricFunction.COUNT, 30 * DAY, 0);
        }

        assertTrue(evaluate(new Comparison("m_add_to_cart_count", "=", "0", new TimeWindow(7, "DAYS"), "INACTION"),
            Map.of("m_add_to_cart_count", carts), T));
    }

    /**
     * The 12:05 occurrence shares an hour bucket with the window's start, so it
     * counts. The 11:50 one is in the hour before, so it does not.
     */
    @Test
    void theOldEdgeOfAWindowIsTheBucketThatHoldsIt() {
        long noonOnTheFourteenth = Instant.parse("2026-10-14T12:00:00Z").toEpochMilli();
        long eventTime = Instant.parse("2026-10-21T12:20:00Z").toEpochMilli();
        MetricSeries carts = MetricSeries
            .empty("m_add_to_cart_count", "PRESENCE")
            .add("cart-1", noonOnTheFourteenth - 10 * 60_000L, null, MetricFunction.COUNT, 30 * DAY, 0)
            .add("cart-2", noonOnTheFourteenth + 5 * 60_000L, null, MetricFunction.COUNT, 30 * DAY, 0)
            // Moves the series clock to the event, in a minute that starts after it.
            .add("cart-3", eventTime + 5 * 60_000L, null, MetricFunction.COUNT, 30 * DAY, 0);

        assertEquals(1.0, MetricsConditionEvaluator
            .value(carts, MetricFunction.COUNT, Optional.of(Duration.ofDays(7)), eventTime)
            .getAsDouble());
    }

    @Test
    void eachFunctionIsExactOverTheBucketsInTheWindow() {
        long ten = T - 4 * HOUR;

        assertTrue(threeValues(new Comparison("m_value", "=", "60", ONE_DAY, "SUM"), ten));
        assertTrue(threeValues(new Comparison("m_value", "=", "20", ONE_DAY, "AVG"), ten));
        assertTrue(threeValues(new Comparison("m_value", "=", "10", ONE_DAY, "MIN"), ten));
        assertTrue(threeValues(new Comparison("m_value", "=", "30", ONE_DAY, "MAX"), ten));
        assertTrue(threeValues(new Comparison("m_value", "=", "30", ONE_DAY, "LATEST"), ten));
        assertTrue(threeValues(new Comparison("m_value", "=", "-10", ONE_DAY, "DIFF"), ten));
        assertTrue(threeValues(new Comparison("m_value", "=", "3", ONE_DAY, "COUNT"), ten));
    }

    @Test
    void aMedianOfFewValuesIsExact() {
        assertTrue(evaluateValues(new Comparison("m_value", "=", "25", ONE_DAY, "MEDIAN"), T, 40.0, 10.0, 30.0, 20.0));
        assertTrue(evaluateValues(new Comparison("m_value", "=", "30", ONE_DAY, "MEDIAN"), T, 50.0, 10.0, 30.0));
        assertTrue(evaluateValues(new Comparison("m_value", "=", "10", ONE_DAY, "MEDIAN"), T, 10.0, 10.0, 30.0));
    }

    @Test
    void distinctCountIsWithinItsError() {
        MetricSeries values = MetricSeries.empty("m_value", "NUMBER");
        for (int index = 0; index < 10_000; index++) {
            long time = T - DAY / 2 + index * 4_000L;
            values = values.add("event-" + index, time, (double) index, MetricFunction.DISTINCT_COUNT, 30 * DAY, 0);
        }

        double distinct = MetricsConditionEvaluator
            .value(values, MetricFunction.DISTINCT_COUNT, Optional.of(Duration.ofDays(1)), T)
            .getAsDouble();

        assertTrue(distinct >= 9_500 && distinct <= 10_500, "distinct count " + distinct);
    }

    @Test
    void medianIsWithinItsError() {
        MetricSeries values = MetricSeries.empty("m_value", "NUMBER");
        for (int value = 1; value <= 10_001; value++) {
            long time = T - DAY / 2 + value * 4_000L;
            values = values.add("event-" + value, time, (double) value, MetricFunction.MEDIAN, 30 * DAY, 0);
        }

        double median = MetricsConditionEvaluator
            .value(values, MetricFunction.MEDIAN, Optional.of(Duration.ofDays(1)), T)
            .getAsDouble();

        assertTrue(median >= 4_801 && median <= 5_201, "median " + median);
    }

    /** Values 10, 20, and 30, an hour apart from ten o'clock. */
    private boolean threeValues(Comparison comparison, long tenOClock) {
        MetricFunction function = comparison.function();
        MetricSeries series = MetricSeries.empty(comparison.left(), "NUMBER");
        for (int index = 0; index < 3; index++) {
            long time = tenOClock + index * HOUR;
            series = series.add("event-" + index, time, 10.0 * (index + 1), function, 30 * DAY, 0);
        }
        return evaluate(comparison, Map.of(comparison.left(), series), T);
    }

    private boolean evaluate(Predicate condition, Map<String, MetricSeries> metricsById, long eventTime) {
        return evaluator.evaluate(MetricPredicate.parse(condition).valueOrThrow(), metricsById, eventTime);
    }

    private static MetricSeries series(String metricId, long... eventTimes) {
        MetricSeries series = MetricSeries.empty(metricId, "PRESENCE");
        for (long time : eventTimes) {
            series = series.add("event-" + time, time, null, MetricFunction.COUNT, RETENTION, 0);
        }
        return series;
    }

    /**
     * Whether the comparison passes on a series with one occurrence an hour
     * apart per value, the newest an hour before T, whose buckets hold what the
     * comparison's function needs. A null value is an occurrence with no value.
     */
    private boolean evaluateValues(Comparison comparison, long eventTime, Object... values) {
        MetricFunction function = comparison.function() == null ? MetricFunction.COUNT : comparison.function();
        MetricSeries series = MetricSeries.empty(comparison.left(), "NUMBER");
        for (int index = 0; index < values.length; index++) {
            long time = T - (values.length - index) * HOUR;
            series = series.add("event-" + time, time, values[index], function, RETENTION, 0);
        }
        return evaluate(comparison, Map.of(comparison.left(), series), eventTime);
    }
}
