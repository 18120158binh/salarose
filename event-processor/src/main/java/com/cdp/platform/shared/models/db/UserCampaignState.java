package com.cdp.platform.shared.models.db;

import java.util.List;

import com.cdp.platform.shared.models.node.NodeType;

/**
 * One completed journey node: a row of {@code user_campaign_state_transitions}.
 * The branch is a {@code Branch} name or a multi-branch key. The watch children
 * are the watch nodes that hang off the completed branch, for the timer flow.
 * The entry id names the journey key's entry the node completed in.
 */
public record UserCampaignState(
    String canonId,
    String domainUserId,
    String networkUserId,
    String userId,
    String campaignId,
    String entryId,
    String nodeId,
    String branch,
    long eventTimestamp,
    NodeType nodeType,
    String actionJson,
    String contextJson,
    List<WatchChild> watchChildren,
    String eventId) {
}
