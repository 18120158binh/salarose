package com.cdp.platform.shared.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * One message on {@code segment-membership-changes}: a person entered or
 * exited a segment at the time of the event that changed it.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record SegmentMembershipChange(
    @JsonProperty("canon_id") String canonId,
    @JsonProperty("segment_id") String segmentId,
    @JsonProperty("change") Change change,
    @JsonProperty("event_id") String eventId,
    @JsonProperty("event_time") Long eventTime) {

    /** The direction of a change, as the message spells it. */
    public enum Change {
        @JsonProperty("entered")
        ENTERED, @JsonProperty("exited")
        EXITED
    }

    public boolean entered() {
        return change == Change.ENTERED;
    }
}
