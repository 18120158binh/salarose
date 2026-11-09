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
 * Each publish of a campaign writes its graph at a new version, and each
 * trigger carries the version of the graph it was decided against. A trigger
 * decided against a graph that a later publish replaced must not complete a
 * node of the new graph, even one under the same id (JEX-FR-12). A trigger
 * decided against a publish the state machine has not applied yet waits for
 * it. A resume writes the same graph at the same version.
 */
class TriggerGraphVersionTest {

    private static final long T_10_00 = 1_760_346_000_000L;
    private static final long MINUTE = 60_000L;
    private static final long ALLOWANCE = 10 * MINUTE;
    /** The wall clock when the job starts. */
    private static final long START = 1_760_400_000_000L;
    private static final MapStateDescriptor<String, CampaignGraph> GRAPHS = new MapStateDescriptor<>(
        "campaign-journey-graphs", Types.STRING, TypeInformation.of(CampaignGraph.class));
    private static final String CART_WATCH = """
        {"path_type":"SuccessOrTimeoutPath","limit":{"value":15,"unit":"minutes"}}""";
    private static final Row N1_VIEW = row("n1_view", "setup", null, null, null);
    private static final Row N2_VIP = row("n2_vip", "check", "n1_view", "next", null);
    private static final Row N3_CART = row("n3_cart", "watch", "n1_view", "next", CART_WATCH);
    private static final Row N5_SMS = row("n5_sms", "engagement", "n1_view", "next", null);

    private KeyedBroadcastOperatorTestHarness<String, VersionedTrigger, Row, UserCampaignState> harness;

    @AfterEach
    void close() throws Exception {
        harness.close();
    }

    /**
     * The campaign is deleted, and published again under the same ids. A
     * trigger decided against the deleted graph reaches the state machine after
     * the delete and waits for the graph. It must not complete the node
     * published again.
     */
    @Test
    void aTriggerDecidedBeforeADeleteDoesNotCompleteTheNodePublishedAgain() throws Exception {
        start();
        publish(1L, N1_VIEW, N2_VIP);
        apply(trigger("n1_view", "next", T_10_00), 1L);

        delete(N1_VIEW, N2_VIP);
        JourneyTriggerEvent stale = trigger("n2_vip", "yes", T_10_00 + 2 * MINUTE);
        apply(stale, 1L);
        publish(2L, N1_VIEW, N2_VIP);

        assertEquals(List.of("n1_view/next@" + T_10_00), transitions());
        assertEquals(List.of(stale), unreachable());
    }

    /**
     * The timeout of a watch that started before the delete fires after the
     * campaign is published again. It must not complete the watch published
     * again.
     */
    @Test
    void theTimeoutOfAWatchStartedBeforeADeleteDoesNotCompleteTheWatchPublishedAgain() throws Exception {
        start();
        publish(1L, N1_VIEW, N3_CART);
        apply(trigger("n1_view", "next", T_10_00), 1L);

        delete(N1_VIEW, N3_CART);
        publish(2L, N1_VIEW, N3_CART);
        JourneyTriggerEvent staleTimeout = trigger("n3_cart", "timeout", T_10_00 + 15 * MINUTE);
        apply(staleTimeout, 1L);

        assertEquals(List.of("n1_view/next@" + T_10_00), transitions());
        assertEquals(List.of(staleTimeout), unreachable());
    }

    /**
     * Customer decision applies a publish before the state machine reads its
     * first delete row, and decides a trigger against it that waits for its
     * parent. The delete must not drop it: it applies once the publish goes
     * live and its parent completes.
     */
    @Test
    void aTriggerDecidedAgainstAPublishTheStateMachineHasNotReadYetWaitsForIt() throws Exception {
        start();
        publish(1L, N1_VIEW, N2_VIP);
        apply(trigger("n2_vip", "yes", T_10_00 + 2 * MINUTE), 2L);

        delete(N1_VIEW, N2_VIP);
        publish(2L, N1_VIEW, N2_VIP);
        apply(trigger("n1_view", "next", T_10_00 + MINUTE), 2L);

        assertEquals(List.of("n1_view/next@" + (T_10_00 + MINUTE), "n2_vip/yes@" + (T_10_00 + 2 * MINUTE)),
            transitions());
        assertEquals(List.of(), unreachable());
    }

    /**
     * A trigger decided against a publish that added a node completes the node
     * against that publish, not against the older graph still live in the
     * state machine.
     */
    @Test
    void aTriggerAheadOfTheLiveGraphAppliesAgainstItsOwnPublish() throws Exception {
        start();
        publish(1L, N1_VIEW);
        apply(trigger("n1_view", "next", T_10_00), 2L);

        delete(N1_VIEW);
        publish(2L, N1_VIEW, N5_SMS);

        assertEquals(List.of("n1_view/next@" + T_10_00, "n5_sms/next@" + T_10_00), transitions());
    }

