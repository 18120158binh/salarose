package com.cdp.platform.shared.models;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.Random;

import com.cdp.platform.shared.models.MetricBucket.Size;
import com.cdp.platform.shared.models.node.MetricFunction;
import com.cdp.platform.shared.utils.JacksonMapper;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.apache.datasketches.hll.HllSketch;
import org.apache.datasketches.kll.KllDoublesSketch;
import org.junit.jupiter.api.Test;

class MetricSeriesTest {

    private static final long MINUTE = 60_000L;
    private static final long HOUR = 60 * MINUTE;
    private static final long DAY = 24 * HOUR;
    private static final long TEN_MINUTES = 10 * MINUTE;
    private static final long RETENTION = 30 * DAY;
    private static final int DISTINCT_SERIES_BYTES = 960_000;
    private static final int QUANTILE_SERIES_BYTES = 2_400_000;

    @Test
    void anOccurrenceNearTheClockGoesIntoItsMinute() {
        long time = 100 * DAY + 5 * HOUR + 30 * MINUTE + 15_000L;

        MetricSeries series = add(empty(), "a", time);

        assertEquals(List
            .of(new MetricBucket(Size.MINUTE, time - 15_000L, 1, null, null, null, null, null, null,
                null)),
            series.buckets());
        assertEquals(time, series.seriesClock());
    }

    @Test
    void movingTheClockMergesOldMinutesIntoHoursAndOldHoursIntoDays() {
        MetricSeries series = add(empty(), "a", 100 * DAY + 10 * MINUTE);
        series = add(series, "b", 100 * DAY + 20 * MINUTE);

        MetricSeries threeHoursLater = add(series, "c", 100 * DAY + 3 * HOUR);
        MetricSeries nineDaysLater = add(series, "c", 109 * DAY + HOUR);

        assertEquals(List.of(bucket(Size.HOUR, 100 * DAY, 2), bucket(Size.MINUTE, 100 * DAY + 3 * HOUR, 1)),
            threeHoursLater.buckets());
        assertEquals(List.of(bucket(Size.DAY, 100 * DAY, 2), bucket(Size.MINUTE, 109 * DAY + HOUR, 1)),
            nineDaysLater.buckets());
    }

    @Test
    void aLateOccurrenceLandsInTheBucketItWouldHaveReachedByMerging() {
        MetricSeries series = add(empty(), "now", 100 * DAY);

        MetricSeries withLate = add(series, "late", 95 * DAY + 3 * HOUR + 7 * MINUTE);

        assertEquals(List.of(bucket(Size.HOUR, 95 * DAY + 3 * HOUR, 1), bucket(Size.MINUTE, 100 * DAY, 1)),
            withLate.buckets());
        assertEquals(100 * DAY, withLate.seriesClock());
    }

    /**
     * DEC-FR-03: an event older than the retention period does not change the
     * series.
     */
    @Test
    void anOccurrenceOlderThanTheRetentionPeriodIsNotCounted() {
        MetricSeries series = add(empty(), "day-100", 100 * DAY);

        assertNull(series.add("day-10", 10 * DAY, null, MetricFunction.COUNT, RETENTION, TEN_MINUTES));
    }

    @Test
    void bucketsOlderThanTheRetentionPeriodLeaveTheSeries() {
        MetricSeries series = add(empty(), "day-10", 10 * DAY);

        MetricSeries later = add(series, "day-100", 100 * DAY);

        assertEquals(List.of(bucket(Size.MINUTE, 100 * DAY, 1)), later.buckets());
    }

    @Test
    void everyOccurrenceCountsPastAHundred() {
        MetricSeries series = empty();
        for (int index = 0; index < 1_000; index++) {
            series = add(series, "event-" + index, 100 * DAY + index * MINUTE);
        }

        assertEquals(1_000, series.buckets().stream().mapToLong(MetricBucket::count).sum());
    }

    /** DEC-FR-26: three events in every order give the same series. */
    @Test
    void theSeriesDoesNotDependOnArrivalOrder() {
        List<List<Integer>> orders = List
            .of(List.of(0, 1, 2), List.of(0, 2, 1), List.of(1, 0, 2), List.of(1, 2, 0), List.of(2, 0, 1),
                List.of(2, 1, 0));
        long[] times = {90 * DAY + 5 * HOUR, 99 * DAY + 23 * HOUR + 30 * MINUTE, 100 * DAY};
        double[] values = {4.0, 7.5, 1.25};
        List<MetricSeries> results = new ArrayList<>();
        for (MetricFunction function : List.of(MetricFunction.SUM, MetricFunction.MIN, MetricFunction.LATEST)) {
            results.clear();
            for (List<Integer> order : orders) {
                MetricSeries series = empty();
                for (int index : order) {
                    series = series
                        .add("event-" + index, times[index], values[index], function, RETENTION, TEN_MINUTES);
                }
                results.add(series);
            }
            assertTrue(results.stream().allMatch(results.get(0)::equals), function + " " + results);
        }
    }

