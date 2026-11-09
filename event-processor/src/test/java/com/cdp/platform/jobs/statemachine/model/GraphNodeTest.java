package com.cdp.platform.jobs.statemachine.model;

import java.util.List;
import java.util.Optional;

import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;

import com.cdp.platform.jobs.statemachine.model.GraphNode.Watch;
import com.cdp.platform.shared.models.node.Branch;
import com.cdp.platform.shared.models.node.NodeType;
import com.cdp.platform.shared.models.node.WatchLimit;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

/**
 * A {@code campaign_nodes} row becomes a graph node once, when it loads. A
 * watch's limit and the branch its deadline completes it on are parsed then,
 * and a row that does not parse is not loaded.
 */
class GraphNodeTest {

    private static final String CART_WATCH = """
        {"path_type":"SuccessOrTimeoutPath","limit":{"value":15,"unit":"minutes"}}""";

    @Test
    void aWatchLoadsWithItsLimitAndTimesOutOnTimeout() {
        assertEquals(
            Optional
                .of(new GraphNode("n3_cart", NodeType.watch, "n2_vip", "yes", null,
                    new Watch(new WatchLimit(15 * 60_000L), Branch.timeout))),
            GraphNode.fromRow(row("n3_cart", "watch", "n2_vip", "yes", CART_WATCH)));
    }

    @Test
    void aDelayMovesOnOnNextAtItsDeadline() {
        Optional<GraphNode> delay = GraphNode
            .fromRow(row("n3_wait", "watch", "n2_vip", "yes",
                "{\"path_type\":\"DelayPath\",\"limit\":{\"value\":2,\"unit\":\"days\"}}"));

        assertEquals(Optional.of(new Watch(new WatchLimit(2 * 86_400_000L), Branch.next)), delay.map(GraphNode::watch));
    }

    @Test
    void aWatchWithoutALimitWaitsFifteenMinutes() {
        Optional<GraphNode> watch = GraphNode
            .fromRow(row("n3_cart", "watch", "n2_vip", "yes", "{\"path_type\":\"SuccessOrTimeoutPath\"}"));

        assertEquals(Optional.of(WatchLimit.DEFAULT), watch.map(node -> node.watch().limit()));
    }

    @Test
    void onlyAWatchHasAWatch() {
        Optional<GraphNode> engagement = GraphNode.fromRow(row("n5_sms", "engagement", "n4_active", "yes", null));

        assertEquals(Optional.of(NodeType.engagement), engagement.map(GraphNode::nodeType));
        assertEquals(Optional.empty(), engagement.map(GraphNode::watch));
    }

    @Test
    void aRowThatDoesNotParseIsNotLoaded() {
        List<Row> invalid = List
            .of(row("n3_cart", "watch", "n2_vip", "yes",
                "{\"path_type\":\"SuccessOrTimeoutPath\",\"limit\":{\"value\":15,\"unit\":\"weeks\"}}"),
                row("n3_cart", "watch", "n2_vip", "yes", "{not json"),
                row("n9_hook", "webhook", "n2_vip", "yes", null));
        for (Row row : invalid) {
            assertEquals(Optional.empty(), GraphNode.fromRow(row), row.toString());
        }
    }

    private static Row row(String nodeId, String nodeType, String parentNodeId, String parentBranch,
        String pathsJson) {
        Row row = Row.withNames(RowKind.INSERT);
        row.setField("campaign_id", "campaign-1");
        row.setField("node_id", nodeId);
        row.setField("node_type", nodeType);
        row.setField("parent_node_id", parentNodeId);
        row.setField("parent_branch", parentBranch);
        row.setField("trigger_json", null);
        row.setField("conditions_json", null);
        row.setField("paths_json", pathsJson);
        row.setField("action_json", null);
        row.setField("goal_id", null);
        row.setField("graph_version", 1L);
        return row;
    }
}
