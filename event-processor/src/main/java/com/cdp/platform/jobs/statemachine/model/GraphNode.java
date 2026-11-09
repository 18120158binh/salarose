package com.cdp.platform.jobs.statemachine.model;

import java.util.Optional;

import org.apache.flink.types.Row;

import com.cdp.platform.shared.db.repositories.CampaignNodesTable;
import com.cdp.platform.shared.models.db.CampaignNode;
import com.cdp.platform.shared.models.node.Branch;
import com.cdp.platform.shared.models.node.NodeType;
import com.cdp.platform.shared.models.node.WatchLimit;
import com.cdp.platform.shared.utils.ParseResult;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * One node of a campaign graph, as the state machine needs it. The parent
 * branch stays text, because a multi-branch check names its branches with
 * keys of its own. Only a watch has a {@link Watch}.
 */
public record GraphNode(String nodeId, NodeType nodeType, String parentNodeId, String parentBranch,
    String actionJson, Watch watch) {

    private static final Logger LOG = LoggerFactory.getLogger(GraphNode.class);

    /**
     * How long a watch waits for its event, and the branch its deadline
     * completes it on: {@code next} for a {@code DelayPath} watch, which only
     * waits, and {@code timeout} for every other watch.
     */
    public record Watch(WatchLimit limit, Branch deadlineBranch) {
    }

    /**
     * Parses a {@code campaign_nodes} row. A row that does not parse as a
     * campaign node, or a watch whose limit is invalid, is logged and dropped,
     * so it is not loaded and a watch gets no timer.
     */
    public static Optional<GraphNode> fromRow(Row row) {
        ParseResult<CampaignNode> parsed = CampaignNode.fromRow(row);
        if (!parsed.isValid()) {
            LOG
                .warn("Ignoring campaign node {}:{}: {}", row.getField(CampaignNodesTable.CAMPAIGN_ID),
                    row.getField(CampaignNodesTable.NODE_ID), parsed.failureMessage());
            return Optional.empty();
        }
        CampaignNode node = parsed.valueOrThrow();
        Watch watch = null;
        if (node.nodeType() == NodeType.watch) {
            ParseResult<WatchLimit> limit = WatchLimit
                .fromPaths((String) row.getField(CampaignNodesTable.PATHS_JSON));
            if (!limit.isValid()) {
                LOG
                    .warn("Ignoring watch node {}:{}: {}", node.campaignId(), node.nodeId(),
                        limit.failureMessage());
                return Optional.empty();
            }
            watch = new Watch(limit.valueOrThrow(),
                node.isDelay() ? Branch.next : Branch.timeout);
        }
        return Optional
            .of(new GraphNode(node.nodeId(), node.nodeType(), node.parentNodeId(), node.parentBranch(),
                node.actionJson(), watch));
    }
}
