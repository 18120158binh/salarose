package com.cdp.platform.jobs.statemachine.transforms;

import java.util.List;

import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.streaming.util.KeyedBroadcastOperatorTestHarness;
import org.apache.flink.streaming.util.ProcessFunctionTestHarnesses;
import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;

import com.cdp.platform.jobs.statemachine.model.CampaignGraph;
import com.cdp.platform.shared.models.JourneyTriggerEvent;
import com.cdp.platform.shared.models.VersionedTrigger;
import com.cdp.platform.shared.models.db.UserCampaignState;
import com.cdp.platform.shared.models.db.WatchChild;
import com.cdp.platform.shared.models.node.Branch;
import com.cdp.platform.shared.models.node.WatchLimit;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * A watch node completes on {@code success} only before its deadline: its
 * parent's completion time plus the watch limit. Uses the worked example of
 * the journey execution contract, where {@code n3_cart} waits 15 minutes for
 * {@code add_to_cart} after {@code n2_vip} completes.
 */
class WatchDeadlineTest {

    private static final long T_10_00 = 1_760_346_000_000L;
    private static final long MINUTE = 60_000L;
    private static final MapStateDescriptor<String, CampaignGraph> GRAPHS = new MapStateDescriptor<>(
        "campaign-journey-graphs", Types.STRING, TypeInformation.of(CampaignGraph.class));
    private static final String CART_WATCH = """
        {"path_type":"SuccessOrTimeoutPath","limit":{"value":15,"unit":"minutes"}}""";

    private KeyedBroadcastOperatorTestHarness<String, VersionedTrigger, Row, UserCampaignState> harness;

    @AfterEach
    void close() throws Exception {
        harness.close();
    }

    @Test
    void aSuccessBeforeTheDeadlineCompletesTheWatch() throws Exception {
        start(CART_WATCH);
        apply(trigger("n1_view", "next", T_10_00));
        apply(trigger("n2_vip", "yes", T_10_00 + MINUTE));
        apply(trigger("n3_cart", "success", T_10_00 + 15 * MINUTE));

        assertEquals(List
            .of("n1_view/next@" + T_10_00, "n2_vip/yes@" + (T_10_00 + MINUTE),
                "n3_cart/success@" + (T_10_00 + 15 * MINUTE), "n6_end/next@" + (T_10_00 + 15 * MINUTE)),
            transitions());
    }

    /**
     * The timeout makes a round trip through Postgres and the timer flow, so a
     * later {@code success} can reach the engine first.
     */
    @Test
    void aSuccessAfterTheDeadlineLeavesTheWatchToItsTimeout() throws Exception {
        start(CART_WATCH);
        apply(trigger("n1_view", "next", T_10_00));
        apply(trigger("n2_vip", "yes", T_10_00 + MINUTE));
        apply(trigger("n3_cart", "success", T_10_00 + 20 * MINUTE));
        apply(trigger("n3_cart", "timeout", T_10_00 + 16 * MINUTE));

        assertEquals(List
            .of("n1_view/next@" + T_10_00, "n2_vip/yes@" + (T_10_00 + MINUTE),
                "n3_cart/timeout@" + (T_10_00 + 16 * MINUTE)),
            transitions());
    }

    /**
     * The timer runs on processing time, so its timeout can reach the engine
     * before a {@code success} that happened earlier. The first to arrive wins
     * (JEX-NFR-01).
     */
    @Test
    void aTimeoutThatArrivesBeforeAnEarlierSuccessCompletesTheWatch() throws Exception {
        start(CART_WATCH);
        apply(trigger("n1_view", "next", T_10_00));
        apply(trigger("n2_vip", "yes", T_10_00 + MINUTE));
        apply(trigger("n3_cart", "timeout", T_10_00 + 16 * MINUTE));
        apply(trigger("n3_cart", "success", T_10_00 + 15 * MINUTE));

        assertEquals(List
            .of("n1_view/next@" + T_10_00, "n2_vip/yes@" + (T_10_00 + MINUTE),
                "n3_cart/timeout@" + (T_10_00 + 16 * MINUTE)),
            transitions());
    }

    @Test
    void aBufferedSuccessAfterTheDeadlineDoesNotCompleteTheWatchWhenItsParentCompletes() throws Exception {
        start(CART_WATCH);
        apply(trigger("n1_view", "next", T_10_00));
        apply(trigger("n3_cart", "success", T_10_00 + 20 * MINUTE));
        apply(trigger("n2_vip", "yes", T_10_00 + MINUTE));

        assertEquals(List.of("n1_view/next@" + T_10_00, "n2_vip/yes@" + (T_10_00 + MINUTE)), transitions());
    }

    /**
     * The timer flow fires at the limit that the parent's transition listed, so
     * the engine takes the deadline from that limit too. A later change to the
     * node's row does not move the deadline of a watch already started.
     */
    @Test
    void aWatchKeepsTheLimitItsTimerStartedWith() throws Exception {
        start(CART_WATCH);
        apply(trigger("n1_view", "next", T_10_00));
        apply(trigger("n2_vip", "yes", T_10_00 + MINUTE));
        harness.processBroadcastElement(row("n3_cart", "watch", "n2_vip", "yes", """
            {"path_type":"SuccessOrTimeoutPath","limit":{"value":1,"unit":"minutes"}}"""), 0L);
        apply(trigger("n3_cart", "success", T_10_00 + 10 * MINUTE));

        assertEquals(List
            .of("n1_view/next@" + T_10_00, "n2_vip/yes@" + (T_10_00 + MINUTE),
                "n3_cart/success@" + (T_10_00 + 10 * MINUTE), "n6_end/next@" + (T_10_00 + 10 * MINUTE)),
            transitions());
    }

