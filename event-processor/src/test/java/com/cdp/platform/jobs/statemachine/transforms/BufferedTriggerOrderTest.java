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
import com.cdp.platform.shared.models.VersionedTrigger;
import com.cdp.platform.shared.models.db.UserCampaignState;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * A trigger applies as soon as it arrives, so among triggers that can complete
 * the same node, the first to arrive completes it. Triggers buffered for the
 * same parent are retried in event-time order when the parent completes,
 * whatever order the state backend keeps them in (JEX-NFR-01).
 */
class BufferedTriggerOrderTest {

    private static final long T_10_00 = 1_760_346_000_000L;
    private static final long MINUTE = 60_000L;
    private static final MapStateDescriptor<String, CampaignGraph> GRAPHS = new MapStateDescriptor<>(
        "campaign-journey-graphs", Types.STRING, TypeInformation.of(CampaignGraph.class));

    private KeyedBroadcastOperatorTestHarness<String, VersionedTrigger, Row, UserCampaignState> harness;

    @AfterEach
    void close() throws Exception {
        harness.close();
    }

    @Test
    void theEarliestBufferedTriggerCompletesTheNodeWhenItsParentCompletes() throws Exception {
        start();
        apply(trigger("n2_vip", "yes", T_10_00 + 3 * MINUTE, "{\"page\":\"second\"}"));
        apply(trigger("n2_vip", "yes", T_10_00 + 2 * MINUTE, "{\"page\":\"first\"}"));

        apply(trigger("n1_view", "next", T_10_00 + MINUTE, "{}"));

        assertEquals(List
            .of("n1_view/next@" + (T_10_00 + MINUTE) + " {}",
                "n2_vip/yes@" + (T_10_00 + 2 * MINUTE) + " {\"page\":\"first\"}"),
            transitions());
    }

    @Test
    void theFirstTriggerToArriveCompletesTheNodeEvenWithALaterEventTime() throws Exception {
        start();
        apply(trigger("n1_view", "next", T_10_00 + 2 * MINUTE, "{\"page\":\"second\"}"));
        apply(trigger("n1_view", "next", T_10_00, "{\"page\":\"first\"}"));

        assertEquals(List.of("n1_view/next@" + (T_10_00 + 2 * MINUTE) + " {\"page\":\"second\"}"), transitions());
    }

    @Test
    void aChildTriggerEarlierThanItsParentsCompletionIsUnreachable() throws Exception {
        start();
        apply(trigger("n1_view", "next", T_10_00 + 2 * MINUTE, "{}"));
        apply(trigger("n1_view", "next", T_10_00, "{}"));
        JourneyTriggerEvent between = trigger("n2_vip", "yes", T_10_00 + MINUTE, "{}");
        apply(between);
        assertEquals(List.of(), unreachable());

        harness.watermark(T_10_00 + 2 * MINUTE);

        assertEquals(List.of("n1_view/next@" + (T_10_00 + 2 * MINUTE) + " {}"), transitions());
        assertEquals(List.of(between), unreachable());
    }

    @Test
    void aJourneyWhoseStuckTriggerIsDroppedMovesOnWithALaterTrigger() throws Exception {
        start();
        JourneyTriggerEvent stuck = trigger("n2_vip", "yes", T_10_00 + MINUTE, "{}");
        apply(stuck);
        harness.watermark(T_10_00 + 2 * MINUTE);
        assertEquals(List.of(stuck), unreachable());
        assertEquals(List.of(), transitions());

        apply(trigger("n1_view", "next", T_10_00 + 20 * MINUTE, "{}"));
        apply(trigger("n2_vip", "yes", T_10_00 + 21 * MINUTE, "{}"));

        assertEquals(List
            .of("n1_view/next@" + (T_10_00 + 20 * MINUTE) + " {}", "n2_vip/yes@" + (T_10_00 + 21 * MINUTE) + " {}"),
            transitions());
    }

    private void start() throws Exception {
        harness = ProcessFunctionTestHarnesses
            .forKeyedBroadcastProcessFunction(new JourneyStateMachineFunction(GRAPHS, 1000, 4_194_304L,
                7_776_000_000L, 300_000L), VersionedTrigger::journeyKey, Types.STRING, GRAPHS,
                JourneyStateMachineFunction.GRAPH_LOADS);
        harness.processBroadcastElement(row("n1_view", "setup", null, null), 0L);
        harness.processBroadcastElement(row("n2_vip", "check", "n1_view", "next"), 0L);
    }

    private void apply(JourneyTriggerEvent trigger) throws Exception {
        harness.processElement(new VersionedTrigger(trigger, null), trigger.eventTimestamp());
    }

    private List<String> transitions() {
        return harness
            .extractOutputValues()
            .stream()
            .map(state -> state.nodeId() + "/" + state.branch() + "@" + state.eventTimestamp() + " "
                + state.contextJson())
            .toList();
    }

    private List<JourneyTriggerEvent> unreachable() {
        Queue<StreamRecord<JourneyTriggerEvent>> records = harness
            .getSideOutput(JourneyStateMachineFunction.UNREACHABLE_EVENTS);
        return records == null ? List.of() : records.stream().map(StreamRecord::getValue).toList();
    }

    private static JourneyTriggerEvent trigger(String nodeId, String branch, long eventTimestamp,
        String contextJson) {
        return new JourneyTriggerEvent("canon-1", "domain-1", null, "user-1", "campaign-1", nodeId, branch, "event",
            eventTimestamp, contextJson);
    }

    private static Row row(String nodeId, String nodeType, String parentNodeId, String parentBranch) {
        Row row = Row.withNames(RowKind.INSERT);
        row.setField("campaign_id", "campaign-1");
        row.setField("node_id", nodeId);
        row.setField("node_type", nodeType);
        row.setField("parent_node_id", parentNodeId);
        row.setField("parent_branch", parentBranch);
        row.setField("trigger_json", null);
        row.setField("conditions_json", null);
        row.setField("paths_json", null);
        row.setField("action_json", null);
        row.setField("goal_id", null);
        row.setField("campaign_node_count", 2);
        row.setField("graph_version", 1L);
        return row;
    }
}
