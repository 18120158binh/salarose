package com.cdp.platform.jobs.outbox.flows;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.runtime.checkpoint.OperatorSubtaskState;
import org.apache.flink.streaming.api.operators.KeyedProcessOperator;
import org.apache.flink.streaming.util.KeyedOneInputStreamOperatorTestHarness;
import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;

import com.cdp.platform.jobs.outbox.flows.CampaignTimerFlow.WatchTimeout;
import com.cdp.platform.jobs.statemachine.engine.TransitionEngine;
import com.cdp.platform.jobs.statemachine.model.CampaignGraph;
import com.cdp.platform.jobs.statemachine.model.GraphNode;
import com.cdp.platform.shared.db.repositories.UserCampaignStateTransitionsTable;
import com.cdp.platform.shared.models.JourneyTriggerEvent;
import com.cdp.platform.shared.models.VersionedTrigger;
import com.cdp.platform.shared.models.db.UserCampaignState;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

/**
 * The timer flow reads each watch child that a completed node lists, and emits
 * the watch's timeout trigger at its deadline: the node's event time plus the
 * watch limit. The watch's limit is parsed once, when its row loads into the
 * state machine's graph, and reaches the timer flow in the transition row. A
 * timeout must not be lost when the timer flow is down past the
 * deadline. It fires when the flow recovers, with the deadline as its event
 * time. Processing time is the wall clock in production, so the tests set it to
 * wall-clock times.
 */
class WatchTimerProcessFunctionTest {

    private static final long MINUTE = 60_000L;
    private static final long DAY = 24 * 60 * MINUTE;
    private static final String CART_WATCH = """
        {"path_type":"SuccessOrTimeoutPath","limit":{"value":15,"unit":"minutes"}}""";

    private final long checkCompleted = System.currentTimeMillis() - 5 * MINUTE;

    @Test
    void aTimerRestoredAfterItsDeadlineFiresWithTheDeadlineAsEventTime() throws Exception {
        OperatorSubtaskState checkpoint;
        try (KeyedOneInputStreamOperatorTestHarness<String, WatchTimeout, VersionedTrigger> before = harness()) {
            before.open();
            before.setProcessingTime(checkCompleted + 5 * MINUTE);
            schedule(before, CART_WATCH);
            assertEquals(List.of(), triggers(before));
            checkpoint = before.snapshot(1L, 1L);
        }

        try (KeyedOneInputStreamOperatorTestHarness<String, WatchTimeout, VersionedTrigger> after = harness()) {
            after.initializeState(checkpoint);
            after.open();
            after.setProcessingTime(checkCompleted + 30 * MINUTE);

            assertEquals(List.of("n3_cart/timeout@" + (checkCompleted + 15 * MINUTE)), triggers(after));
        }
    }

    @Test
    void aWatchWhoseDeadlinePassedBeforeItArrivedFiresAtOnceWithTheDeadlineAsEventTime() throws Exception {
        long longAgo = System.currentTimeMillis() - 30 * MINUTE;
        try (KeyedOneInputStreamOperatorTestHarness<String, WatchTimeout, VersionedTrigger> late = harness()) {
            late.open();
            late.setProcessingTime(longAgo + 30 * MINUTE);
            for (WatchTimeout watch : watchesAfter(longAgo, CART_WATCH)) {
                late.processElement(watch, longAgo);
            }

            assertEquals(List.of("n3_cart/timeout@" + (longAgo + 15 * MINUTE)), triggers(late));
        }
    }

    @Test
    void theDeadlineIsTheNodesEventTimePlusTheWatchLimit() throws Exception {
        Map<String, Long> limits = Map
            .of(
                watch("\"value\":30,\"unit\":\"seconds\""), 30_000L,
                watch("\"value\":2,\"unit\":\"hours\""), 120 * MINUTE,
                watch("\"value\":1.5,\"unit\":\"hours\""), 90 * MINUTE,
                watch("\"value\":3,\"unit\":\"days\""), 3 * DAY,
                watch("\"value\":30000,\"unit\":\"days\""), 30_000 * DAY,
                "{\"path_type\":\"SuccessOrTimeoutPath\"}", 15 * MINUTE);
        for (Map.Entry<String, Long> limit : limits.entrySet()) {
            long deadline = checkCompleted + limit.getValue();
            try (KeyedOneInputStreamOperatorTestHarness<String, WatchTimeout, VersionedTrigger> timer = harness()) {
                timer.open();
                timer.setProcessingTime(checkCompleted + 5 * MINUTE);
                schedule(timer, limit.getKey());
                timer.setProcessingTime(deadline);

                assertEquals(List.of("n3_cart/timeout@" + deadline), triggers(timer), limit.getKey());
            }
        }
    }

