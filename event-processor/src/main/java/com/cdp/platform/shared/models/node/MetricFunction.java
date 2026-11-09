package com.cdp.platform.shared.models.node;

import java.util.Locale;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Metric aggregation function types used in campaign comparison predicates.
 */
public enum MetricFunction {
    @JsonProperty("COUNT")
    COUNT, @JsonProperty("SUM")
    SUM, @JsonProperty("AVG")
    AVG, @JsonProperty("MIN")
    MIN, @JsonProperty("MAX")
    MAX, @JsonProperty("MEDIAN")
    MEDIAN, @JsonProperty("DISTINCT_COUNT")
    DISTINCT_COUNT, @JsonProperty("PRICE_DROP")
    PRICE_DROP, @JsonProperty("DIFF")
    DIFF, @JsonProperty("INACTION")
    INACTION, @JsonProperty("LATEST")
    LATEST;

    @JsonCreator
    public static MetricFunction fromString(String value) {
        if (value == null || value.isBlank()) return COUNT;
        try {
            return valueOf(value.trim().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            return COUNT;
        }
    }
}
