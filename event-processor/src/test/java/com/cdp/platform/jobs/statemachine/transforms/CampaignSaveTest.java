package com.cdp.platform.jobs.statemachine.transforms;

import java.util.List;

import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.runtime.checkpoint.OperatorSubtaskState;
import org.apache.flink.streaming.api.operators.co.CoBroadcastWithKeyedOperator;
import org.apache.flink.streaming.util.KeyedBroadcastOperatorTestHarness;
import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;

import com.cdp.platform.jobs.statemachine.model.CampaignGraph;
import com.cdp.platform.shared.models.JourneyTriggerEvent;
import com.cdp.platform.shared.models.VersionedTrigger;
import com.cdp.platform.shared.models.db.UserCampaignState;
import com.cdp.platform.shared.models.db.WatchChild;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * Studio saves a campaign by deleting every node row and inserting each one
 * again, in one transaction. CDC delivers the rows one at a time, and on a
 * fresh start the snapshot delivers them in any order. Each row carries the
 * number of nodes in its save, so the engine can tell when the whole save has
 * arrived. A trigger must never apply against part of a save, or a node that
 * completes before its children arrive never starts them.
 */
class CampaignSaveTest {

    private static final long T_10_00 = 1_760_346_000_000L;
    private static final long MINUTE = 60_000L;
    private static final MapStateDescriptor<String, CampaignGraph> GRAPHS = new MapStateDescriptor<>(
        "campaign-journey-graphs", Types.STRING, TypeInformation.of(CampaignGraph.class));
    private static final Row N1_VIEW = node("n1_view", "setup", null, null, null);
    private static final Row N2_VIP = node("n2_vip", "check", "n1_view", "next", null);
    private static final Row N3_CART = node("n3_cart", "watch", "n1_view", "next", """
        {"path_type":"SuccessOrTimeoutPath","limit":{"value":15,"unit":"minutes"}}""");
    private static final Row N5_SMS = node("n5_sms", "engagement", "n1_view", "next", null);
    private static final Row N9_BROKEN_WATCH = node("n9_broken", "watch", "n1_view", "next", """
        {"path_type":"SuccessOrTimeoutPath","limit":{"value":0,"unit":"minutes"}}""");

    private KeyedBroadcastOperatorTestHarness<String, VersionedTrigger, Row, UserCampaignState> harness;

    @AfterEach
    void close() throws Exception {
        harness.close();
    }

    @Test
    void anEngagementWhoseRowArrivesAfterItsWaitingParentStillCompletes() throws Exception {
        start();
        apply(trigger("canon-1", "n1_view", "next", T_10_00 + MINUTE));

        graph(inserted(N1_VIEW, 2), inserted(N5_SMS, 2));

        assertEquals(List.of("n1_view/next@" + (T_10_00 + MINUTE), "n5_sms/next@" + (T_10_00 + MINUTE)),
            transitions());
    }

    @Test
    void aWatchWhoseRowArrivesAfterItsWaitingParentGetsItsTimer() throws Exception {
        start();
        apply(trigger("canon-1", "n1_view", "next", T_10_00 + MINUTE));

        graph(inserted(N1_VIEW, 2), inserted(N3_CART, 2));

        assertEquals(List.of("n1_view/[n3_cart]"), watchChildren());
    }

    @Test
    void aTriggerThatArrivesDuringASaveSeesTheWholeSavedGraph() throws Exception {
        start();
        graph(inserted(N1_VIEW, 2), inserted(N5_SMS, 2));

        graph(deleted(N1_VIEW), deleted(N5_SMS), inserted(N1_VIEW, 2));
        apply(trigger("canon-1", "n1_view", "next", T_10_00 + MINUTE));
        graph(inserted(N5_SMS, 2));

        assertEquals(List.of("n1_view/next@" + (T_10_00 + MINUTE), "n5_sms/next@" + (T_10_00 + MINUTE)),
            transitions());
    }

    @Test
    void aTriggerBetweenTheTwoHalvesOfAnUpdatedRowSeesTheNode() throws Exception {
        start();
        graph(inserted(N1_VIEW, 2), inserted(N5_SMS, 2));

        graph(updateBefore(N5_SMS));
        apply(trigger("canon-1", "n1_view", "next", T_10_00 + MINUTE));
        graph(updateAfter(N5_SMS, 2));

        assertEquals(List.of("n1_view/next@" + (T_10_00 + MINUTE), "n5_sms/next@" + (T_10_00 + MINUTE)),
            transitions());
    }

