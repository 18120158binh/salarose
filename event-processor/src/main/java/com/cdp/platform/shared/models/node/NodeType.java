package com.cdp.platform.shared.models.node;

import java.util.Optional;

import com.cdp.platform.shared.utils.ParseResult;

import com.fasterxml.jackson.annotation.JsonProperty;

public enum NodeType {
    @JsonProperty("setup")
    setup, @JsonProperty("check")
    check, @JsonProperty("watch")
    watch, @JsonProperty("segment")
    segment, // A check on metrics only
    @JsonProperty("engagement")
    engagement, @JsonProperty("end")
    end;

    public static ParseResult<NodeType> fromValue(String value) {
        if (value == null || value.isBlank()) {
            return ParseResult.failure(new IllegalArgumentException("Campaign node type is required"));
        }
        try {
            return ParseResult.success(NodeType.valueOf(value.trim()));
        } catch (IllegalArgumentException exception) {
            return ParseResult
                .failure(new IllegalArgumentException("Unsupported campaign node type: " + value, exception));
        }
    }

    /**
     * Whether the node moves on an event, so that customer decision needs its
     * trigger.
     */
    public boolean needsTrigger() {
        return this == setup || this == check || this == watch;
    }

    /**
     * The branch that a trigger from customer decision completes this node on.
     * Empty for nodes that complete when their parent does. When a check takes
     * {@code no} is an open question in the contract, so no node type triggers
     * it. A segment fires {@code yes} when its metric condition holds, and
     * never {@code no}.
     */
    public Optional<Branch> triggerBranch() {
        return switch (this) {
            case setup -> Optional.of(Branch.next);
            case check, segment -> Optional.of(Branch.yes);
            case watch -> Optional.of(Branch.success);
            case engagement, end -> Optional.empty();
        };
    }
}
