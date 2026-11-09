package com.cdp.platform.jobs.customerdecision.transforms;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.OptionalDouble;

import com.cdp.platform.shared.models.MetricBucket;
import com.cdp.platform.shared.models.MetricSeries;
import com.cdp.platform.shared.models.node.MetricComparison;
import com.cdp.platform.shared.models.node.MetricFunction;
import com.cdp.platform.shared.models.node.MetricPredicate;

import org.apache.datasketches.hll.Union;
import org.apache.datasketches.kll.KllDoublesSketch;

/**
 * Evaluates metric conditions over the buckets of a person's series. A bucket
 * counts in a window when any part of it is inside, so a window's edges are as
 * precise as the buckets that hold them.
 */
public final class MetricsConditionEvaluator {

    /**
     * Evaluates the condition against the person's series by metric id. A series
     * that is absent from the map is an empty series.
     */
    public boolean evaluate(MetricPredicate condition, Map<String, MetricSeries> metricsById,
        long referenceEventTime) {
        return switch (condition) {
            case MetricPredicate.All(var expressions) -> expressions
                .stream()
                .allMatch(expression -> evaluate(expression, metricsById, referenceEventTime));
            case MetricPredicate.Any(var expressions) -> expressions
                .stream()
                .anyMatch(expression -> evaluate(expression, metricsById, referenceEventTime));
            case MetricComparison comparison -> passes(comparison, metricsById.get(comparison.metricId()),
                referenceEventTime);
        };
    }

    private static boolean passes(MetricComparison comparison, MetricSeries metric, long referenceEventTime) {
        OptionalDouble value = value(metric, comparison.function(), comparison.window(), referenceEventTime);
        // Like a comparison with SQL NULL, a comparison with no value fails.
        return value.isPresent() && comparison.operator().test(value.getAsDouble(), comparison.threshold());
    }

    /**
     * The function's value over the buckets in the window {@code (t - W, t]}, or
     * empty when the function has no value: every value function but SUM and
     * DISTINCT_COUNT, when no bucket in the window holds a numeric value. A
     * bucket counts when it ends after {@code t - W} and starts at or before
     * {@code t}.
     */
    static OptionalDouble value(MetricSeries metric, MetricFunction function, Optional<Duration> window,
        long referenceEventTime) {
        List<MetricBucket> buckets = metric == null ? List.of() : metric.buckets();
        long windowStart = window.map(duration -> referenceEventTime - duration.toMillis()).orElse(Long.MIN_VALUE);
        List<MetricBucket> inWindow = buckets
            .stream()
            .filter(bucket -> bucket.end() > windowStart && bucket.start() <= referenceEventTime)
            .toList();

        return switch (function) {
            case COUNT, INACTION -> OptionalDouble.of(inWindow.stream().mapToLong(MetricBucket::count).sum());
            case SUM -> OptionalDouble
                .of(inWindow.stream().map(MetricBucket::sum).filter(Objects::nonNull).mapToDouble(x -> x).sum());
            case AVG -> average(inWindow);
            case MIN -> inWindow.stream().map(MetricBucket::min).filter(Objects::nonNull).mapToDouble(x -> x).min();
            case MAX -> inWindow.stream().map(MetricBucket::max).filter(Objects::nonNull).mapToDouble(x -> x).max();
            case MEDIAN -> median(inWindow);
            case DISTINCT_COUNT -> OptionalDouble.of(distinctCount(inWindow));
            case LATEST -> {
                List<MetricBucket.Newest> newest = newestTwo(inWindow);
                yield newest.isEmpty() ? OptionalDouble.empty() : OptionalDouble.of(newest.getLast().value());
            }
            case PRICE_DROP, DIFF -> {
                List<MetricBucket.Newest> newest = newestTwo(inWindow);
                yield newest.size() < 2
                    ? OptionalDouble.empty()
                    : OptionalDouble.of(newest.get(0).value() - newest.get(1).value());
            }
        };
    }

    private static OptionalDouble average(List<MetricBucket> buckets) {
        double sum = 0;
        long values = 0;
        for (MetricBucket bucket : buckets) {
            if (bucket.sum() == null || bucket.valueCount() == null) continue;
            sum += bucket.sum();
            values += bucket.valueCount();
        }
        return values == 0 ? OptionalDouble.empty() : OptionalDouble.of(sum / values);
    }

    private static OptionalDouble median(List<MetricBucket> buckets) {
        KllDoublesSketch merged = KllDoublesSketch.newHeapInstance(MetricBucket.QUANTILE_K);
        buckets
            .stream()
            .map(MetricBucket::quantiles)
            .filter(Objects::nonNull)
            .forEach(encoded -> merged.merge(MetricBucket.quantileSketch(encoded)));
        if (merged.isEmpty()) return OptionalDouble.empty();
        if (merged.isEstimationMode()) return OptionalDouble.of(merged.getQuantile(0.5));
        // Below k values the sketch holds every value, so the median is exact,
        // with the two middle values averaged for an even count.
        double[] sorted = merged.getSortedView().getQuantiles();
        int middle = sorted.length / 2;
        return OptionalDouble
            .of(sorted.length % 2 == 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2.0);
    }

    private static double distinctCount(List<MetricBucket> buckets) {
        Union union = new Union(MetricBucket.DISTINCT_LG_K);
        buckets
            .stream()
            .map(MetricBucket::distinct)
            .filter(Objects::nonNull)
            .forEach(encoded -> union.update(MetricBucket.distinctSketch(encoded)));
        return union.isEmpty() ? 0 : Math.round(union.getEstimate());
    }

    /** The two newest numeric occurrences among the buckets, oldest first. */
    private static List<MetricBucket.Newest> newestTwo(List<MetricBucket> buckets) {
        List<MetricBucket.Newest> newest = List.of();
        for (MetricBucket bucket : buckets) {
            if (bucket.newest() != null) newest = MetricBucket.newestTwo(newest, bucket.newest());
        }
        return newest;
    }
}