    /**
     * A trigger whose publish never reaches the state machine is unreachable
     * once the watermark passes it plus the graph-load allowance.
     */
    @Test
    void aTriggerAheadOfTheLiveGraphIsUnreachableAfterTheAllowance() throws Exception {
        start();
        publish(1L, N1_VIEW);
        JourneyTriggerEvent ahead = trigger("n1_view", "next", T_10_00);
        apply(ahead, 2L);

        harness.setProcessingTime(START + ALLOWANCE);
        harness.watermark(T_10_00 + ALLOWANCE);

        assertEquals(List.of(), transitions());
        assertEquals(List.of(ahead), unreachable());
    }

    /**
     * A resume writes the published graph again at its version, so a trigger
     * buffered before it still applies.
     */
    @Test
    void aTriggerBufferedBeforeAResumeStillApplies() throws Exception {
        start();
        publish(1L, N1_VIEW, N2_VIP);
        apply(trigger("n2_vip", "yes", T_10_00 + 2 * MINUTE), 1L);

        delete(N1_VIEW, N2_VIP);
        publish(1L, N1_VIEW, N2_VIP);
        apply(trigger("n1_view", "next", T_10_00 + MINUTE), 1L);

        assertEquals(List.of("n1_view/next@" + (T_10_00 + MINUTE), "n2_vip/yes@" + (T_10_00 + 2 * MINUTE)),
            transitions());
    }

    /** The timeout of a watch that started before a resume still applies. */
    @Test
    void theTimeoutOfAWatchStartedBeforeAResumeStillApplies() throws Exception {
        start();
        publish(1L, N1_VIEW, N3_CART);
        apply(trigger("n1_view", "next", T_10_00), 1L);

        delete(N1_VIEW, N3_CART);
        publish(1L, N1_VIEW, N3_CART);
        apply(trigger("n3_cart", "timeout", T_10_00 + 15 * MINUTE), 1L);

        assertEquals(List.of("n1_view/next@" + T_10_00, "n3_cart/timeout@" + (T_10_00 + 15 * MINUTE)),
            transitions());
    }

    /**
     * A trigger written before producers set the version, during a rolling
     * deploy, applies against whatever graph is live.
     */
    @Test
    void aTriggerWithoutAVersionApplies() throws Exception {
        start();
        publish(1L, N1_VIEW);
        delete(N1_VIEW);
        publish(2L, N1_VIEW);
        apply(trigger("n1_view", "next", T_10_00), null);

        assertEquals(List.of("n1_view/next@" + T_10_00), transitions());
    }

    private void start() throws Exception {
        harness = ProcessFunctionTestHarnesses
            .forKeyedBroadcastProcessFunction(
                new JourneyStateMachineFunction(GRAPHS, 1000, 4_194_304L, 7_776_000_000L, ALLOWANCE),
                VersionedTrigger::journeyKey, Types.STRING, GRAPHS, JourneyStateMachineFunction.GRAPH_LOADS);
        harness.setProcessingTime(START);
    }

    /** Studio's publish: every row carries the size and the version of the save. */
    private void publish(long graphVersion, Row... rows) throws Exception {
        for (Row row : rows) {
            Row inserted = Row.copy(row);
            inserted.setField("campaign_node_count", rows.length);
            inserted.setField("graph_version", graphVersion);
            harness.processBroadcastElement(inserted, 0L);
        }
    }

    private void delete(Row... rows) throws Exception {
        for (Row row : rows) {
            Row deleted = Row.copy(row);
            deleted.setKind(RowKind.DELETE);
            harness.processBroadcastElement(deleted, 0L);
        }
    }

    private void apply(JourneyTriggerEvent trigger, Long graphVersion) throws Exception {
        harness.processElement(new VersionedTrigger(trigger, graphVersion), trigger.eventTimestamp());
    }

    private List<String> transitions() {
        return harness
            .extractOutputValues()
            .stream()
            .map(state -> state.nodeId() + "/" + state.branch() + "@" + state.eventTimestamp())
            .toList();
    }

    private List<JourneyTriggerEvent> unreachable() {
        Queue<StreamRecord<JourneyTriggerEvent>> records = harness
            .getSideOutput(JourneyStateMachineFunction.UNREACHABLE_EVENTS);
        return records == null ? List.of() : records.stream().map(StreamRecord::getValue).toList();
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
        row.setField("action_json", "engagement".equals(nodeType) ? "{\"channel\":\"sms\"}" : null);
        row.setField("goal_id", null);
        row.setField("campaign_node_count", null);
        row.setField("graph_version", null);
        return row;
    }
}