    @Test
    void aWatchWithAnInvalidLimitGetsNoTimer() throws Exception {
        List<String> invalid = List
            .of(
                watch("\"value\":15,\"unit\":\"weeks\""),
                watch("\"value\":0,\"unit\":\"minutes\""),
                watch("\"value\":-5,\"unit\":\"minutes\""),
                watch("\"value\":\"fifteen\",\"unit\":\"minutes\""),
                watch("\"value\":15,\"unit\":7"),
                watch("\"value\":1e300,\"unit\":\"days\""));
        for (String condition : invalid) {
            try (KeyedOneInputStreamOperatorTestHarness<String, WatchTimeout, VersionedTrigger> timer = harness()) {
                timer.open();
                timer.setProcessingTime(checkCompleted + 5 * MINUTE);
                schedule(timer, condition);
                timer.setProcessingTime(checkCompleted + 400 * DAY);

                assertEquals(List.of(), triggers(timer), condition);
            }
        }
    }

    /**
     * The transition CDC source reads a snapshot again after a restart, so the
     * same transition can arrive twice. Its watch still fires once.
     */
    @Test
    void aReplayedTransitionSchedulesItsWatchOnce() throws Exception {
        try (KeyedOneInputStreamOperatorTestHarness<String, WatchTimeout, VersionedTrigger> timer = harness()) {
            timer.open();
            timer.setProcessingTime(checkCompleted + 5 * MINUTE);
            schedule(timer, CART_WATCH);
            schedule(timer, CART_WATCH);
            timer.setProcessingTime(checkCompleted + 30 * MINUTE);

            assertEquals(List.of("n3_cart/timeout@" + (checkCompleted + 15 * MINUTE)), triggers(timer));
        }
    }

    /**
     * A person's two entries that wait at the same watch keep a timer each, and
     * each timeout names its entry. A replayed transition replaces its own
     * entry's watch (JEX-NFR-06).
     */
    @Test
    void twoEntriesAtOneWatchGetATimeoutEach() throws Exception {
        long deadline = checkCompleted + 15 * MINUTE;
        try (KeyedOneInputStreamOperatorTestHarness<String, WatchTimeout, VersionedTrigger> timer = harness()) {
            timer.open();
            timer.setProcessingTime(checkCompleted + 5 * MINUTE);
            for (String entryId : List.of("be-1", "be-2", "be-1")) {
                for (WatchTimeout watch : CampaignTimerFlow
                    .watchTimeouts(checkTransition(checkCompleted, CART_WATCH, 1L, entryId))) {
                    timer.processElement(watch, checkCompleted);
                }
            }
            timer.setProcessingTime(deadline);

            assertEquals(List.of("be-1:n3_cart/timeout@" + deadline, "be-2:n3_cart/timeout@" + deadline),
                timer
                    .extractOutputValues()
                    .stream()
                    .map(trigger -> trigger.entryId() + ":" + trigger.trigger().nodeId() + "/"
                        + trigger.trigger().branch() + "@" + trigger.trigger().eventTimestamp())
                    .sorted()
                    .toList());
        }
    }

    /**
     * Each timer removes its watch when it fires, so the state stays bounded
     * without a TTL. A watch or a delay longer than the journey state TTL, 90
     * days by default, still fires.
     */
    @Test
    void aWatchLongerThanTheJourneyStateTtlStillFires() throws Exception {
        long deadline = checkCompleted + 120 * DAY;
        try (KeyedOneInputStreamOperatorTestHarness<String, WatchTimeout, VersionedTrigger> timer = harness()) {
            timer.open();
            timer.setStateTtlProcessingTime(checkCompleted);
            timer.setProcessingTime(checkCompleted);
            schedule(timer, "{\"path_type\":\"DelayPath\",\"limit\":{\"value\":120,\"unit\":\"days\"}}");

            timer.setStateTtlProcessingTime(deadline);
            timer.setProcessingTime(deadline);

            assertEquals(List.of("n3_cart/next@" + deadline), triggers(timer));
        }
    }

