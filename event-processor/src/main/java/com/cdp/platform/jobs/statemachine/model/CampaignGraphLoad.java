package com.cdp.platform.jobs.statemachine.model;

import java.util.HashSet;
import java.util.Optional;

/**
 * The node rows of one campaign that arrived since its graph last went live.
 * Studio saves a campaign by deleting every node row and inserting each one
 * again, and CDC delivers the rows one at a time, so they wait here until the
 * whole save has arrived. The node ids include rows that were not loaded, such
 * as a watch whose limit is invalid, since every row counts toward its save.
 */
public class CampaignGraphLoad {

    public CampaignGraph graph = new CampaignGraph();
    public HashSet<String> nodeIds = new HashSet<>();

    public CampaignGraphLoad() {
    }

    private CampaignGraphLoad(CampaignGraph graph, HashSet<String> nodeIds) {
        this.graph = graph;
        this.nodeIds = nodeIds;
    }

    /**
     * Starts from the live graph. A save deletes every row before it inserts
     * any, so a save starts from nothing. A save that the previous version of
     * the engine had partly applied when it was upgraded, or a row inserted by
     * hand, applies on top of what is live.
     */
    public static CampaignGraphLoad startingFrom(CampaignGraph live) {
        return live == null ? new CampaignGraphLoad() : new CampaignGraphLoad(live, new HashSet<>(live.nodeIds()));
    }

    /**
     * Adds an inserted row of the save with this graph version. An empty node is
     * a row that was not loaded.
     */
    public CampaignGraphLoad insert(String nodeId, Optional<GraphNode> node, long graphVersion) {
        HashSet<String> ids = new HashSet<>(nodeIds);
        ids.add(nodeId);
        return new CampaignGraphLoad(
            node.map(graph::upsert).orElseGet(() -> graph.remove(nodeId)).withRowOf(graphVersion), ids);
    }

    /** Whether every row of a save with this many nodes has arrived. */
    public boolean holdsSaveOf(int campaignNodeCount) {
        return nodeIds.size() >= campaignNodeCount;
    }
}
