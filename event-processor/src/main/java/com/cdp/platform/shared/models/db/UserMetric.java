package com.cdp.platform.shared.models.db;

import java.util.List;

import com.cdp.platform.shared.models.MetricBucket;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Domain record representing a row in the user_metrics table.
 */
public record UserMetric(
    @JsonProperty("canonId") String canonId,
    @JsonProperty("metricId") String metricId,
    @JsonProperty("seriesClock") long seriesClock,
    @JsonProperty("buckets") List<MetricBucket> buckets,
    @JsonProperty("lastBehaviorVersion") long lastBehaviorVersion) {

    public UserMetric {
        buckets = buckets == null ? List.of() : List.copyOf(buckets);
    }
}
