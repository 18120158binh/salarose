package com.cdp.platform.jobs.businessfanout;

import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import com.cdp.platform.shared.models.MetricBucket.Size;

/**
 * One person's interest in one item: counts of interest events in buckets, the
 * time of the newest interest event, and the time of the newest exclusion
 * event. Buckets follow the tiers of customer decision's series: a minute while
 * its start is less than 2 hours before the newest interest event, an hour
 * while less than 8 days, and a day after that.
 */
public record InterestEntry(List<Bucket> buckets, long newestInterest, long newestExclusion) {

    static final InterestEntry EMPTY = new InterestEntry(List.of(), Long.MIN_VALUE, Long.MIN_VALUE);

    private static final long MINUTE_LIMIT_MS = 2 * Size.HOUR.millis();
    private static final long HOUR_LIMIT_MS = 8 * Size.DAY.millis();

    /** The number of interest events in one bucket. */
    public record Bucket(long start, Size size, int count) {

        long end() {
            return start + size.millis();
        }
    }

    public InterestEntry {
        buckets = buckets == null ? List.of() : List.copyOf(buckets);
    }

    /**
     * The entry with one more interest event, dropping buckets that ended before
     * the retention period, measured back from the newest interest event.
     */
    InterestEntry withInterest(long time, long retentionMs) {
        long clock = Math.max(newestInterest, time);
        Map<Bucket, Integer> merged = new TreeMap<>(
            (left, right) -> left.start != right.start
                ? Long.compare(left.start, right.start)
                : left.size.compareTo(right.size));
        put(merged, time, Size.MINUTE, 1, clock);
        for (Bucket bucket : buckets) {
            put(merged, bucket.start(), bucket.size(), bucket.count(), clock);
        }
        long cutoff = clock - retentionMs;
        List<Bucket> kept = merged
            .entrySet()
            .stream()
            .map(entry -> new Bucket(entry.getKey().start(), entry.getKey().size(), entry.getValue()))
            .filter(bucket -> bucket.end() > cutoff)
            .toList();
        return new InterestEntry(kept, clock, newestExclusion);
    }

    InterestEntry withExclusion(long time) {
        return new InterestEntry(buckets, newestInterest, Math.max(newestExclusion, time));
    }

    /**
     * The interest events in the window {@code (t - W, t]}. A bucket counts when
     * any part of it is inside, as in customer decision.
     */
    int countIn(long time, long windowMs) {
        long windowStart = time - windowMs;
        return buckets
            .stream()
            .filter(bucket -> bucket.end() > windowStart && bucket.start() <= time)
            .mapToInt(Bucket::count)
            .sum();
    }

    /** Whether the newest exclusion event lies in the window {@code (t - W, t]}. */
    boolean excludedIn(long time, long windowMs) {
        return newestExclusion > time - windowMs && newestExclusion <= time;
    }

    /** The newest event of either kind, which decides when the entry expires. */
    long newestActivity() {
        return Math.max(newestInterest, newestExclusion);
    }

    private static void put(Map<Bucket, Integer> merged, long time, Size smallest, int count, long clock) {
        Size size = sizeFor(time, clock);
        if (size.compareTo(smallest) < 0) size = smallest;
        merged.merge(new Bucket(size.startOf(time), size, 0), count, Integer::sum);
    }

    private static Size sizeFor(long time, long clock) {
        if (clock - Size.MINUTE.startOf(time) < MINUTE_LIMIT_MS) return Size.MINUTE;
        if (clock - Size.HOUR.startOf(time) < HOUR_LIMIT_MS) return Size.HOUR;
        return Size.DAY;
    }
}
