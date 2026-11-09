package com.cdp.platform.shared.models.node;

import java.util.Arrays;
import java.util.Locale;
import java.util.Optional;

/**
 * The operators of a comparison on event or profile fields.
 */
public enum FieldOperator {
    GREATER(">"), AT_LEAST(">="), LESS("<"), AT_MOST("<="), EQUALS("="), NOT_EQUALS("!="), LIKE("LIKE"), IN("IN");

    private final String symbol;

    FieldOperator(String symbol) {
        this.symbol = symbol;
    }

    /** The operator written as {@code symbol} in any case, or empty. */
    public static Optional<FieldOperator> of(String symbol) {
        if (symbol == null) return Optional.empty();
        String upperCase = symbol.toUpperCase(Locale.ROOT);
        return Arrays.stream(values()).filter(operator -> operator.symbol.equals(upperCase)).findFirst();
    }
}
