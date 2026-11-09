package com.cdp.platform.shared.models.node;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

@JsonIgnoreProperties(ignoreUnknown = true)
public record Comparison(
    @JsonProperty("left") String left,
    @JsonProperty("op") String op,
    @JsonProperty("right") String right,
    @JsonProperty("window") TimeWindow window,
    @JsonProperty("function") MetricFunction function) implements Predicate {

    public Comparison(String left, String op, String right) {
        this(left, op, right, null, (MetricFunction) null);
    }

    public Comparison(String left, String op, String right, TimeWindow window) {
        this(left, op, right, window, (MetricFunction) null);
    }

    public Comparison(String left, String op, String right, TimeWindow window, String function) {
        this(left, op, right, window, MetricFunction.fromString(function));
    }
}
