package com.cdp.platform.jobs.statemachine.transforms;

import java.util.List;
import java.util.Queue;

import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.streaming.runtime.streamrecord.StreamRecord;
import org.apache.flink.streaming.util.KeyedBroadcastOperatorTestHarness;
import org.apache.flink.streaming.util.ProcessFunctionTestHarnesses;
import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;

import com.cdp.platform.jobs.statemachine.model.CampaignGraph;
import com.cdp.platform.shared.models.JourneyTriggerEvent;
import com.cdp.platform.shared.models.SegmentCheck;
import com.cdp.platform.shared.models.VersionedTrigger;
import com.cdp.platform.shared.models.db.UserCampaignState;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * The worked example of the journey execution contract, with the watermark
 * past the watch deadline, as it is after the timer flow was down past it.
 */
class JourneyStateMachineFunctionTest {

    private static final long T_10_00 = 1_760_346_000_000L;
    private static final long MINUTE = 60_000L;
    private static final String ADD_TO_CART = """
        {"path_type":"SuccessOrTimeoutPath","limit":{"value":15,"unit":"minutes"}}""";
    private static final String WAIT = """
        {"path_type":"DelayPath","limit":{"value":15,"unit":"minutes"}}""";
    private static final MapStateDescriptor<String, CampaignGraph> GRAPHS = new MapStateDescriptor<>(
        "campaign-journey-graphs", Types.STRING, TypeInformation.of(CampaignGraph.class));

    private KeyedBroadcastOperatorTestHarness<String, VersionedTrigger, Row, UserCampaignState> harness;

    @BeforeEach
    void startWithTheWatermarkPastTheDeadline() throws Exception {
        harness = ProcessFunctionTestHarnesses
            .forKeyedBroadcastProcessFunction(new JourneyStateMachineFunction(GRAPHS, 1000, 4_194_304L,
                7_776_000_000L, 300_000L), VersionedTrigger::journeyKey, Types.STRING, GRAPHS,
                JourneyStateMachineFunction.GRAPH_LOADS);
        for (Row row : List
            .of(row("n1_view", "setup", null, null, null), row("n2_vip", "check", "n1_view", "next", null),
                row("n3_cart", "watch", "n2_vip", "yes", ADD_TO_CART),
                row("n4_active", "check", "n3_cart", "timeout", null),
                row("n6_end", "end", "n3_cart", "success", null),
                row("n7_wait", "watch", "n1_view", "next", WAIT),
                segmentRow("n8_buyer", "n1_view", "next"))) {
            harness.processBroadcastElement(row, 0L);
        }
        harness
            .processElement(new VersionedTrigger(trigger("n1_view", "next", "view_product", T_10_00), null), T_10_00);
        harness
            .processElement(new VersionedTrigger(trigger("n2_vip", "yes", "view_vip_page", T_10_00 + MINUTE), null),
                T_10_00 + MINUTE);
        harness.watermark(T_10_00 + 20 * MINUTE);
    }

    @AfterEach
    void close() throws Exception {
        harness.close();
    }

    @Test
    void aWatchTimeoutAfterDowntimeCompletesTheWatchWithItsDeadline() throws Exception {
        apply(trigger("n3_cart", "timeout", "timeout", T_10_00 + 16 * MINUTE));

        assertEquals(List.of("n1_view/next", "n2_vip/yes", "n3_cart/timeout"), transitions());
        assertEquals(T_10_00 + 16 * MINUTE, completion("n3_cart").eventTimestamp());
        assertNull(harness.getSideOutput(JourneyStateMachineFunction.LATE_EVENTS));
    }

    @Test
    void aDelayPathDeadlineAfterDowntimeCompletesTheWatchOnNext() throws Exception {
        apply(trigger("n7_wait", "next", "next", T_10_00 + 15 * MINUTE));

        assertEquals(List.of("n1_view/next", "n2_vip/yes", "n7_wait/next"), transitions());
        assertNull(harness.getSideOutput(JourneyStateMachineFunction.LATE_EVENTS));
    }

    @Test
    void aLateWatchSuccessIsStillDroppedAsLate() throws Exception {
        JourneyTriggerEvent success = trigger("n3_cart", "success", "add_to_cart", T_10_00 + 5 * MINUTE);
        apply(success);

        assertEquals(List.of("n1_view/next", "n2_vip/yes"), transitions());
        assertEquals(List.of(success), late());
    }

    @Test
    void aLateCheckTriggerIsStillDroppedAsLate() throws Exception {
        JourneyTriggerEvent check = trigger("n4_active", "yes", "open_app", T_10_00 + 17 * MINUTE);
        apply(check);

        assertEquals(List.of(check), late());
    }

    @Test
    void aSegmentCheckAnswerBehindTheWatermarkCompletesTheSegment() throws Exception {
        apply(segmentCheckAnswer("n8_buyer", T_10_00));

        assertEquals(List.of("n1_view/next", "n2_vip/yes", "n8_buyer/yes"), transitions());
        assertNull(harness.getSideOutput(JourneyStateMachineFunction.LATE_EVENTS));
    }

