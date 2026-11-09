package com.cdp.platform.jobs.statemachine.transforms;

import java.util.Arrays;
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
import static org.junit.jupiter.api.Assertions.assertFalse;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * On a fresh start the trigger backlog can move the watermark past triggers
 * whose campaign graph has not arrived from the {@code campaign_nodes}
 * snapshot yet. Those triggers wait for the graph, not for the watermark. A
 * trigger whose node is not in the graph yet waits for the save that adds it
 * the same way. The wait ends when the watermark passes the trigger's event
 * time plus
 * the graph-load allowance, so a trigger for a deleted node or campaign does
 * not stay buffered.
 */
class CampaignGraphArrivalTest {

    private static final long T_10_00 = 1_760_346_000_000L;
    private static final long MINUTE = 60_000L;
    private static final long ALLOWANCE = 10 * MINUTE;
    /** The wall clock when the job starts. */
    private static final long START = 1_760_400_000_000L;
    private static final MapStateDescriptor<String, CampaignGraph> GRAPHS = new MapStateDescriptor<>(
        "campaign-journey-graphs", Types.STRING, TypeInformation.of(CampaignGraph.class));
    private static final Row N1_VIEW = row("n1_view", "setup", null, null);
    private static final Row N2_VIP = row("n2_vip", "check", "n1_view", "next");
    private static final Row N3_CART = row("n3_cart", "watch", "n2_vip", "yes");
    private static final Row N4_ACTIVE = row("n4_active", "check", "n3_cart", "timeout");
    private static final Row N7_PROMO = row("n7_promo", "check", "n2_vip", "yes");
    private static final Row N8_REPEAT = row("n8_repeat", "check", "n7_promo", "yes");

    private KeyedBroadcastOperatorTestHarness<String, VersionedTrigger, Row, UserCampaignState> harness;

    @AfterEach
    void close() throws Exception {
        harness.close();
    }

    @Test
    void aTriggerWaitsForItsCampaignGraphPastTheWatermark() throws Exception {
        start();
        apply(trigger("n1_view", "next", T_10_00 + MINUTE));

        harness.watermark(T_10_00 + 10 * MINUTE);
        assertEquals(List.of(), unreachable());
        assertEquals(List.of(), late());

        loadGraph(N1_VIEW, N2_VIP);
        assertEquals(List.of("n1_view/next@" + (T_10_00 + MINUTE)), transitions());
    }

    @Test
    void triggersReleasedByTheGraphApplyInEventTimeOrder() throws Exception {
        start();
        apply(trigger("n1_view", "next", T_10_00 + 5 * MINUTE));
        apply(trigger("n2_vip", "yes", T_10_00 + 3 * MINUTE));
        apply(trigger("n1_view", "next", T_10_00 + MINUTE));
        harness.watermark(T_10_00 + 10 * MINUTE);

        loadGraph(N1_VIEW, N2_VIP);

        assertEquals(List.of("n1_view/next@" + (T_10_00 + MINUTE), "n2_vip/yes@" + (T_10_00 + 3 * MINUTE)),
            transitions());
        assertEquals(List.of(), unreachable());
    }

    @Test
    void aGraphThatArrivesChildFirstStillAppliesEveryTrigger() throws Exception {
        start();
        apply(trigger("n1_view", "next", T_10_00 + MINUTE));
        apply(trigger("n2_vip", "yes", T_10_00 + 2 * MINUTE));
        harness.watermark(T_10_00 + 10 * MINUTE);

        loadGraph(N2_VIP, N1_VIEW);

        assertEquals(List.of("n1_view/next@" + (T_10_00 + MINUTE), "n2_vip/yes@" + (T_10_00 + 2 * MINUTE)),
            transitions());
        assertEquals(List.of(), unreachable());
    }

    @Test
    void aTriggerPastTheWatermarkThatStillCannotApplyWhenItsGraphLoadsIsUnreachable() throws Exception {
        start();
        JourneyTriggerEvent orphan = trigger("n2_vip", "yes", T_10_00 + MINUTE);
        apply(orphan);
        harness.watermark(T_10_00 + 10 * MINUTE);

        loadGraph(N1_VIEW, N2_VIP);

        assertEquals(List.of(), transitions());
        assertEquals(List.of(orphan), unreachable());
    }

