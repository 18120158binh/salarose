package com.cdp.platform.shared.models;

import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import com.cdp.platform.shared.models.MetricBucket.Size;
import com.cdp.platform.shared.models.db.UserMetric;
import com.cdp.platform.shared.models.node.MetricFunction;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * A person's buckets for one metric, within the retention period, oldest
 * first. The series clock is the newest event time counted in the series.
 * Bucket sizes are measured back from it: a minute while its start is less
 * than 2 hours before the clock, an hour while less than 8 days, and a day
 * after that. The buckets depend only on which occurrences were counted, not
 * on the order they arrived in.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public record MetricSeries(
    @JsonProperty("metricId") String metricId,
    @JsonProperty("valueType") String valueType,
    @JsonProperty("seriesClock") long seriesClock,
    @JsonProperty("buckets") List<MetricBucket> buckets) {

    static final long MINUTE_LIMIT_MS = 2 * Size.HOUR.millis();
    static final long HOUR_LIMIT_MS = 8 * Size.DAY.millis();

    public MetricSeries {
        buckets = buckets == null ? List.of() : List.copyOf(buckets);
    }

    public static MetricSeries empty(String metricId, String valueType) {
        return new MetricSeries(metricId, valueType, Long.MIN_VALUE, List.of());
    }

    /**
     * The series with the occurrence counted in its bucket, or null when the
     * occurrence is older than the retention period plus the out-of-orderness
     * allowance, measured back from the series clock.
     */
    public MetricSeries add(String eventId, long eventTime, Object value, MetricFunction function, long retentionMs,
        long allowedOutOfOrdernessMs) {
        long clock = buckets.isEmpty() ? eventTime : Math.max(seriesClock, eventTime);
        long cutoff = clock - retentionMs - allowedOutOfOrdernessMs;
        Size size = sizeFor(eventTime, clock);
        MetricBucket occurrence = MetricBucket.of(size, size.startOf(eventTime), eventId, eventTime, value, function);
        if (occurrence.end() < cutoff) return null;

        Map<BucketKey, MetricBucket> merged = new TreeMap<>();
        put(merged, occurrence, clock);
        for (MetricBucket bucket : buckets) {
            put(merged, bucket, clock);
        }
        // The map's keys sort the buckets oldest first.
        List<MetricBucket> kept = merged.values().stream().filter(bucket -> bucket.end() >= cutoff).toList();
        return new MetricSeries(metricId, valueType, clock, kept);
    }

    /**
     * The smallest bucket size whose start, for the bucket that holds the time,
     * is close enough to the clock.
     */
    static Size sizeFor(long time, long clock) {
        if (clock - Size.MINUTE.startOf(time) < MINUTE_LIMIT_MS) return Size.MINUTE;
        if (clock - Size.HOUR.startOf(time) < HOUR_LIMIT_MS) return Size.HOUR;
        return Size.DAY;
    }

    /** Adds the bucket, grown to the size it has under the clock, to the map. */
    private static void put(Map<BucketKey, MetricBucket> merged, MetricBucket bucket, long clock) {
        Size target = sizeFor(bucket.start(), clock);
        if (target.compareTo(bucket.size()) < 0) target = bucket.size();
        long start = target.startOf(bucket.start());
        BucketKey key = new BucketKey(start, target);
        MetricBucket existing = merged.get(key);
        merged.put(key, existing == null ? bucket.resized(target, start) : existing.merge(bucket, target, start));
    }

    public static MetricSeries fromUserMetric(UserMetric metric, String valueType) {
        return new MetricSeries(metric.metricId(), valueType, metric.seriesClock(), metric.buckets());
    }

    private record BucketKey(long start, Size size) implements Comparable<BucketKey> {
        @Override
        public int compareTo(BucketKey other) {
            int byStart = Long.compare(start, other.start);
            return byStart != 0 ? byStart : size.compareTo(other.size);
        }
    }
}
