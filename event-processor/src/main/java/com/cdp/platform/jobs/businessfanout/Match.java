package com.cdp.platform.jobs.businessfanout;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonRawValue;

/**
 * One message on {@code business-event-matches}: one business event concerns
 * one
 * person for one campaign.
 */
public record Match(
    @JsonProperty("schema_version") int schemaVersion,
    @JsonProperty("canon_id") String canonId,
    @JsonProperty("campaign_id") String campaignId,
    @JsonProperty("node_id") String nodeId,
    @JsonProperty("business_event_id") String businessEventId,
    @JsonProperty("business_event_name") String businessEventName,
    @JsonProperty("business_event_time") long businessEventTime,
    @JsonProperty("item_key") String itemKey,
    @JsonProperty("attributes") @JsonRawValue String attributes) {

    static final int SCHEMA_VERSION = 1;

    static Match of(String canonId, IndexInput.Probe probe) {
        BusinessEvent event = probe.event();
        return new Match(SCHEMA_VERSION, canonId, probe.campaignId(), probe.nodeId(), event.eventId(),
            event.eventName(), event.eventTime(), event.itemKey(), event.attributes());
    }
}