    @Test
    void aSaveWithAWatchNodeThatIsNotLoadedStillGoesLive() throws Exception {
        start();
        graph(inserted(N1_VIEW, 2), inserted(N9_BROKEN_WATCH, 2));

        apply(trigger("canon-1", "n1_view", "next", T_10_00 + MINUTE));

        assertEquals(List.of("n1_view/[]"), watchChildren());
    }

    @Test
    void aRowWithoutTheNodeCountOfItsSaveIsNotLoaded() throws Exception {
        start();
        graph(inserted(N1_VIEW, null));

        apply(trigger("canon-1", "n1_view", "next", T_10_00 + MINUTE));

        assertEquals(List.of(), transitions());
    }

    /**
     * A node that a later save adds under a parent the person already passed
     * does not start for that person, as a step added to a live journey
     * behind a person does not.
     */
    @Test
    void aNodeAddedByALaterSaveDoesNotStartUnderACompletedParent() throws Exception {
        start();
        graph(inserted(N1_VIEW, 1));
        apply(trigger("canon-1", "n1_view", "next", T_10_00 + MINUTE));

        graph(deleted(N1_VIEW), inserted(N1_VIEW, 2), inserted(N5_SMS, 2));
        apply(trigger("canon-2", "n1_view", "next", T_10_00 + 2 * MINUTE));

        assertEquals(List
            .of("n1_view/next@" + (T_10_00 + MINUTE), "n1_view/next@" + (T_10_00 + 2 * MINUTE),
                "n5_sms/next@" + (T_10_00 + 2 * MINUTE)),
            transitions());
    }

    /**
     * A restore resumes CDC from the checkpoint, so the rows after it arrive
     * again, and the save completes from the rows the checkpoint held.
     */
    @Test
    void aSaveCutByARestoreGoesLiveFromTheRowsReplayedAfterIt() throws Exception {
        start();
        graph(inserted(N1_VIEW, 2), inserted(N5_SMS, 2));
        graph(deleted(N1_VIEW), deleted(N5_SMS), inserted(N1_VIEW, 2));
        OperatorSubtaskState checkpoint = harness.snapshot(1L, 1L);
        harness.close();

        harness = harness();
        harness.initializeState(checkpoint);
        harness.open();
        apply(trigger("canon-1", "n1_view", "next", T_10_00 + MINUTE));
        graph(inserted(N1_VIEW, 2), inserted(N5_SMS, 2));

        assertEquals(List.of("n1_view/next@" + (T_10_00 + MINUTE), "n5_sms/next@" + (T_10_00 + MINUTE)),
            transitions());
    }

    private void start() throws Exception {
        harness = harness();
        harness.open();
    }

    private static KeyedBroadcastOperatorTestHarness<String, VersionedTrigger, Row, UserCampaignState> harness()
        throws Exception {
        return new KeyedBroadcastOperatorTestHarness<>(
            new CoBroadcastWithKeyedOperator<>(
                new JourneyStateMachineFunction(GRAPHS, 1000, 4_194_304L, 7_776_000_000L, 5 * MINUTE),
                List.of(GRAPHS, JourneyStateMachineFunction.GRAPH_LOADS)),
            VersionedTrigger::journeyKey, Types.STRING, 128, 1, 0);
    }

    private void graph(Row... rows) throws Exception {
        for (Row row : rows) {
            harness.processBroadcastElement(row, 0L);
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
            .map(state -> state.nodeId() + "/" + state.watchChildren().stream().map(WatchChild::nodeId).toList())
            .toList();
    }

    private static JourneyTriggerEvent trigger(String canonId, String nodeId, String branch, long eventTimestamp) {
        return new JourneyTriggerEvent(canonId, "domain-1", null, "user-1", "campaign-1", nodeId, branch, "event",
            eventTimestamp, "{}");
    }

    private static Row inserted(Row node, Integer campaignNodeCount) {
        return withCount(node, RowKind.INSERT, campaignNodeCount);
    }

    private static Row updateAfter(Row node, Integer campaignNodeCount) {
        return withCount(node, RowKind.UPDATE_AFTER, campaignNodeCount);
    }

    private static Row updateBefore(Row node) {
        return withCount(node, RowKind.UPDATE_BEFORE, 2);
    }

    private static Row deleted(Row node) {
        return withCount(node, RowKind.DELETE, 2);
    }

    private static Row withCount(Row node, RowKind kind, Integer campaignNodeCount) {
        Row row = Row.copy(node);
        row.setKind(kind);
        row.setField("campaign_node_count", campaignNodeCount);
        row.setField("graph_version", 1L);
        return row;
    }

    private static Row node(String nodeId, String nodeType, String parentNodeId, String parentBranch,
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
        row.setField("action_json", "engagement".equals(nodeType) ? "{\"channel\":\"sms\"}" : null);
        row.setField("goal_id", null);
        return row;
    }
}
