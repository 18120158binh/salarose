package com.cdp.platform.jobs.customerdecision.transforms;

import java.util.HashMap;
import java.util.Map;
import java.util.OptionalLong;
import java.util.Set;

import com.cdp.platform.shared.db.repositories.UserMetricRepository;
import com.cdp.platform.shared.models.MetricSeries;
import com.cdp.platform.shared.models.db.UserMetric;

/**
 * What one input needs from {@code user_metrics} because the person's state
 * lacks it: the series it updates or its candidate rules reference, by metric
 * id with their value types, and the behavior version when state has none. A
 * value type is null for a series that no definition counts.
 */
record StateMissRead(String canonId, Map<String, String> valueTypes, boolean behaviorVersion) {

    /**
     * Reads the rows. A failed or timed-out read throws, so the event fails
     * instead of counting from an empty series.
     */
    Stored read(UserMetricRepository repository) {
        Map<String, MetricSeries> series = new HashMap<>();
        if (!valueTypes.isEmpty()) {
            for (UserMetric row : repository.findMetrics(canonId, valueTypes.keySet())) {
                series.put(row.metricId(), MetricSeries.fromUserMetric(row, valueTypes.get(row.metricId())));
            }
        }
        valueTypes
            .forEach((metricId, valueType) -> series
                .putIfAbsent(metricId, MetricSeries.empty(metricId, valueType)));
        OptionalLong version = behaviorVersion
            ? OptionalLong.of(repository.findLastBehaviorVersion(canonId))
            : OptionalLong.empty();
        return new Stored(Set.copyOf(valueTypes.keySet()), series, version);
    }

    /**
     * The rows read for a {@link StateMissRead}: each series read, empty when the
     * person has no row for it, and the highest stored behavior version if it was
     * read.
     */
    record Stored(Set<String> readIds, Map<String, MetricSeries> series, OptionalLong behaviorVersion) {

        /** Whether this read answers everything the miss needs. */
        boolean covers(StateMissRead miss) {
            return readIds.containsAll(miss.valueTypes().keySet())
                && (!miss.behaviorVersion() || behaviorVersion.isPresent());
        }
    }
}
