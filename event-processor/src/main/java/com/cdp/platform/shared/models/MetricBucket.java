package com.cdp.platform.shared.models;

import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.List;

import com.cdp.platform.shared.models.node.MetricFunction;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import org.apache.datasketches.hll.HllSketch;
import org.apache.datasketches.hll.Union;
import org.apache.datasketches.kll.KllDoublesSketch;
import org.apache.datasketches.memory.Memory;

/**
 * The totals of a metric's occurrences in one whole UTC minute, hour, or day.
 * Every bucket holds its number of occurrences. The other fields hold what the
 * definition's function needs, and are null when the function needs none of
 * them or when no occurrence gave them a value.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public record MetricBucket(
    @JsonProperty("size") Size size,
    @JsonProperty("start") long start,
    @JsonProperty("count") long count,
    @JsonProperty("sum") Double sum,
    @JsonProperty("valueCount") Long valueCount,
    @JsonProperty("min") Double min,
    @JsonProperty("max") Double max,
    @JsonProperty("newest") List<Newest> newest,
    @JsonProperty("distinct") String distinct,
    @JsonProperty("quantiles") String quantiles) {

    /** HLL with this lgK has a relative standard error of 1.62%. */
    public static final int DISTINCT_LG_K = 12;
    /** KLL with this k answers a quantile within 1.33% of its true rank. */
    public static final int QUANTILE_K = 200;

    private static final Comparator<Newest> OLDEST_FIRST = Comparator
        .comparingLong(Newest::eventTime)
        .thenComparing(Newest::eventId);

    public MetricBucket {
        newest = newest == null ? null : List.copyOf(newest);
    }

    /**
     * A bucket length. Each minute lies inside one hour, and each hour inside one
     * day.
     */
    public enum Size {
        MINUTE(60_000L), HOUR(3_600_000L), DAY(86_400_000L);

        private final long millis;

        Size(long millis) {
            this.millis = millis;
        }

        public long millis() {
            return millis;
        }

        /** The start of the bucket of this size that holds the time. */
        public long startOf(long time) {
            return Math.floorDiv(time, millis) * millis;
        }
    }

    /** One of a bucket's two newest occurrences with a numeric value. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Newest(
        @JsonProperty("eventId") String eventId,
        @JsonProperty("eventTime") long eventTime,
        @JsonProperty("value") double value) {
    }

    public long end() {
        return start + size.millis();
    }

    /**
     * A bucket that holds one occurrence, with the fields the function needs. A
     * value that is not a number stays out of every field but the distinct
     * summary.
     */
    public static MetricBucket of(Size size, long start, String eventId, long eventTime, Object value,
        MetricFunction function) {
        Double number = numeric(value);
        Double sum = null;
        Long valueCount = null;
        Double min = null;
        Double max = null;
        List<Newest> newest = null;
        String distinct = null;
        String quantiles = null;
        switch (function) {
            case SUM, AVG -> {
                if (number != null) {
                    sum = number;
                    valueCount = 1L;
                }
            }
            case MIN, MAX -> {
                min = number;
                max = number;
            }
            case LATEST, PRICE_DROP, DIFF -> {
                if (number != null) newest = List.of(new Newest(eventId, eventTime, number));
            }
            case DISTINCT_COUNT -> {
                if (value != null) distinct = distinctOf(value);
            }
            case MEDIAN -> {
                if (number != null) quantiles = quantilesOf(number);
            }
            case COUNT, INACTION -> {
                // The count is all these need.
            }
        }
        return new MetricBucket(size, start, 1, sum, valueCount, min, max, newest, distinct, quantiles);
    }

    /**
     * This bucket's totals and the other's, in a bucket of the given size and
     * start.
     */
    public MetricBucket merge(MetricBucket other, Size mergedSize, long mergedStart) {
        return new MetricBucket(mergedSize, mergedStart, count + other.count, add(sum, other.sum),
            add(valueCount, other.valueCount), least(min, other.min), greatest(max, other.max),
            newestTwo(newest, other.newest), unionDistinct(distinct, other.distinct),
            mergeQuantiles(quantiles, other.quantiles));
    }

    /** This bucket's totals in a bucket of the given size and start. */
    public MetricBucket resized(Size newSize, long newStart) {
        return new MetricBucket(newSize, newStart, count, sum, valueCount, min, max, newest, distinct, quantiles);
    }

    /**
     * The value as a number, or null when it is none: a number, or text that
     * reads as a finite number.
     */
    public static Double numeric(Object value) {
        if (value instanceof Number number) return number.doubleValue();
        if (!(value instanceof String text)) return null;
        try {
            double parsed = Double.parseDouble(text);
            return Double.isFinite(parsed) ? parsed : null;
        } catch (NumberFormatException notANumber) {
            return null;
        }
    }

    /** A distinct summary decoded from a bucket. */
    public static HllSketch distinctSketch(String encoded) {
        return HllSketch.heapify(Base64.getDecoder().decode(encoded));
    }

    /** A quantile summary decoded from a bucket. */
    public static KllDoublesSketch quantileSketch(String encoded) {
        return KllDoublesSketch.heapify(Memory.wrap(Base64.getDecoder().decode(encoded)));
    }

    private static String distinctOf(Object value) {
        HllSketch sketch = new HllSketch(DISTINCT_LG_K);
        if (value instanceof Number number) {
            sketch.update(number.doubleValue());
        } else {
            sketch.update(value.toString());
        }
        return Base64.getEncoder().encodeToString(sketch.toCompactByteArray());
    }

    private static String quantilesOf(double value) {
        KllDoublesSketch sketch = KllDoublesSketch.newHeapInstance(QUANTILE_K);
        sketch.update(value);
        return Base64.getEncoder().encodeToString(sketch.toByteArray());
    }

    private static String unionDistinct(String left, String right) {
        if (left == null) return right;
        if (right == null) return left;
        Union union = new Union(DISTINCT_LG_K);
        union.update(distinctSketch(left));
        union.update(distinctSketch(right));
        return Base64.getEncoder().encodeToString(union.getResult().toCompactByteArray());
    }

    private static String mergeQuantiles(String left, String right) {
        if (left == null) return right;
        if (right == null) return left;
        KllDoublesSketch merged = KllDoublesSketch.newHeapInstance(QUANTILE_K);
        merged.merge(quantileSketch(left));
        merged.merge(quantileSketch(right));
        return Base64.getEncoder().encodeToString(merged.toByteArray());
    }

    /**
     * The two newest among both lists, oldest first. On equal event times, the
     * occurrence whose event id sorts last is the newer.
     */
    public static List<Newest> newestTwo(List<Newest> left, List<Newest> right) {
        if (left == null) return right;
        if (right == null) return left;
        List<Newest> all = new ArrayList<>(left);
        right.stream().filter(item -> !all.contains(item)).forEach(all::add);
        all.sort(OLDEST_FIRST);
        return List.copyOf(all.subList(Math.max(0, all.size() - 2), all.size()));
    }

    private static Double add(Double left, Double right) {
        if (left == null) return right;
        return right == null ? left : left + right;
    }

    private static Long add(Long left, Long right) {
        if (left == null) return right;
        return right == null ? left : left + right;
    }

    private static Double least(Double left, Double right) {
        if (left == null) return right;
        return right == null ? left : Math.min(left, right);
    }

    private static Double greatest(Double left, Double right) {
        if (left == null) return right;
        return right == null ? left : Math.max(left, right);
    }
}
