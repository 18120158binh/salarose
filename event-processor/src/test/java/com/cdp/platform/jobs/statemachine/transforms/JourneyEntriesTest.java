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
import org.apache.flink.util.OutputTag;

import com.cdp.platform.jobs.statemachine.model.CampaignGraph;
import com.cdp.platform.shared.models.JourneyTriggerEvent;
import com.cdp.platform.shared.models.VersionedTrigger;
import com.cdp.platform.shared.models.db.UserCampaignState;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * A journey key holds one entry per entry id that a setup trigger opened. A
 * setup trigger without an entry id is for the entry {@code first}. Each entry
 * completes each node once, and a trigger below the setup node applies to each
 * entry separately (JEX-FR-01, JEX-FR-18, JEX-FR-19).
 */
class JourneyEntriesTest {

    private static final long T_10_00 = 1_760_346_000_000L;
    private static final long MINUTE = 60_000L;
    private static final String PURCHASE_WATCH = """
        {"path_type":"SuccessOrTimeoutPath","limit":{"value":15,"unit":"minutes"}}""";
    private static final MapStateDescriptor<String, CampaignGraph> GRAPHS = new MapStateDescriptor<>(
        "campaign-journey-graphs", Types.STRING, TypeInformation.of(CampaignGraph.class));

    private KeyedBroadcastOperatorTestHarness<String, VersionedTrigger, Row, UserCampaignState> harness;

    @BeforeEach
    void loadThePriceDropCampaign() throws Exception {
        harness = priceDropCampaign(1000);
    }

    @AfterEach
    void close() throws Exception {
        harness.close();
    }

    @Test
    void setupTriggersWithTwoEntryIdsOpenTwoEntries() throws Exception {
        apply(trigger("n1_drop", "next", T_10_00), "be-1");
        apply(trigger("n1_drop", "next", T_10_00 + MINUTE), "be-2");

        assertEquals(List.of("be-1:n1_drop/next", "be-2:n1_drop/next"), transitions());
    }

    @Test
    void aReplayedSetupTriggerOpensNoEntryAndCompletesNothing() throws Exception {
        apply(trigger("n1_drop", "next", T_10_00), "be-1");
        apply(trigger("n1_drop", "next", T_10_00 + MINUTE), "be-2");

        apply(trigger("n1_drop", "next", T_10_00), "be-1");

        assertEquals(List.of("be-1:n1_drop/next", "be-2:n1_drop/next"), transitions());
    }

    @Test
    void setupTriggersWithoutAnEntryIdShareTheFirstEntry() throws Exception {
        apply(trigger("n1_drop", "next", T_10_00), null);
        apply(trigger("n1_drop", "next", T_10_00 + MINUTE), null);

        assertEquals(List.of("first:n1_drop/next"), transitions());
    }

    @Test
    void oneSuccessCompletesTheWatchOfEveryEntryWaitingAtIt() throws Exception {
        apply(trigger("n1_drop", "next", T_10_00), "be-1");
        apply(trigger("n1_drop", "next", T_10_00), "be-2");
        apply(trigger("n2_vip", "yes", T_10_00 + MINUTE), null);

        apply(trigger("n3_buy", "success", T_10_00 + 5 * MINUTE), null);

        assertEquals(List
            .of("be-1:n1_drop/next", "be-1:n2_vip/yes", "be-1:n3_buy/success", "be-1:n6_end/next",
                "be-2:n1_drop/next", "be-2:n2_vip/yes", "be-2:n3_buy/success", "be-2:n6_end/next"),
            transitions());
    }

    @Test
    void aTimeoutCompletesOnlyTheWatchOfItsOwnEntry() throws Exception {
        apply(trigger("n1_drop", "next", T_10_00), "be-1");
        apply(trigger("n1_drop", "next", T_10_00), "be-2");
        apply(trigger("n2_vip", "yes", T_10_00 + MINUTE), null);

        apply(trigger("n3_buy", "timeout", T_10_00 + 16 * MINUTE), "be-1");
        apply(trigger("n3_buy", "success", T_10_00 + 5 * MINUTE), null);

        assertEquals(List
            .of("be-1:n1_drop/next", "be-1:n2_vip/yes", "be-1:n3_buy/timeout", "be-2:n1_drop/next",
                "be-2:n2_vip/yes", "be-2:n3_buy/success", "be-2:n6_end/next"),
            transitions());
    }

    @Test
    void aTriggerBeforeAnyEntryAppliesToTheEntryTheSetupThenOpens() throws Exception {
        apply(trigger("n2_vip", "yes", T_10_00 + MINUTE), null);

        apply(trigger("n1_drop", "next", T_10_00), "be-1");

        assertEquals(List.of("be-1:n1_drop/next", "be-1:n2_vip/yes"), transitions());
    }

    @Test
    void aTriggerWithoutAnEntryIdReachesAnEntryWhoseSetupArrivesAfterIt() throws Exception {
        apply(trigger("n1_drop", "next", T_10_00), "be-1");
        apply(trigger("n2_vip", "yes", T_10_00 + 6 * MINUTE), null);

        apply(trigger("n1_drop", "next", T_10_00 + 5 * MINUTE), "be-2");

        assertEquals(List.of("be-1:n1_drop/next", "be-1:n2_vip/yes", "be-2:n1_drop/next", "be-2:n2_vip/yes"),
            transitions());
    }