    @Test
    void aTriggerAheadOfTheWatermarkStillWaitsForItsParentAfterTheGraphLoads() throws Exception {
        start();
        harness.watermark(T_10_00);
        JourneyTriggerEvent waiting = trigger("n2_vip", "yes", T_10_00 + 30 * MINUTE);
        apply(waiting);

        loadGraph(N1_VIEW, N2_VIP);
        assertEquals(List.of(), unreachable());

        harness.watermark(T_10_00 + 40 * MINUTE);
        assertEquals(List.of(waiting), unreachable());
    }

    @Test
    void aTriggerWaitsForTheSaveThatAddsItsNode() throws Exception {
        start();
        loadGraph(N1_VIEW);
        apply(trigger("n1_view", "next", T_10_00 + MINUTE));
        apply(trigger("n2_vip", "yes", T_10_00 + 2 * MINUTE));

        save(List.of(N1_VIEW), List.of(N1_VIEW, N2_VIP));

        assertEquals(List.of("n1_view/next@" + (T_10_00 + MINUTE), "n2_vip/yes@" + (T_10_00 + 2 * MINUTE)),
            transitions());
    }

    @Test
    void aTriggerWhoseNodeArrivesWithinTheAllowanceStillApplies() throws Exception {
        start();
        apply(trigger("n1_view", "next", T_10_00 + MINUTE));
        apply(trigger("n2_vip", "yes", T_10_00 + 2 * MINUTE));
        loadGraph(N1_VIEW);
        harness.watermark(T_10_00 + 10 * MINUTE);
        assertEquals(List.of(), unreachable());

        save(List.of(N1_VIEW), List.of(N1_VIEW, N2_VIP));

        assertEquals(List.of("n1_view/next@" + (T_10_00 + MINUTE), "n2_vip/yes@" + (T_10_00 + 2 * MINUTE)),
            transitions());
        assertEquals(List.of(), unreachable());
    }

    @Test
    void aTriggerPastTheWatermarkThatStillCannotApplyWhenItsNodeLoadsIsUnreachable() throws Exception {
        start();
        loadGraph(N1_VIEW);
        JourneyTriggerEvent orphan = trigger("n2_vip", "yes", T_10_00 + MINUTE);
        apply(orphan);
        harness.watermark(T_10_00 + 10 * MINUTE);
        assertEquals(List.of(), unreachable());

        save(List.of(N1_VIEW), List.of(N1_VIEW, N2_VIP));

        assertEquals(List.of(), transitions());
        assertEquals(List.of(orphan), unreachable());
    }

    @Test
    void aCampaignWhoseNodesAreAllDeletedKeepsNoGraph() throws Exception {
        start();
        loadGraph(N1_VIEW, N2_VIP);

        loadGraph(deleted(N2_VIP), deleted(N1_VIEW));

        assertFalse(harness.getBroadcastState(GRAPHS).contains("campaign-2"));
    }

    @Test
    void aTriggerWhoseNodeArrivesAfterTheAllowanceIsUnreachable() throws Exception {
        start();
        loadGraph(N1_VIEW);
        apply(trigger("n1_view", "next", T_10_00 + MINUTE));
        JourneyTriggerEvent orphan = trigger("n2_vip", "yes", T_10_00 + 2 * MINUTE);
        apply(orphan);

        runPastTheStartGrace();
        harness.watermark(T_10_00 + 2 * MINUTE + ALLOWANCE);
        assertEquals(List.of(orphan), unreachable());

        save(List.of(N1_VIEW), List.of(N1_VIEW, N2_VIP));
        assertEquals(List.of("n1_view/next@" + (T_10_00 + MINUTE)), transitions());
    }

    @Test
    void aTriggerWhoseCampaignGraphNeverArrivesIsUnreachableAfterTheAllowance() throws Exception {
        start();
        JourneyTriggerEvent orphan = trigger("n1_view", "next", T_10_00 + MINUTE);
        apply(orphan);

        runPastTheStartGrace();
        harness.watermark(T_10_00 + MINUTE + ALLOWANCE - 1);
        assertEquals(List.of(), unreachable());

        harness.watermark(T_10_00 + MINUTE + ALLOWANCE);
        assertEquals(List.of(orphan), unreachable());
    }

