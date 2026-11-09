package com.cdp.platform.shared.models;

import java.util.Optional;

import org.apache.flink.table.api.DataTypes;
import org.apache.flink.table.api.Schema;
import org.apache.flink.types.Row;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Kafka contract from the journey state machine to customer decision: a person
 * reached a segment node because its parent completed. The event id, name, and
 * time are those of the trigger that completed the parent, so customer decision
 * evaluates the segment as of that moment.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record SegmentCheck(
    @JsonProperty("schema_version") int schemaVersion,
    @JsonProperty("event_id") String eventId,
    @JsonProperty("canon_id") String canonId,
    @JsonProperty("domain_userid") String domainUserId,
    @JsonProperty("network_userid") String networkUserId,
    @JsonProperty("user_id") String userId,
    @JsonProperty("campaign_id") String campaignId,
    @JsonProperty("node_id") String nodeId,
    @JsonProperty("event_name") String eventName,
    @JsonProperty("event_time") long eventTimestamp) {

    public static final int SCHEMA_VERSION = 1;
    private static final Logger LOG = LoggerFactory.getLogger(SegmentCheck.class);

    /**
     * Parses a message read from Kafka. A message without a person, a campaign, a
     * node, or an event time is logged and dropped.
     */
    public static Optional<SegmentCheck> fromRow(Row row) {
        String canonId = row.getFieldAs("canon_id");
        String campaignId = row.getFieldAs("campaign_id");
        String nodeId = row.getFieldAs("node_id");
        Long eventTimestamp = row.getFieldAs("event_time");
        if (isBlank(canonId) || isBlank(campaignId) || isBlank(nodeId) || eventTimestamp == null) {
            LOG
                .warn("Ignoring segment check {}:{}:{} without a person, campaign, node, or event time", canonId,
                    campaignId, nodeId);
            return Optional.empty();
        }
        Integer schemaVersion = row.getFieldAs("schema_version");
        return Optional
            .of(new SegmentCheck(schemaVersion == null ? SCHEMA_VERSION : schemaVersion, row.getFieldAs("event_id"),
                canonId, row.getFieldAs("domain_userid"), row.getFieldAs("network_userid"), row.getFieldAs("user_id"),
                campaignId, nodeId, row.getFieldAs("event_name"), eventTimestamp));
    }

    public static Schema schema() {
        return Schema
            .newBuilder()
            .column("schema_version", DataTypes.INT())
            .column("event_id", DataTypes.STRING())
            .column("canon_id", DataTypes.STRING())
            .column("domain_userid", DataTypes.STRING())
            .column("network_userid", DataTypes.STRING())
            .column("user_id", DataTypes.STRING())
            .column("campaign_id", DataTypes.STRING())
            .column("node_id", DataTypes.STRING())
            .column("event_name", DataTypes.STRING())
            .column("event_time", DataTypes.BIGINT())
            .build();
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }
}