    @Test
    void aTriggerWithoutAnEntryIdCountsOnceAgainstTheBufferLimit() throws Exception {
        harness.close();
        harness = priceDropCampaign(2);
        apply(trigger("n1_drop", "next", T_10_00), "be-1");
        apply(trigger("n1_drop", "next", T_10_00), "be-2");

        apply(trigger("n3_buy", "success", T_10_00 + 2 * MINUTE), null);
        apply(trigger("n3_buy", "success", T_10_00 + 3 * MINUTE), null);
        assertEquals(List.of(), stateLimit());

        JourneyTriggerEvent third = trigger("n3_buy", "success", T_10_00 + 4 * MINUTE);
        apply(third, null);
        assertEquals(List.of(third), stateLimit());
    }

    @Test
    void aTriggerWithoutAnEntryIdIsUnreachableOnlyWhenItCompletedNoEntry() throws Exception {
        apply(trigger("n1_drop", "next", T_10_00), "be-1");
        apply(trigger("n2_vip", "yes", T_10_00 + MINUTE), null);

        harness.watermark(T_10_00 + 10 * MINUTE);

        assertEquals(List.of(), sideOutput(JourneyStateMachineFunction.UNREACHABLE_EVENTS));
        assertEquals(List.of(), sideOutput(JourneyStateMachineFunction.LATE_EVENTS));
    }

    @Test
    void aWrongBranchTriggerWithoutAnEntryIdIsReportedOncePerEntryAtTheWatermark() throws Exception {
        apply(trigger("n1_drop", "next", T_10_00), "be-1");
        apply(trigger("n1_drop", "next", T_10_00), "be-2");
        apply(trigger("n2_vip", "yes", T_10_00 + MINUTE), null);
        apply(trigger("n3_buy", "success", T_10_00 + 2 * MINUTE), null);
        JourneyTriggerEvent wrongBranch = trigger("n4_active", "yes", T_10_00 + 3 * MINUTE);
        apply(wrongBranch, null);
        apply(wrongBranch, null);
        assertEquals(List.of(), sideOutput(JourneyStateMachineFunction.WRONG_BRANCH_EVENTS));

        harness.watermark(T_10_00 + 10 * MINUTE);

        assertEquals(List.of(), sideOutput(JourneyStateMachineFunction.UNREACHABLE_EVENTS));
        assertEquals(List.of(wrongBranch, wrongBranch), sideOutput(JourneyStateMachineFunction.WRONG_BRANCH_EVENTS));
    }

    @Test
    void aDuplicateTriggerWithoutAnEntryIdTakesNoBufferSlot() throws Exception {
        harness.close();
        harness = priceDropCampaign(2);
        apply(trigger("n1_drop", "next", T_10_00), "be-1");
        JourneyTriggerEvent first = trigger("n3_buy", "success", T_10_00 + 2 * MINUTE);
        apply(first, null);
        apply(first, null);

        apply(trigger("n3_buy", "success", T_10_00 + 3 * MINUTE), null);

        assertEquals(List.of(), stateLimit());
    }

    @Test
    void aTriggerThatAppliedIsNotReportedAtTheStateLimit() throws Exception {
        harness.close();
        harness = priceDropCampaign(1);
        apply(trigger("n1_drop", "next", T_10_00), "be-1");
        apply(trigger("n3_buy", "success", T_10_00 + 2 * MINUTE), null);

        apply(trigger("n2_vip", "yes", T_10_00 + MINUTE), null);

        assertEquals(List.of(), stateLimit());
        assertEquals(List.of("be-1:n1_drop/next", "be-1:n2_vip/yes", "be-1:n3_buy/success", "be-1:n6_end/next"),
            transitions());
    }

    private static KeyedBroadcastOperatorTestHarness<String, VersionedTrigger, Row, UserCampaignState> priceDropCampaign(
        int maxPendingMatchesPerEntry) throws Exception {
        KeyedBroadcastOperatorTestHarness<String, VersionedTrigger, Row, UserCampaignState> started = ProcessFunctionTestHarnesses
            .forKeyedBroadcastProcessFunction(new JourneyStateMachineFunction(GRAPHS, maxPendingMatchesPerEntry,
                4_194_304L, 7_776_000_000L, 300_000L), VersionedTrigger::journeyKey, Types.STRING, GRAPHS,
                JourneyStateMachineFunction.GRAPH_LOADS);
        for (Row row : List
            .of(row("n1_drop", "setup", null, null, null), row("n2_vip", "check", "n1_drop", "next", null),
                row("n3_buy", "watch", "n2_vip", "yes", PURCHASE_WATCH),
                row("n4_active", "check", "n3_buy", "timeout", null),
                row("n6_end", "end", "n3_buy", "success", null))) {
            started.processBroadcastElement(row, 0L);
        }
        return started;
    }

    private List<JourneyTriggerEvent> stateLimit() {
        return sideOutput(JourneyStateMachineFunction.STATE_LIMIT_EVENTS);
    }

    private List<JourneyTriggerEvent> sideOutput(OutputTag<JourneyTriggerEvent> tag) {
        Queue<StreamRecord<JourneyTriggerEvent>> dropped = harness.getSideOutput(tag);
        return dropped == null ? List.of() : dropped.stream().map(StreamRecord::getValue).toList();
    }

    private void apply(JourneyTriggerEvent trigger, String entryId) throws Exception {
        harness.processElement(new VersionedTrigger(trigger, null, entryId), trigger.eventTimestamp());
    }

    /**
     * The transitions written, sorted, since no order between entries is promised.
     */
    private List<String> transitions() {
        return harness
            .extractOutputValues()
            .stream()
            .map(state -> state.entryId() + ":" + state.nodeId() + "/" + state.branch())
            .sorted()
            .toList();
    }

    private static JourneyTriggerEvent trigger(String nodeId, String branch, long eventTimestamp) {
        return new JourneyTriggerEvent("canon-1", "domain-1", null, "user-1", "campaign-1", nodeId, branch,
            branch, eventTimestamp, "{}");
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