    /**
     * On a fresh start the trigger backlog moves the watermark hours ahead in
     * seconds, while the snapshot of {@code campaign_nodes} still loads. The
     * allowance also runs in real time from the start, so the trigger waits
     * for its graph.
     */
    @Test
    void aBacklogOnAFreshStartDoesNotOutrunTheGraphLoad() throws Exception {
        start();
        apply(trigger("n1_view", "next", T_10_00 + MINUTE));
        apply(trigger("n2_vip", "yes", T_10_00 + 2 * MINUTE));

        harness.setProcessingTime(START + 5_000L);
        harness.watermark(T_10_00 + 120 * MINUTE);
        assertEquals(List.of(), unreachable());

        loadGraph(N1_VIEW, N2_VIP);
        assertEquals(List.of("n1_view/next@" + (T_10_00 + MINUTE), "n2_vip/yes@" + (T_10_00 + 2 * MINUTE)),
            transitions());
    }

    @Test
    void aTriggerWhoseGraphNeverArrivesIsUnreachableOnceTheAllowanceHasRunInRealTime() throws Exception {
        start();
        JourneyTriggerEvent orphan = trigger("n1_view", "next", T_10_00 + MINUTE);
        apply(orphan);
        harness.watermark(T_10_00 + 120 * MINUTE);

        harness.setProcessingTime(START + ALLOWANCE - 1);
        assertEquals(List.of(), unreachable());

        harness.setProcessingTime(START + ALLOWANCE);
        assertEquals(List.of(orphan), unreachable());
    }

    /**
     * A campaign is deleted while a trigger for one of its nodes waits for its
     * parent, and a campaign with the same id and node ids is published again.
     * The waiting trigger was decided against the deleted campaign, so it must
     * not complete the new node when the parent completes.
     */
    @Test
    void aTriggerBufferedBeforeItsCampaignWasDeletedDoesNotCompleteANodeAddedAgain() throws Exception {
        start();
        loadGraph(N1_VIEW, N2_VIP);
        JourneyTriggerEvent stale = trigger("n2_vip", "yes", T_10_00 + 2 * MINUTE);
        apply(stale);

        loadGraph(deleted(N1_VIEW), deleted(N2_VIP));
        loadGraph(N1_VIEW, N2_VIP);
        apply(trigger("n1_view", "next", T_10_00 + MINUTE));

        assertEquals(List.of("n1_view/next@" + (T_10_00 + MINUTE)), transitions());
        assertEquals(List.of(stale), unreachable());
    }

    /**
     * A save deletes every row and inserts each one again in one transaction. A
     * trigger that arrives while the save loads waits for it and then applies.
     */
    @Test
    void aTriggerThatArrivesWhileASaveLoadsStillApplies() throws Exception {
        start();
        loadGraph(N1_VIEW, N2_VIP);
        apply(trigger("n1_view", "next", T_10_00 + MINUTE));

        loadGraph(deleted(N1_VIEW), deleted(N2_VIP));
        apply(trigger("n2_vip", "yes", T_10_00 + 2 * MINUTE));
        loadGraph(N1_VIEW, N2_VIP);

        assertEquals(List.of("n1_view/next@" + (T_10_00 + MINUTE), "n2_vip/yes@" + (T_10_00 + 2 * MINUTE)),
            transitions());
        assertEquals(List.of(), unreachable());
    }

    /**
     * The reviewer's probe, with the buffer limited to two triggers. A watch
     * node is deleted after its parent completed. Its timeout still comes from
     * the timer flow, and a trigger for its child already waits for it.
     */
    @Test
    void triggersForADeletedWatchNodeAndItsChildAreUnreachableAfterTheAllowance() throws Exception {
        start(2);
        List<Row> campaign = List.of(N1_VIEW, N2_VIP, N3_CART, N4_ACTIVE, N7_PROMO, N8_REPEAT);
        loadGraph(campaign.toArray(Row[]::new));
        apply(trigger("n1_view", "next", T_10_00));
        apply(trigger("n2_vip", "yes", T_10_00 + MINUTE));
        JourneyTriggerEvent waitingForDeletedParent = trigger("n4_active", "yes", T_10_00 + 5 * MINUTE);
        apply(waitingForDeletedParent);
        save(campaign, List.of(N1_VIEW, N2_VIP, N4_ACTIVE, N7_PROMO, N8_REPEAT));
        JourneyTriggerEvent deletedWatchTimeout = trigger("n3_cart", "timeout", T_10_00 + 16 * MINUTE);
        apply(deletedWatchTimeout);

        runPastTheStartGrace();
        harness.watermark(T_10_00 + 16 * MINUTE + ALLOWANCE);
        assertEquals(List.of(waitingForDeletedParent, deletedWatchTimeout), unreachable());

        long later = T_10_00 + 600 * MINUTE;
        apply(trigger("n8_repeat", "yes", later + 2 * MINUTE));
        apply(trigger("n8_repeat", "yes", later + 3 * MINUTE));
        assertEquals(List.of(), stateLimit());
        apply(trigger("n7_promo", "yes", later + MINUTE));

        assertEquals(List
            .of("n1_view/next@" + T_10_00, "n2_vip/yes@" + (T_10_00 + MINUTE), "n7_promo/yes@" + (later + MINUTE),
                "n8_repeat/yes@" + (later + 2 * MINUTE)),
            transitions());
    }

