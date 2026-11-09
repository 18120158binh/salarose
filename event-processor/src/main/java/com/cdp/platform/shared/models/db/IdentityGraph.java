package com.cdp.platform.shared.models.db;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Record model representing the identity_graph table schema.
 */
public record IdentityGraph(
    @JsonProperty("domainUserid") String domainUserid,
    @JsonProperty("userId") String userId,
    @JsonProperty("canonId") String canonId) {
}
