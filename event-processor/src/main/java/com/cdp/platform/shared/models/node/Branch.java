package com.cdp.platform.shared.models.node;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * The outcome a node completes on. Each name equals the {@code parent_branch}
 * the journey builder saves for the children that follow that outcome. A
 * multi-branch check completes on its own branch keys instead.
 */
public enum Branch {
    @JsonProperty("yes")
    yes, @JsonProperty("no")
    no, @JsonProperty("next")
    next, @JsonProperty("success")
    success, @JsonProperty("timeout")
    timeout
}
