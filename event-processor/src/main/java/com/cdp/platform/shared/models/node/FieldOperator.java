package com.cdp.platform.shared.models.node;

import java.util.Arrays;
import java.util.Locale;
import java.util.Optional;

/**
 * The operators of a comparison on event or profile fields.
 */
public enum FieldOperator {
    GREATER(">"), AT_LEAST(">="), LESS("<"), AT_MOST("<="), EQUALS("="), NOT_EQUALS("!="), LIKE("LIKE"), IN(
        "IN"), MORE_THAN_DAYS_AGO("MORE_THAN_DAYS_AGO"), WITHIN_LAST_DAYS("WITHIN_LAST_DAYS");

    private final String symbol;

    FieldOperator(String symbol) {
        this.symbol = symbol;
    }

    /**
     * Whether the operator compares a datetime with the check time, and so takes
     * a whole number of days as its value (DEC-FR-42).
     */
    public boolean isRelativeDate() {
        return this == MORE_THAN_DAYS_AGO || this == WITHIN_LAST_DAYS;
    }

    /** The operator written as {@code symbol} in any case, or empty. */
    public static Optional<FieldOperator> of(String symbol) {
        if (symbol == null) return Optional.empty();
        String upperCase = symbol.toUpperCase(Locale.ROOT);
        return Arrays.stream(values()).filter(operator -> operator.symbol.equals(upperCase)).findFirst();
    }
}