    @Test
    void aSegmentAnswerDecidedAgainstANewerGraphWaitsForItInsteadOfBeingLate() throws Exception {
        JourneyTriggerEvent answer = segmentCheckAnswer("n8_buyer", T_10_00);
        harness.processElement(new VersionedTrigger(answer, 2L), T_10_00);

        assertNull(harness.getSideOutput(JourneyStateMachineFunction.LATE_EVENTS));
    }

    @Test
    void aSegmentTriggerBehindTheWatermarkFromBeforeItsParentAsksForTheCheckAgain() throws Exception {
        // n1_view's completion already asked for the check once.
        harness.getSideOutput(JourneyStateMachineFunction.SEGMENT_CHECKS).clear();

        apply(trigger("n8_buyer", "yes", "purchase", T_10_00 - 10 * MINUTE));

        assertEquals(List.of("n1_view/next", "n2_vip/yes"), transitions());
        assertEquals(List
            .of(new SegmentCheck(1, null, "canon-1", "domain-1", null, "user-1", "campaign-1", "n8_buyer",
                "purchase", T_10_00)),
            segmentChecks());
        assertNull(harness.getSideOutput(JourneyStateMachineFunction.LATE_EVENTS));
    }

    @Test
    void aLateSegmentTriggerFromAMetricChangeIsStillDroppedAsLate() throws Exception {
        JourneyTriggerEvent purchase = trigger("n8_buyer", "yes", "purchase", T_10_00 + 2 * MINUTE);
        apply(purchase);

        assertEquals(List.of("n1_view/next", "n2_vip/yes"), transitions());
        assertEquals(List.of(purchase), late());
    }

    @Test
    void triggersOnTheWrongBranchOfTheirParentAreDroppedAndCounted() throws Exception {
        JourneyTriggerEvent buffered = trigger("n6_end", "next", "next", T_10_00 + 25 * MINUTE);
        apply(buffered);
        apply(trigger("n3_cart", "timeout", "timeout", T_10_00 + 16 * MINUTE));
        JourneyTriggerEvent immediate = trigger("n6_end", "next", "next", T_10_00 + 26 * MINUTE);
        apply(immediate);
        harness.watermark(T_10_00 + 30 * MINUTE);

        assertEquals(List.of("n1_view/next", "n2_vip/yes", "n3_cart/timeout"), transitions());
        assertEquals(List.of(buffered, immediate), wrongBranch());
    }

    private void apply(JourneyTriggerEvent trigger) throws Exception {
        harness.processElement(new VersionedTrigger(trigger, null), trigger.eventTimestamp());
    }

    private List<String> transitions() {
        return harness.extractOutputValues().stream().map(state -> state.nodeId() + "/" + state.branch()).toList();
    }

    private UserCampaignState completion(String nodeId) {
        return harness
            .extractOutputValues()
            .stream()
            .filter(state -> nodeId.equals(state.nodeId()))
            .findFirst()
            .orElseThrow();
    }

    private List<SegmentCheck> segmentChecks() {
        Queue<StreamRecord<SegmentCheck>> checks = harness.getSideOutput(JourneyStateMachineFunction.SEGMENT_CHECKS);
        return checks == null ? List.of() : checks.stream().map(StreamRecord::getValue).toList();
    }

    private List<JourneyTriggerEvent> late() {
        Queue<StreamRecord<JourneyTriggerEvent>> late = harness.getSideOutput(JourneyStateMachineFunction.LATE_EVENTS);
        return late == null ? List.of() : late.stream().map(StreamRecord::getValue).toList();
    }

    private List<JourneyTriggerEvent> wrongBranch() {
        Queue<StreamRecord<JourneyTriggerEvent>> dropped = harness
            .getSideOutput(JourneyStateMachineFunction.WRONG_BRANCH_EVENTS);
        return dropped == null ? List.of() : dropped.stream().map(StreamRecord::getValue).toList();
    }

    private static JourneyTriggerEvent trigger(String nodeId, String branch, String eventName, long eventTimestamp) {
        return new JourneyTriggerEvent("canon-1", "domain-1", null, "user-1", "campaign-1", nodeId, branch,
            eventName, eventTimestamp, "{}");
    }

    /**
     * The trigger customer decision emits when a segment check passes, at the
     * time the segment's parent completed.
     */
    private static JourneyTriggerEvent segmentCheckAnswer(String nodeId, long parentCompletedAt) {
        return new JourneyTriggerEvent(3, "event-1", "canon-1", "domain-1", null, "user-1", "campaign-1", nodeId,
            "yes", "view_product", parentCompletedAt, null);
    }

    /**
     * A segment row as the journey builder saves it: a behavior condition and no
     * trigger.
     */
    private static Row segmentRow(String nodeId, String parentNodeId, String parentBranch) {
        Row row = row(nodeId, "segment", parentNodeId, parentBranch, null);
        row.setField("conditions_json", """
            {"groups":[{"conditions":[{"type":"behavior","metric_id":"m_purchase_count","event":"purchase",
             "measure":"COUNT","window":{"value":30,"unit":"DAYS"},"op":">=","value":2}]}]}""");
        return row;
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
        row.setField("campaign_node_count", 7);
        row.setField("graph_version", 1L);
        return row;
    }
}
