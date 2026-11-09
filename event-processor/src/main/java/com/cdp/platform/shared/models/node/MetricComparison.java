package com.cdp.platform.shared.models.node;

import java.time.Duration;
import java.util.Arrays;
import java.util.Optional;

/**
 * One comparison of a metric condition: the value of {@code function} over the
 * occurrences of metric {@code metricId} in the window, compared with
 * {@code threshold}. With no window, every occurrence counts. A window is a
 * positive number of {@link TimeWindow.Unit}s.
 */
public record MetricComparison(
    String metricId,
    MetricFunction function,
    MetricOperator operator,
    double threshold,
    Optional<Duration> window) implements MetricPredicate {

    static MetricComparison of(Comparison comparison) {
        String metricId = comparison.left();
        if (metricId == null || metricId.isBlank()) {
            throw new IllegalArgumentException("Metric comparison has no metric id");
        }
        return new MetricComparison(
            metricId,
            comparison.function() == null ? MetricFunction.COUNT : comparison.function(),
            operator(metricId, comparison.op()),
            threshold(metricId, comparison.right()),
            window(metricId, comparison.window()));
    }

    private static MetricOperator operator(String metricId, String op) {
        if (op == null || op.isBlank()) return MetricOperator.AT_LEAST;
        return MetricOperator
            .of(op)
            .orElseThrow(() -> new IllegalArgumentException(
                "Metric comparison on %s has unknown operator %s".formatted(metricId, op)));
    }

    private static double threshold(String metricId, String right) {
        if (right != null) {
            try {
                double threshold = Double.parseDouble(right);
                if (Double.isFinite(threshold)) return threshold;
            } catch (NumberFormatException notANumber) {
                // Reported below, like a missing or infinite threshold.
            }
        }
        throw new IllegalArgumentException(
            "Metric comparison on %s has threshold %s, which is not a finite number".formatted(metricId, right));
    }

    private static Optional<Duration> window(String metricId, TimeWindow window) {
        if (window == null) return Optional.empty();
        if (window.value() <= 0) {
            throw new IllegalArgumentException(
                "Metric comparison on %s has window %d %s, which is not positive"
                    .formatted(metricId, window.value(), window.unit()));
        }
        TimeWindow.Unit unit = TimeWindow.Unit
            .of(window.unit())
            .orElseThrow(() -> new IllegalArgumentException(
                "Metric comparison on %s has window unit %s, which is not one of %s"
                    .formatted(metricId, window.unit(), Arrays.toString(TimeWindow.Unit.values()))));
        // A window too long to count in milliseconds holds all history, as it did
        // before units were parsed.
        long millis = window.value() > Long.MAX_VALUE / unit.millis()
            ? Long.MAX_VALUE
            : window.value() * unit.millis();
        return Optional.of(Duration.ofMillis(millis));
    }
}