    /**
     * A timeout carries the version of the graph that listed its watch, so the
     * state machine can tell which graph it was decided against.
     */
    @Test
    void aTimeoutCarriesTheGraphVersionThatListedItsWatch() throws Exception {
        try (KeyedOneInputStreamOperatorTestHarness<String, WatchTimeout, VersionedTrigger> timer = harness()) {
            timer.open();
            timer.setProcessingTime(checkCompleted + 5 * MINUTE);
            for (WatchTimeout watch : CampaignTimerFlow
                .watchTimeouts(checkTransition(checkCompleted, CART_WATCH, 7L, VersionedTrigger.FIRST_ENTRY))) {
                timer.processElement(watch, checkCompleted);
            }
            timer.setProcessingTime(checkCompleted + 15 * MINUTE);

            assertEquals(List.of(7L),
                timer.extractOutputValues().stream().map(VersionedTrigger::graphVersion).toList());
        }
    }

    private static KeyedOneInputStreamOperatorTestHarness<String, WatchTimeout, VersionedTrigger> harness()
        throws Exception {
        return new KeyedOneInputStreamOperatorTestHarness<>(
            new KeyedProcessOperator<>(new WatchTimerProcessFunction()), WatchTimeout::journeyKey, Types.STRING);
    }

    private void schedule(KeyedOneInputStreamOperatorTestHarness<String, WatchTimeout, VersionedTrigger> timer,
        String condition) throws Exception {
        for (WatchTimeout watch : watchesAfter(checkCompleted, condition)) {
            timer.processElement(watch, checkCompleted);
        }
    }

    /**
     * The watches the timer flow reads from the transition of the check that
     * precedes the watch.
     */
    private static List<WatchTimeout> watchesAfter(long checkCompleted, String condition) {
        return CampaignTimerFlow
            .watchTimeouts(checkTransition(checkCompleted, condition, 1L, VersionedTrigger.FIRST_ENTRY));
    }

    /**
     * The transition of the check {@code n2_vip}, as the timer flow reads it
     * from CDC after the state machine completed the check against a graph in
     * which the watch {@code n3_cart} has this condition, in one entry.
     */
    private static UserCampaignState checkTransition(long checkCompleted, String condition, long graphVersion,
        String entryId) {
        CampaignGraph graph = new CampaignGraph();
        for (Row row : List
            .of(row("n2_vip", "check", null, null, null), row("n3_cart", "watch", "n2_vip", "yes",
                condition))) {
            graph = GraphNode.fromRow(row).map(graph::upsert).orElse(graph);
        }
        JourneyTriggerEvent check = new JourneyTriggerEvent("canon-1", "domain-1", null, "user-1", "campaign-1",
            "n2_vip", "yes", "event", checkCompleted, "{}");
        UserCampaignState completed = new TransitionEngine()
            .evaluate(check, entryId, graph.withRowOf(graphVersion), new HashMap<>())
            .transitions()
            .getFirst();

        Row cdc = Row.withNames(RowKind.INSERT);
        cdc.setField("canon_id", completed.canonId());
        cdc.setField("domain_userid", completed.domainUserId());
        cdc.setField("network_userid", completed.networkUserId());
        cdc.setField("user_id", completed.userId());
        cdc.setField("campaign_id", completed.campaignId());
        cdc.setField("entry_id", completed.entryId());
        cdc.setField("node_id", completed.nodeId());
        cdc.setField("branch", completed.branch());
        cdc.setField("event_timestamp", completed.eventTimestamp());
        cdc.setField("node_type", completed.nodeType().name());
        cdc.setField("action_json", completed.actionJson());
        cdc.setField("context_json", completed.contextJson());
        cdc.setField("children", UserCampaignStateTransitionsTable.childrenJson(completed.watchChildren()));
        cdc.setField("event_id", completed.eventId());
        return UserCampaignStateTransitionsTable.transition(cdc).orElseThrow();
    }

    /** A watch's paths as studio saves them, with these limit fields. */
    private static String watch(String limitFields) {
        return "{\"path_type\":\"SuccessOrTimeoutPath\",\"limit\":{" + limitFields + "}}";
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

    private static List<String> triggers(
        KeyedOneInputStreamOperatorTestHarness<String, WatchTimeout, VersionedTrigger> harness) {
        return harness
            .extractOutputValues()
            .stream()
            .map(VersionedTrigger::trigger)
            .map(trigger -> trigger.nodeId() + "/" + trigger.branch() + "@" + trigger.eventTimestamp())
            .toList();
    }
}