    /**
     * A watch that a later save adds under a parent that already completed has
     * no timer, since the parent's transition does not list it. Its deadline
     * still comes from its own row.
     */
    @Test
    void aWatchAddedAfterItsParentCompletedStillHasADeadline() throws Exception {
        start(CART_WATCH);
        List<Row> campaign = campaign(CART_WATCH);
        List<Row> withoutCartWatch = List.of(campaign.get(0), campaign.get(1));
        save(campaign, withoutCartWatch);
        apply(trigger("n1_view", "next", T_10_00));
        apply(trigger("n2_vip", "yes", T_10_00 + MINUTE));
        save(withoutCartWatch, campaign);
        apply(trigger("n3_cart", "success", T_10_00 + 20 * MINUTE));

        assertEquals(List.of("n1_view/next@" + T_10_00, "n2_vip/yes@" + (T_10_00 + MINUTE)), transitions());
    }

    /**
     * The timer flow starts a watch's timer from the watch children that its
     * parent's transition lists. A watch whose limit is invalid is not loaded,
     * so it gets no timer, instead of a 15 minute one.
     */
    @Test
    void aWatchWithAnInvalidLimitIsNotListedForATimer() throws Exception {
        List<String> invalid = List
            .of(
                "{\"path_type\":\"SuccessOrTimeoutPath\",\"limit\":{\"value\":15,\"unit\":\"weeks\"}}",
                "{\"path_type\":\"SuccessOrTimeoutPath\",\"limit\":{\"value\":0,\"unit\":\"minutes\"}}",
                "{\"path_type\":\"SuccessOrTimeoutPath\",\"limit\":{\"value\":-5,\"unit\":\"minutes\"}}",
                "{\"path_type\":\"SuccessOrTimeoutPath\",\"limit\":{\"value\":\"fifteen\",\"unit\":\"minutes\"}}",
                "{\"path_type\":\"SuccessOrTimeoutPath\",\"limit\":{\"value\":1e300,\"unit\":\"days\"}}",
                "{not json");
        for (String condition : invalid) {
            start(condition);
            apply(trigger("n1_view", "next", T_10_00));
            apply(trigger("n2_vip", "yes", T_10_00 + MINUTE));

            assertEquals(List.of("n1_view/[]", "n2_vip/[]"), watchChildren(), condition);
            harness.close();
        }
        start(CART_WATCH);
        apply(trigger("n1_view", "next", T_10_00));
        apply(trigger("n2_vip", "yes", T_10_00 + MINUTE));
        assertEquals(List
            .of("n1_view/[]",
                "n2_vip/" + List.of(new WatchChild("n3_cart", new WatchLimit(15 * MINUTE), Branch.timeout, 1L))),
            watchChildren());
    }

    private void start(String cartWatchPaths) throws Exception {
        harness = ProcessFunctionTestHarnesses
            .forKeyedBroadcastProcessFunction(
                new JourneyStateMachineFunction(GRAPHS, 1000, 4_194_304L, 7_776_000_000L, 5 * MINUTE),
                VersionedTrigger::journeyKey, Types.STRING, GRAPHS,
                JourneyStateMachineFunction.GRAPH_LOADS);
        for (Row row : campaign(cartWatchPaths)) {
            harness.processBroadcastElement(row, 0L);
        }
    }

    private static List<Row> campaign(String cartWatchPaths) {
        return List
            .of(row("n1_view", "setup", null, null, null), row("n2_vip", "check", "n1_view", "next", null),
                row("n3_cart", "watch", "n2_vip", "yes", cartWatchPaths),
                row("n4_active", "check", "n3_cart", "timeout", null),
                row("n6_end", "end", "n3_cart", "success", null));
    }

    /** Studio's save: delete every node row, then insert each one again. */
    private void save(List<Row> before, List<Row> after) throws Exception {
        for (Row row : before) {
            Row deleted = Row.copy(row);
            deleted.setKind(RowKind.DELETE);
            harness.processBroadcastElement(deleted, 0L);
        }
        for (Row row : after) {
            Row inserted = Row.copy(row);
            inserted.setField("campaign_node_count", after.size());
            harness.processBroadcastElement(inserted, 0L);
        }
    }

    private void apply(JourneyTriggerEvent trigger) throws Exception {
        harness.processElement(new VersionedTrigger(trigger, null), trigger.eventTimestamp());
    }

    private List<String> transitions() {
        return harness
            .extractOutputValues()
            .stream()
            .map(state -> state.nodeId() + "/" + state.branch() + "@" + state.eventTimestamp())
            .toList();
    }

    private List<String> watchChildren() {
        return harness
            .extractOutputValues()
            .stream()
            .map(state -> state.nodeId() + "/" + state.watchChildren())
            .toList();
    }

    private static JourneyTriggerEvent trigger(String nodeId, String branch, long eventTimestamp) {
        return new JourneyTriggerEvent("canon-1", "domain-1", null, "user-1", "campaign-1", nodeId, branch, "event",
            eventTimestamp, "{}");
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
        row.setField("campaign_node_count", 5);
        row.setField("graph_version", 1L);
        return row;
    }
}
