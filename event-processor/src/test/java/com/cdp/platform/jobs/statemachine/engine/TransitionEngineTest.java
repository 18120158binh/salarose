package com.cdp.platform.jobs.statemachine.engine;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;

import com.cdp.platform.jobs.statemachine.engine.TransitionEngine.Evaluation;
import com.cdp.platform.jobs.statemachine.engine.TransitionEngine.Status;
import com.cdp.platform.jobs.statemachine.model.CampaignGraph;
import com.cdp.platform.jobs.statemachine.model.GraphNode;
import com.cdp.platform.shared.models.Event;
import com.cdp.platform.shared.models.JourneyTriggerEvent;
import com.cdp.platform.shared.models.SegmentCheck;
import com.cdp.platform.shared.models.VersionedTrigger;
import com.cdp.platform.shared.models.db.CampaignNode;
import com.cdp.platform.shared.models.db.UserCampaignState;
import com.cdp.platform.shared.models.db.WatchChild;
import com.cdp.platform.shared.models.node.Branch;
import com.cdp.platform.shared.models.node.WatchLimit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import org.junit.jupiter.api.Test;

/**
 * Runs the worked example of the journey execution contract. Each trigger is
 * what customer decision emits for the saved node row, and the graph is built
 * from the same rows, so the tests hold the branch names to the saved format.
 */
class TransitionEngineTest {

    private static final long T_10_00 = 1_760_346_000_000L;
    private static final long MINUTE = 60_000L;
    private static final String ADD_TO_CART = """
        {"path_type":"SuccessOrTimeoutPath","limit":{"value":15,"unit":"minutes"}}""";
    private static final String PURCHASED_TWICE = """
        {"groups":[{"conditions":[{"type":"behavior","metric_id":"m_purchase_count","event":"purchase",
         "measure":"COUNT","window":{"value":30,"unit":"DAYS"},"op":">=","value":2}]}]}""";

    private static final List<Row> ROWS = List
        .of(
            row("n1_view", "setup", null, null, "view_product"),
            row("n2_vip", "check", "n1_view", "next", "view_vip_page"),
            row("n3_cart", "watch", "n2_vip", "yes", ADD_TO_CART),
            row("n4_active", "check", "n3_cart", "timeout", "open_app"),
            row("n5_sms", "engagement", "n4_active", "yes", null),
            row("n6_end", "end", "n3_cart", "success", null),
            segmentRow("n7_buyer", "n1_view", "next", PURCHASED_TWICE),
            row("n8_push", "engagement", "n7_buyer", "yes", null));

    private final TransitionEngine engine = new TransitionEngine();
    private final CampaignGraph graph = graph();
    private final Map<String, UserCampaignState> completed = new HashMap<>();
    private final List<UserCampaignState> published = new ArrayList<>();

    @Test
    void setupCompletesOnNextAndItsCheckChildFollows() {
        apply(decide("n1_view", "view_product", T_10_00));
        Evaluation check = apply(decide("n2_vip", "view_vip_page", T_10_00 + MINUTE));

        assertEquals(Status.APPLIED, check.status());
        assertEquals(List.of("n1_view/next", "n2_vip/yes"), transitions());
    }

    @Test
    void passingCheckListsItsWatchChildOnYesForATimer() {
        apply(decide("n1_view", "view_product", T_10_00));
        apply(decide("n2_vip", "view_vip_page", T_10_00 + MINUTE));

        UserCampaignState check = completed.get("n2_vip");
        assertNotNull(check, "n2_vip did not complete");
        assertEquals(List.of(new WatchChild("n3_cart", new WatchLimit(15 * MINUTE), Branch.timeout, 1L)),
            check.watchChildren());
    }

    @Test
    void watchSuccessCompletesTheSuccessChild() {
        apply(decide("n1_view", "view_product", T_10_00));
        apply(decide("n2_vip", "view_vip_page", T_10_00 + MINUTE));
        apply(decide("n3_cart", "add_to_cart", T_10_00 + 5 * MINUTE));

        assertEquals(List.of("n1_view/next", "n2_vip/yes", "n3_cart/success", "n6_end/next"), transitions());
    }

    @Test
    void watchTimeoutCompletesTheTimeoutChild() {
        apply(decide("n1_view", "view_product", T_10_00));
        apply(decide("n2_vip", "view_vip_page", T_10_00 + MINUTE));
        apply(trigger("n3_cart", "timeout", T_10_00 + 16 * MINUTE));
        apply(decide("n4_active", "open_app", T_10_00 + 17 * MINUTE));

        assertEquals(List.of("n1_view/next", "n2_vip/yes", "n3_cart/timeout", "n4_active/yes", "n5_sms/next"),
            transitions());
    }

    @Test
    void segmentCompletesOnYesAndItsEngagementChildFollows() {
        apply(decide("n1_view", "view_product", T_10_00));
        Evaluation segment = apply(decide("n7_buyer", "purchase", T_10_00 + MINUTE));

        assertEquals(Status.APPLIED, segment.status());
        assertEquals(List.of("n1_view/next", "n7_buyer/yes", "n8_push/next"), transitions());
    }

    @Test
    void reachingASegmentAsksCustomerDecisionToCheckItAsOfTheParentsCompletion() {
        JourneyTriggerEvent setup = new JourneyTriggerEvent(3, "event-1", "canon-1", "domain-1", null, "user-1",
            "campaign-1", "n1_view", "next", "view_product", T_10_00, "{}");

        Evaluation evaluation = apply(setup);

        assertEquals(List
            .of(new SegmentCheck(1, "event-1", "canon-1", "domain-1", null, "user-1", "campaign-1", "n7_buyer",
                "view_product", T_10_00)),
            evaluation.segmentChecks());
    }

