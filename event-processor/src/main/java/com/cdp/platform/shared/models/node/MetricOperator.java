package com.cdp.platform.shared.models.node;

import java.util.Arrays;
import java.util.Optional;

/**
 * The operators of a metric comparison. {@code =} and {@code !=} compare with
 * a tolerance of 1e-6.
 */
public enum MetricOperator {
    GREATER(">"), AT_LEAST(">="), LESS("<"), AT_MOST("<="), EQUALS("="), NOT_EQUALS("!=");

    private static final double EQUALITY_TOLERANCE = 1e-6;

    private final String symbol;

    MetricOperator(String symbol) {
        this.symbol = symbol;
    }

    /**
     * The operator written as {@code symbol}, or empty. {@code ==} is {@code =},
     * as rules written before metric operators were parsed may use it.
     */
    public static Optional<MetricOperator> of(String symbol) {
        if ("==".equals(symbol)) return Optional.of(EQUALS);
        return Arrays.stream(values()).filter(operator -> operator.symbol.equals(symbol)).findFirst();
    }

    public boolean test(double value, double threshold) {
        return switch (this) {
            case GREATER -> value > threshold;
            case AT_LEAST -> value >= threshold;
            case LESS -> value < threshold;
            case AT_MOST -> value <= threshold;
            case EQUALS -> Math.abs(value - threshold) < EQUALITY_TOLERANCE;
            case NOT_EQUALS -> Math.abs(value - threshold) >= EQUALITY_TOLERANCE;
        };
    }
}
