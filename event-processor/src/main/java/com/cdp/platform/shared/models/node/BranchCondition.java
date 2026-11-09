package com.cdp.platform.shared.models.node;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * One branch of a multi-branch check: its key, its filters on the trigger's
 * event, null when it has none, and its conditions on the person. Every branch
 * whose filters and conditions pass fires.
 */
public record BranchCondition(
    @JsonProperty("key") String branchKey,
    @JsonProperty("condition") Predicate condition,
    @JsonProperty("conditions") PersonConditions conditions) {

    public BranchCondition {
        if (branchKey == null || branchKey.isBlank()) throw new IllegalArgumentException("Branch key is required");
        if (conditions == null) conditions = PersonConditions.NONE;
    }
}