    @Test
    void aSegmentTriggerFromBeforeItsParentAsksForTheCheckAgainAtTheParentsCompletion() {
        apply(decide("n1_view", "view_product", T_10_00));
        JourneyTriggerEvent purchase = new JourneyTriggerEvent(3, "event-2", "canon-1", "domain-1", null, "user-1",
            "campaign-1", "n7_buyer", "yes", "purchase", T_10_00 - MINUTE, "{}");

        Evaluation evaluation = apply(purchase);

        assertEquals(Status.IGNORED, evaluation.status());
        assertEquals(List.of("n1_view/next"), transitions());
        assertEquals(List
            .of(new SegmentCheck(1, "event-2", "canon-1", "domain-1", null, "user-1", "campaign-1", "n7_buyer",
                "purchase", T_10_00)),
            evaluation.segmentChecks());
    }

    @Test
    void aTriggerThatReachesNoSegmentAsksForNoCheck() {
        apply(decide("n1_view", "view_product", T_10_00));

        Evaluation check = apply(decide("n2_vip", "view_vip_page", T_10_00 + MINUTE));

        assertEquals(List.of("n1_view/next", "n2_vip/yes"), transitions());
        assertEquals(List.of(), check.segmentChecks());
    }

    /**
     * The saved format gives every child a parent branch. A child saved without
     * one hangs off no branch, so it never completes, whether a trigger names it
     * or its parent completes.
     */
    @Test
    void aChildWithoutAParentBranchNeverCompletes() {
        CampaignGraph withoutBranch = graph
            .upsert(GraphNode
                .fromRow(row("n9_sms", "engagement", "n1_view", null, null))
                .orElseThrow())
            .upsert(GraphNode
                .fromRow(row("n10_check", "check", "n1_view", null, null))
                .orElseThrow());

        Evaluation setup = engine
            .evaluate(trigger("n1_view", "next", T_10_00), VersionedTrigger.FIRST_ENTRY, withoutBranch, completed);
        Evaluation check = engine
            .evaluate(trigger("n10_check", "yes", T_10_00 + MINUTE), VersionedTrigger.FIRST_ENTRY, withoutBranch,
                completed);

        assertEquals(List.of("n1_view/next"),
            setup.transitions().stream().map(state -> state.nodeId() + "/" + state.branch()).toList());
        assertEquals(Status.WRONG_BRANCH, check.status());
    }

    private Evaluation apply(JourneyTriggerEvent trigger) {
        Evaluation evaluation = engine.evaluate(trigger, VersionedTrigger.FIRST_ENTRY, graph, completed);
        published.addAll(evaluation.transitions());
        return evaluation;
    }

    private List<String> transitions() {
        return published.stream().map(state -> state.nodeId() + "/" + state.branch()).toList();
    }

    /** The one trigger customer decision emits for this node and event. */
    private static JourneyTriggerEvent decide(String nodeId, String eventName, long eventTimestamp) {
        Row nodeRow = ROWS.stream().filter(row -> nodeId.equals(row.getField("node_id"))).findFirst().orElseThrow();
        Event event = new Event("domain-1", "user-1", eventName, eventTimestamp, null, null, null, null, "web",
            null);
        List<String> branches = event.matchAll(CampaignNode.fromRow(nodeRow).valueOrThrow());
        assertEquals(1, branches.size(), "branches emitted for " + nodeId + ": " + branches);
        return trigger(nodeId, branches.getFirst(), eventTimestamp);
    }

    private static JourneyTriggerEvent trigger(String nodeId, String branch, long eventTimestamp) {
        return new JourneyTriggerEvent("canon-1", "domain-1", null, "user-1", "campaign-1", nodeId, branch,
            "event", eventTimestamp, "{}");
    }

    private static CampaignGraph graph() {
        CampaignGraph graph = new CampaignGraph();
        for (Row row : ROWS) {
            graph = graph.upsert(GraphNode.fromRow(row).orElseThrow());
        }
        return graph.withRowOf(1L);
    }

    /**
     * A segment node row as the journey builder saves it: a behavior condition and
     * no trigger.
     */
    private static Row segmentRow(String nodeId, String parentNodeId, String parentBranch, String metricCondition) {
        Row row = row(nodeId, "segment", parentNodeId, parentBranch, null);
        row.setField("conditions_json", metricCondition);
        return row;
    }

    /**
     * A node row whose last argument is the paths of a watch, or the trigger
     * event of any other node.
     */
    private static Row row(String nodeId, String nodeType, String parentNodeId, String parentBranch,
        String rule) {
        boolean watch = "watch".equals(nodeType);
        Row row = Row.withNames(RowKind.INSERT);
        row.setField("campaign_id", "campaign-1");
        row.setField("node_id", nodeId);
        row.setField("node_type", nodeType);
        row.setField("parent_node_id", parentNodeId);
        row.setField("parent_branch", parentBranch);
        row
            .setField("trigger_json",
                watch || rule == null ? null : "{\"kind\":\"event\",\"event\":\"" + rule + "\"}");
        row.setField("conditions_json", null);
        row.setField("paths_json", watch ? rule : null);
        row.setField("action_json", "engagement".equals(nodeType) ? "{\"channel\":\"sms\"}" : null);
        row.setField("goal_id", null);
        row.setField("graph_version", 1L);
        return row;
    }
}
