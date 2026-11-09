package com.cdp.platform.shared.models.node;

import java.util.List;

import com.cdp.platform.shared.utils.ParseResult;

/**
 * A metric condition with each comparison parsed to typed values.
 */
public sealed interface MetricPredicate permits MetricPredicate.All, MetricPredicate.Any, MetricComparison {

    /** Passes when every expression passes, so an empty one passes. */
    record All(List<MetricPredicate> expressions) implements MetricPredicate {
    }

    /** Passes when one expression passes, so an empty one fails. */
    record Any(List<MetricPredicate> expressions) implements MetricPredicate {
    }

    /**
     * Parses a metric condition tree. Fails when a comparison has no metric id, an
     * operator that is not a {@link MetricOperator}, a threshold that is not a
     * finite number, or a window that is not positive or has an unknown unit.
     */
    static ParseResult<MetricPredicate> parse(Predicate predicate) {
        try {
            return ParseResult.success(of(predicate));
        } catch (IllegalArgumentException invalid) {
            return ParseResult.failure(invalid);
        }
    }

    private static MetricPredicate of(Predicate predicate) {
        return switch (predicate) {
            case null -> throw new IllegalArgumentException("Metric condition has an empty expression");
            case And(var expressions) -> new All(of(expressions));
            case Or(var expressions) -> new Any(of(expressions));
            case Not ignored -> throw new IllegalArgumentException("Metric condition cannot negate");
            case Comparison comparison -> MetricComparison.of(comparison);
        };
    }

    // A rule restored from state may predate the parse-time check on groups, so a
    // group without expressions reads as empty.
    private static List<MetricPredicate> of(List<Predicate> expressions) {
        return expressions == null ? List.of() : expressions.stream().map(MetricPredicate::of).toList();
    }
}
