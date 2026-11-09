package com.cdp.platform.shared.models;

import java.util.List;

import org.apache.flink.table.api.DataTypes;
import org.apache.flink.table.api.Schema;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Kafka contract describing the customer metric series changed by one event.
 * Each metric carries its whole series, so a consumer can replace the stored
 * one. Its records ignore fields they do not know, so the producer can add a
 * field before the consumers are upgraded.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public record CustomerProfileMutationEvent(
    @JsonProperty("schemaVersion") int schemaVersion,
    @JsonProperty("canonId") String canonId,
    @JsonProperty("behaviorVersion") long behaviorVersion,
    @JsonProperty("eventId") String eventId,
    @JsonProperty("eventTime") long eventTime,
    @JsonProperty("metrics") List<MetricSeries> metrics) {

    /**
     * The largest mutation the producer, the profile writer, and the topic
     * accept: 8 MiB. A series at the bucket limit with full quantile summaries
     * is about 2.34 MB, 2,342,873 bytes as measured, and one event can change
     * several series.
     */
    public static final int MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

    public CustomerProfileMutationEvent {
        metrics = metrics == null ? List.of() : List.copyOf(metrics);
    }

    public static Schema schema() {
        return Schema
            .newBuilder()
            .column("canon_id", DataTypes.STRING())
            .column("payload", DataTypes.STRING())
            .columnByMetadata("kafka_timestamp", DataTypes.TIMESTAMP_LTZ(3), "timestamp", false)
            .build();
    }
}