    /**
     * DEC-NFR-02: at most 121 minutes, 193 hours, and a day per day of retention
     * past 8, plus one.
     */
    @Test
    void theNumberOfBucketsIsBoundedWhateverTheActivity() {
        List<Long> times = new ArrayList<>();
        for (long time = 0; time <= 40 * DAY; time += 30_000L) {
            times.add(time);
        }
        Collections.shuffle(times, new Random(7));
        MetricSeries series = empty();
        for (long time : times) {
            MetricSeries updated = series.add("event-" + time, time, null, MetricFunction.COUNT, RETENTION, 0);
            if (updated != null) series = updated;
        }
        series = series.add("last", 40 * DAY + 1, null, MetricFunction.COUNT, RETENTION, 0);

        long minutes = series.buckets().stream().filter(bucket -> bucket.size() == Size.MINUTE).count();
        long hours = series.buckets().stream().filter(bucket -> bucket.size() == Size.HOUR).count();
        long days = series.buckets().stream().filter(bucket -> bucket.size() == Size.DAY).count();
        assertTrue(minutes <= 121, "minutes " + minutes);
        assertTrue(hours <= 193, "hours " + hours);
        assertTrue(days <= 23, "days " + days);
        assertTrue(series.buckets().size() <= 337, "buckets " + series.buckets().size());
    }

    @Test
    void aBucketKeepsTheTwoNewestNumericValues() {
        MetricSeries series = empty();
        series = series.add("a", 100 * DAY, 3.0, MetricFunction.LATEST, RETENTION, 0);
        series = series.add("b", 100 * DAY + 1_000L, "not a number", MetricFunction.LATEST, RETENTION, 0);
        series = series.add("c", 100 * DAY + 2_000L, 5.0, MetricFunction.LATEST, RETENTION, 0);
        series = series.add("d", 100 * DAY + 2_000L, 9.0, MetricFunction.LATEST, RETENTION, 0);

        assertEquals(List
            .of(new MetricBucket.Newest("c", 100 * DAY + 2_000L, 5.0),
                new MetricBucket.Newest("d", 100 * DAY + 2_000L, 9.0)),
            series.buckets().get(0).newest());
    }

    @Test
    void aSeriesSurvivesTheMutationJson() {
        MetricSeries series = empty();
        for (MetricFunction function : List
            .of(MetricFunction.SUM, MetricFunction.DISTINCT_COUNT,
                MetricFunction.MEDIAN, MetricFunction.DIFF)) {
            series = series.add("event-" + function, 100 * DAY, 2.5, function, RETENTION, 0);
        }
        CustomerProfileMutationEvent mutation = new CustomerProfileMutationEvent(1, "customer-42", 18, "event-1",
            100 * DAY, List.of(series));

        CustomerProfileMutationEvent read = JacksonMapper
            .readValue(JacksonMapper.writeValueAsString(mutation), CustomerProfileMutationEvent.class);

        assertEquals(mutation, read);
    }

    /**
     * At 12:30, the 10:15 occurrence is in an hour bucket and the 10:45 one is
     * still a minute, so both buckets of the 10:00 hour coexist.
     */
    @Test
    void anHourAndMinutesOfTheSameHourCoexistInEitherArrivalOrder() {
        long ten = 100 * DAY + 10 * HOUR;
        long[] times = {ten + 15 * MINUTE, ten + 45 * MINUTE, 100 * DAY + 12 * HOUR + 30 * MINUTE};

        MetricSeries inOrder = addAll(times[0], times[1], times[2]);
        MetricSeries late = addAll(times[2], times[0], times[1]);

        List<MetricBucket> expected = List
            .of(bucket(Size.HOUR, ten, 1), bucket(Size.MINUTE, ten + 45 * MINUTE, 1),
                bucket(Size.MINUTE, times[2], 1));
        assertEquals(expected, inOrder.buckets());
        assertEquals(inOrder, late);
    }

