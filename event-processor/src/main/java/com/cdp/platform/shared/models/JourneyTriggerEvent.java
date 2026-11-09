package com.cdp.platform.shared.models;

import java.util.ArrayList;
import java.util.List;

import org.apache.flink.types.Row;

import com.cdp.platform.shared.utils.ParseResult;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Kafka contract between campaign evaluation, timers, and the journey state
 * machine.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record JourneyTriggerEvent(
    @JsonProperty("schema_version") int schemaVersion,
    @JsonProperty("event_id") String eventId,
    @JsonProperty("canon_id") String canonId,
    @JsonProperty("domain_userid") String domainUserId,
    @JsonProperty("network_userid") String networkUserId,
    @JsonProperty("user_id") String userId,
    @JsonProperty("campaign_id") String campaignId,
    @JsonProperty("node_id") String nodeId,
    @JsonProperty("branch") String branch,
    @JsonProperty("event_name") String eventName,
    @JsonProperty("event_time") long eventTimestamp,
    @JsonProperty("context_json") String contextJson) {

    public static final String JOURNEY_KEY_SEPARATOR = "\u001f";
    /**
     * The version every producer writes, and that a reader assumes for a message
     * without one. Version 4 added {@code graph_version}, which
     * {@link VersionedTrigger} carries. {@link VersionedTrigger} also carries the
     * optional {@code entry_id}, which a reader of any version treats as absent
     * when it is missing.
     */
    public static final int SCHEMA_VERSION = 4;

    public JourneyTriggerEvent(String canonId, String domainUserId, String networkUserId, String userId,
        String campaignId, String nodeId, String branch, String eventName, long eventTimestamp, String contextJson) {
        this(SCHEMA_VERSION, null, canonId, domainUserId, networkUserId, userId, campaignId, nodeId, branch, eventName,
            eventTimestamp, contextJson);
    }

    /**
     * Parses a trigger decoded from the trigger topic, where a missing field is
     * null. A trigger without {@code canon_id}, {@code campaign_id},
     * {@code node_id}, or an event time cannot apply and fails to parse.
     */
    public static ParseResult<JourneyTriggerEvent> parse(Row row) {
        Long timestamp = longField(row, "event_time");
        if (timestamp == null) {
            timestamp = longField(row, "event_timestamp");
        }
        List<String> missing = new ArrayList<>();
        for (String field : List.of("canon_id", "campaign_id", "node_id")) {
            if (stringField(row, field) == null) missing.add(field);
        }
        if (timestamp == null) missing.add("event_time");
        if (!missing.isEmpty()) {
            return ParseResult.failure(new IllegalArgumentException("trigger without " + String.join(", ", missing)));
        }
        Integer schemaVersion = intField(row, "schema_version");
        return ParseResult
            .success(new JourneyTriggerEvent(
                schemaVersion == null ? SCHEMA_VERSION : schemaVersion,
                stringField(row, "event_id"),
                stringField(row, "canon_id"),
                stringField(row, "domain_userid"),
                stringField(row, "network_userid"),
                stringField(row, "user_id"),
                stringField(row, "campaign_id"),
                stringField(row, "node_id"),
                stringField(row, "branch"),
                stringField(row, "event_name"),
                timestamp,
                stringField(row, "context_json")));
    }

    public String journeyKey() {
        return canonId + JOURNEY_KEY_SEPARATOR + campaignId;
    }

    private static String stringField(Row row, String name) {
        return row.getFieldNames(true).contains(name) ? (String) row.getField(name) : null;
    }

    private static Long longField(Row row, String name) {
        return row.getFieldNames(true).contains(name) ? (Long) row.getField(name) : null;
    }

    private static Integer intField(Row row, String name) {
        return row.getFieldNames(true).contains(name) ? (Integer) row.getField(name) : null;
    }
}
