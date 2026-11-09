package com.cdp.platform.shared.models;

import org.apache.flink.types.Row;

import com.cdp.platform.shared.utils.ParseResult;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonUnwrapped;

/**
 * A trigger as the trigger topic carries it: the trigger's fields, the version
 * of the campaign graph it was decided against, and the entry it is for, in
 * one flat JSON object. The version is null for a trigger written before
 * producers set it.
 *
 * <p>
 * The entry id names one entry of the journey key. A setup trigger without one
 * is for the entry {@value #FIRST_ENTRY}. Any other trigger without one applies
 * to each of the journey key's entries. A watch timeout carries the entry of
 * the transition that started its watch.
 *
 * <p>
 * The version is kept beside {@link JourneyTriggerEvent} rather than in it,
 * because the state machine's buffer from before the version holds that record
 * through Kryo, which cannot read it once it gains a field. The entry id sits
 * next to the version.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record VersionedTrigger(
    @JsonUnwrapped JourneyTriggerEvent trigger,
    @JsonProperty("graph_version") Long graphVersion,
    @JsonProperty("entry_id") String entryId) {

    /** The entry of a setup trigger that names none, such as a person event's. */
    public static final String FIRST_ENTRY = "first";

    /** A trigger that names no entry. */
    public VersionedTrigger(JourneyTriggerEvent trigger, Long graphVersion) {
        this(trigger, graphVersion, null);
    }

    /**
     * Parses a trigger decoded from the trigger topic, where a missing field is
     * null. A blank entry id names no entry.
     */
    public static ParseResult<VersionedTrigger> parse(Row row) {
        ParseResult<JourneyTriggerEvent> trigger = JourneyTriggerEvent.parse(row);
        if (!trigger.isValid()) {
            return ParseResult.failure(new IllegalArgumentException(trigger.failureMessage()));
        }
        Long graphVersion = row.getFieldNames(true).contains("graph_version")
            ? (Long) row.getField("graph_version")
            : null;
        String entryId = row.getFieldNames(true).contains("entry_id") ? (String) row.getField("entry_id") : null;
        return ParseResult
            .success(new VersionedTrigger(trigger.valueOrThrow(), graphVersion,
                entryId == null || entryId.isBlank() ? null : entryId));
    }

    public String journeyKey() {
        return trigger.journeyKey();
    }

    public long eventTimestamp() {
        return trigger.eventTimestamp();
    }
}