    /**
     * At 12:30 on day 108, the hours of day 100 that start 8 days or more before
     * merge into the day, and its later hours stay hours.
     */
    @Test
    void aDayAndHoursOfTheSameDayCoexistInEitherArrivalOrder() {
        long[] times = {100 * DAY + 3 * HOUR, 100 * DAY + 20 * HOUR + 5 * MINUTE,
            108 * DAY + 12 * HOUR + 30 * MINUTE};

        MetricSeries inOrder = addAll(times[0], times[1], times[2]);
        MetricSeries late = addAll(times[2], times[1], times[0]);

        List<MetricBucket> expected = List
            .of(bucket(Size.DAY, 100 * DAY, 1), bucket(Size.HOUR, 100 * DAY + 20 * HOUR, 1),
                bucket(Size.MINUTE, times[2], 1));
        assertEquals(expected, inOrder.buckets());
        assertEquals(inOrder, late);
    }

    /**
     * DEC-NFR-07: a series at the bucket limit, each bucket holding a full
     * sketch, as one mutation carries it. Measured at 953,099 bytes for
     * DISTINCT_COUNT and 2,342,873 bytes for MEDIAN. Both fit the 8 MiB
     * limit the producer, the profile writer, and the topic are set to.
     */
    @Test
    void aFullSketchSeriesHasABoundedMutationSize() {
        assertEquals(334, fullSeries(null, null).buckets().size());
        int distinct = mutationBytes(fullSeries(fullDistinct(), null));
        int quantiles = mutationBytes(fullSeries(null, fullQuantiles()));

        assertTrue(distinct < DISTINCT_SERIES_BYTES, "DISTINCT_COUNT " + distinct);
        assertTrue(quantiles < QUANTILE_SERIES_BYTES, "MEDIAN " + quantiles);
        assertTrue(quantiles < CustomerProfileMutationEvent.MAX_MESSAGE_BYTES, "MEDIAN within the Kafka limit");
        assertTrue(distinct < CustomerProfileMutationEvent.MAX_MESSAGE_BYTES, "DISTINCT_COUNT within the Kafka limit");
    }

    /**
     * The layout a series reaches with an occurrence in every 30 seconds of the
     * retention period, with every bucket holding the summaries. A clock at the
     * start of a day gives the most buckets: 120 minutes, 190 hours, and 24
     * days. The contract's bound of 337 is looser than the rules allow.
     */
    private static MetricSeries fullSeries(String distinct, String quantiles) {
        long clock = 100 * DAY;
        MetricSeries counted = empty();
        for (long time = clock - RETENTION - DAY; time <= clock; time += 30_000L) {
            MetricSeries updated = counted.add("event-" + time, time, null, MetricFunction.COUNT, RETENTION, 0);
            if (updated != null) counted = updated;
        }
        List<MetricBucket> buckets = counted
            .buckets()
            .stream()
            .map(bucket -> new MetricBucket(bucket.size(), bucket.start(), bucket.count(), null, null, null, null,
                null, distinct, quantiles))
            .toList();
        return new MetricSeries("m_value", "NUMBER", counted.seriesClock(), buckets);
    }

    private static String fullDistinct() {
        HllSketch sketch = new HllSketch(MetricBucket.DISTINCT_LG_K);
        for (int value = 0; value < 1_000_000; value++) {
            sketch.update(value);
        }
        return Base64.getEncoder().encodeToString(sketch.toCompactByteArray());
    }

    private static String fullQuantiles() {
        KllDoublesSketch sketch = KllDoublesSketch.newHeapInstance(MetricBucket.QUANTILE_K);
        for (int value = 0; value < 10_000_000; value++) {
            sketch.update(value);
        }
        return Base64.getEncoder().encodeToString(sketch.toByteArray());
    }

    private static int mutationBytes(MetricSeries series) {
        return JacksonMapper
            .writeValueAsString(new CustomerProfileMutationEvent(1, "customer-42", 18, "event-1", 100 * DAY,
                List.of(series)))
            .getBytes(StandardCharsets.UTF_8).length;
    }

    private static MetricSeries addAll(long... times) {
        MetricSeries series = empty();
        for (long time : times) {
            series = add(series, "event-" + time, time);
        }
        return series;
    }

    private static MetricSeries empty() {
        return MetricSeries.empty("m_purchase_count", "NUMBER");
    }

    private static MetricSeries add(MetricSeries series, String eventId, long time) {
        return series.add(eventId, time, null, MetricFunction.COUNT, RETENTION, TEN_MINUTES);
    }

    private static MetricBucket bucket(Size size, long start, long count) {
        return new MetricBucket(size, start, count, null, null, null, null, null, null, null);
    }
}
