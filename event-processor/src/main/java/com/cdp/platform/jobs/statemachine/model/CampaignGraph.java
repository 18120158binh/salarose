package com.cdp.platform.jobs.statemachine.model;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The graph of one campaign. Each change returns a new graph, so a graph in
 * broadcast state never changes under a reader.
 *
 * <p>
 * Its version is the newest {@code graph_version} among the rows it was built
 * from.
 */
public class CampaignGraph {

    private Map<String, GraphNode> nodes = new HashMap<>();
    private long graphVersion;
    /** Children by parent node and parent branch, built on first use. */
    private transient Map<List<String>, List<GraphNode>> childrenByParent;

    public CampaignGraph() {
    }

    private CampaignGraph(Map<String, GraphNode> nodes, long graphVersion) {
        this.nodes = nodes;
        this.graphVersion = graphVersion;
    }

    /**
     * Whether a node hangs off this branch of its parent. The saved format
     * gives every child a parent branch, so a child without one hangs off no
     * branch.
     */
    public static boolean hangsOff(GraphNode node, String parentBranch) {
        return node.parentBranch() != null && node.parentBranch().equals(parentBranch);
    }

    public CampaignGraph upsert(GraphNode node) {
        Map<String, GraphNode> copy = new HashMap<>(nodes);
        copy.put(node.nodeId(), node);
        return new CampaignGraph(copy, graphVersion);
    }

    public CampaignGraph remove(String nodeId) {
        Map<String, GraphNode> copy = new HashMap<>(nodes);
        copy.remove(nodeId);
        return new CampaignGraph(copy, graphVersion);
    }

    /** This graph after a row of the save with this version arrived. */
    public CampaignGraph withRowOf(long rowGraphVersion) {
        return new CampaignGraph(nodes, Math.max(graphVersion, rowGraphVersion));
    }

    public GraphNode node(String nodeId) {
        return nodes.get(nodeId);
    }

    public Set<String> nodeIds() {
        return Collections.unmodifiableSet(nodes.keySet());
    }

    public int size() {
        return nodes.size();
    }

    /** The children that hang off a branch of a node, ordered by node id. */
    public List<GraphNode> children(String parentNodeId, String parentBranch) {
        if (childrenByParent == null) {
            Map<List<String>, List<GraphNode>> index = new HashMap<>();
            for (GraphNode node : nodes.values()) {
                if (node.parentNodeId() != null && hangsOff(node, node.parentBranch())) {
                    index
                        .computeIfAbsent(List.of(node.parentNodeId(), node.parentBranch()), key -> new ArrayList<>())
                        .add(node);
                }
            }
            index.values().forEach(children -> children.sort(Comparator.comparing(GraphNode::nodeId)));
            childrenByParent = index;
        }
        if (parentNodeId == null || parentBranch == null) return List.of();
        return Collections
            .unmodifiableList(childrenByParent
                .getOrDefault(List.of(parentNodeId, parentBranch),
                    List.of()));
    }

    /** For Flink's POJO serializer only. */
    public Map<String, GraphNode> getNodes() {
        return Collections.unmodifiableMap(nodes);
    }

    /** For Flink's POJO serializer only. */
    public void setNodes(Map<String, GraphNode> nodes) {
        this.nodes = nodes;
        this.childrenByParent = null;
    }

    public long getGraphVersion() {
        return graphVersion;
    }

    /** For Flink's POJO serializer only. */
    public void setGraphVersion(long graphVersion) {
        this.graphVersion = graphVersion;
    }
}
