package com.cdp.platform.shared.models;

import com.cdp.platform.shared.models.node.Channel;
import com.cdp.platform.shared.models.node.EngagementAction;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonRawValue;

/**
 * Domain record representing an outbound campaign notification event payload.
 * Null fields are left out at every level. The context is the transition's
 * JSON object, published as is.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record NotificationEvent(
    @JsonProperty("schema_version") String schemaVersion,
    @JsonProperty("metadata") Metadata metadata,
    @JsonProperty("channel") Channel channel,
    @JsonProperty("content") EngagementAction.Content content,
    @JsonProperty("profile") Profile profile,
    @JsonProperty("context") @JsonRawValue String context) {

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Metadata(
        @JsonProperty("campaign_id") String campaignId,
        @JsonProperty("node_id") String nodeId,
        @JsonProperty("execution_id") String executionId,
        @JsonProperty("generated_at") String generatedAt) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Profile(
        @JsonProperty("user_id") String userId,
        @JsonProperty("domain_user_id") String domainUserId,
        @JsonProperty("customer_name") String customerName,
        @JsonProperty("first_name") String firstName,
        @JsonProperty("pronoun") String pronoun,
        @JsonProperty("gender") String gender,
        @JsonProperty("phone") String phone,
        @JsonProperty("email") String email) {
    }
}