    private void start() throws Exception {
        start(1000);
    }

    private void start(int maxPendingMatches) throws Exception {
        harness = ProcessFunctionTestHarnesses
            .forKeyedBroadcastProcessFunction(
                new JourneyStateMachineFunction(GRAPHS, maxPendingMatches, 4_194_304L, 7_776_000_000L, ALLOWANCE),
                VersionedTrigger::journeyKey, Types.STRING, GRAPHS,
                JourneyStateMachineFunction.GRAPH_LOADS);
        harness.setProcessingTime(START);
    }

    /** The job has run for the allowance in real time since it started. */
    private void runPastTheStartGrace() throws Exception {
        harness.setProcessingTime(START + ALLOWANCE);
    }

    /**
     * Sends the rows as one change, the way a save or the snapshot on a fresh
     * start writes them: each inserted row carries the number of rows inserted.
     */
    private void loadGraph(Row... rows) throws Exception {
        long inserted = Arrays.stream(rows).filter(row -> row.getKind() == RowKind.INSERT).count();
        for (Row row : rows) {
            Row counted = Row.copy(row);
            if (row.getKind() == RowKind.INSERT) {
                counted.setField("campaign_node_count", (int) inserted);
            }
            harness.processBroadcastElement(counted, 0L);
        }
    }

    /** Studio's save: delete every node row, then insert each one again. */
    private void save(List<Row> before, List<Row> after) throws Exception {
        loadGraph(before.stream().map(CampaignGraphArrivalTest::deleted).toArray(Row[]::new));
        loadGraph(after.toArray(Row[]::new));
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

    private List<JourneyTriggerEvent> unreachable() {
        return sideOutput(harness.getSideOutput(JourneyStateMachineFunction.UNREACHABLE_EVENTS));
    }

    private List<JourneyTriggerEvent> stateLimit() {
        return sideOutput(harness.getSideOutput(JourneyStateMachineFunction.STATE_LIMIT_EVENTS));
    }

    private List<JourneyTriggerEvent> late() {
        return sideOutput(harness.getSideOutput(JourneyStateMachineFunction.LATE_EVENTS));
    }

    private static List<JourneyTriggerEvent> sideOutput(Queue<StreamRecord<JourneyTriggerEvent>> records) {
        return records == null ? List.of() : records.stream().map(StreamRecord::getValue).toList();
    }

    private static JourneyTriggerEvent trigger(String nodeId, String branch, long eventTimestamp) {
        return new JourneyTriggerEvent("canon-1", "domain-1", null, "user-1", "campaign-2", nodeId, branch, "event",
            eventTimestamp, "{}");
    }

    private static Row deleted(Row row) {
        Row deleted = Row.copy(row);
        deleted.setKind(RowKind.DELETE);
        return deleted;
    }

    private static Row row(String nodeId, String nodeType, String parentNodeId, String parentBranch) {
        Row row = Row.withNames(RowKind.INSERT);
        row.setField("campaign_id", "campaign-2");
        row.setField("node_id", nodeId);
        row.setField("node_type", nodeType);
        row.setField("parent_node_id", parentNodeId);
        row.setField("parent_branch", parentBranch);
        row.setField("trigger_json", null);
        row.setField("conditions_json", null);
        row.setField("paths_json", null);
        row.setField("action_json", null);
        row.setField("goal_id", null);
        row.setField("graph_version", 1L);
        return row;
    }
}
