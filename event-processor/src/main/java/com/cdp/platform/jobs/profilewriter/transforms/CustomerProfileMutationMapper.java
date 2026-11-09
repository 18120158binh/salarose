package com.cdp.platform.jobs.profilewriter.transforms;

import java.util.Optional;

import org.apache.flink.api.common.functions.FlatMapFunction;
import org.apache.flink.util.Collector;

import com.cdp.platform.shared.models.CustomerProfileMutationEvent;
import com.cdp.platform.shared.models.MetricBucket;
import com.cdp.platform.shared.models.MetricSeries;
import com.cdp.platform.shared.models.db.MetricValueType;
import com.cdp.platform.shared.models.db.UserMetric;
import com.cdp.platform.shared.utils.JacksonMapper;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Decodes a Kafka mutation message into PostgreSQL user metric rows. A message
 * that does not decode, or a row that is not valid, is logged and dropped.
 */
public final class CustomerProfileMutationMapper implements FlatMapFunction<String, UserMetric> {

    private static final Logger LOG = LoggerFactory.getLogger(CustomerProfileMutationMapper.class);

    @Override
    public void flatMap(String json, Collector<UserMetric> output) {
        Optional<CustomerProfileMutationEvent> mutation = decode(json);
        if (mutation.isEmpty()) return;

        for (MetricSeries series : mutation.get().metrics()) {
            parseRow(mutation.get(), series).ifPresent(output::collect);
        }
    }

    private static Optional<CustomerProfileMutationEvent> decode(String json) {
        try {
            CustomerProfileMutationEvent mutation = JacksonMapper.readValue(json, CustomerProfileMutationEvent.class);
            if (mutation == null) throw new IllegalArgumentException("Message is JSON null");
            if (mutation.canonId() == null) throw new IllegalArgumentException("canonId is required");
            if (mutation.behaviorVersion() < 1) throw new IllegalArgumentException("behaviorVersion is required");
            return Optional.of(mutation);
        } catch (IllegalArgumentException exception) {
            Throwable reason = exception.getCause() == null ? exception : exception.getCause();
            LOG.warn("Skipping customer profile mutation that does not decode: {}", reason.getMessage());
            return Optional.empty();
        }
    }

    private static Optional<UserMetric> parseRow(CustomerProfileMutationEvent mutation, MetricSeries series) {
        try {
            return Optional.of(toUserMetric(mutation, series));
        } catch (IllegalArgumentException exception) {
            LOG
                .warn("Skipping metric {} of mutation {} for canonId={}: {}", series.metricId(), mutation.eventId(),
                    mutation.canonId(), exception.getMessage());
            return Optional.empty();
        }
    }

    private static UserMetric toUserMetric(CustomerProfileMutationEvent mutation, MetricSeries series) {
        if (series.metricId() == null) throw new IllegalArgumentException("metricId is required");
        MetricValueType.parse(series.valueType()).valueOrThrow();
        for (MetricBucket bucket : series.buckets()) {
            if (bucket == null || bucket.size() == null) throw new IllegalArgumentException("A bucket has no size");
            if (bucket.count() < 1) throw new IllegalArgumentException("A bucket has no occurrence");
        }
        return new UserMetric(mutation.canonId(), series.metricId(), series.seriesClock(), series.buckets(),
            mutation.behaviorVersion());
    }
}
