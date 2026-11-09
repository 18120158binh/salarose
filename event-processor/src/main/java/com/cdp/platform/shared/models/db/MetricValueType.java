package com.cdp.platform.shared.models.db;

import java.util.Locale;

import com.cdp.platform.shared.utils.ParseResult;

/**
 * What a metric stores for each occurrence. A presence metric stores no value.
 */
public enum MetricValueType {
    PRESENCE, NUMBER, STRING, BOOLEAN;

    /** The value type named {@code name}, in any case. */
    public static ParseResult<MetricValueType> parse(String name) {
        if (name == null) return ParseResult.failure(new IllegalArgumentException("valueType is required"));
        try {
            return ParseResult.success(valueOf(name.toUpperCase(Locale.ROOT)));
        } catch (IllegalArgumentException unknown) {
            return ParseResult.failure(new IllegalArgumentException("Unknown valueType " + name));
        }
    }
}
