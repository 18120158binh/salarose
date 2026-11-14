package com.cdp.platform.jobs.customerdecision.transforms;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Queue;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;

import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.typeinfo.TypeHint;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.streaming.runtime.streamrecord.StreamRecord;
import org.apache.flink.streaming.util.KeyedBroadcastOperatorTestHarness;
import org.apache.flink.streaming.util.ProcessFunctionTestHarnesses;
import org.apache.flink.types.Either;
import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;

import com.cdp.platform.jobs.statemachine.model.CampaignGraph;
import com.cdp.platform.jobs.statemachine.transforms.JourneyStateMachineFunction;
import com.cdp.platform.shared.db.repositories.RecordingDatabase;
import com.cdp.platform.shared.models.Event;
import com.cdp.platform.shared.models.MetricSeries;
import com.cdp.platform.shared.models.SegmentCheck;
import com.cdp.platform.shared.models.VersionedTrigger;
import com.cdp.platform.shared.models.db.MetricConfig;
import com.cdp.platform.shared.models.db.UserCampaignState;
import com.cdp.platform.shared.models.db.UserMetric;
import com.cdp.platform.shared.models.db.UserProfile;
import com.cdp.platform.shared.models.node.MetricFunction;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * A segment checked when a person reaches it, run through the operators of
 * customer decision and the journey state machine. Each Kafka hop between the
 * two jobs, triggers one way and segment checks the other, is a hand-off here,
 * and each record crosses it through its serializer.
 *
 * <p>
 * The journey is {@code n1_view}, a setup on {@code view_product}, then
 * {@code n7_buyer}, a segment on {@code COUNT(m_purchase_count) >= 2}, then
 * {@code n8_push}, an engagement on the segment's {@code yes}.
 */
class SegmentArrivalTest {

    private static final long HOUR = 3_600_000L;
    private static final long DAY = 24 * HOUR;
    private static final long T = 1_785_800_000_000L;
    private static final MapStateDescriptor<String, CampaignGraph> GRAPHS = new MapStateDescriptor<>(
        "campaign-journey-graphs", Types.STRING, TypeInformation.of(CampaignGraph.class));
    private static final String PURCHASED_TWICE = """
        {"groups":[{"conditions":[{"type":"behavior","metric_id":"m_purchase_count","event":"purchase",
         "measure":"COUNT","window":{"value":30,"unit":"DAYS"},"op":">=","value":2}]}]}""";
    private static final TypeInformation<Either<Event, SegmentCheck>> INPUT = TypeInformation
        .of(new TypeHint<Either<Event, SegmentCheck>>() {
        });

    /** The person's rows in {@code user_metrics}. */
    private final List<UserMetric> storedRows = new CopyOnWriteArrayList<>();
    /** Every segment check the state machine sent, in order. */
    private final List<SegmentCheck> sentChecks = new ArrayList<>();
    /**
     * When set, the state machine's watermark moves here after it sends checks and
     * before their answers arrive, as when the answers take long.
     */
    private Long watermarkBeforeAnswers;
    private DecisionPipeline decision;
    private KeyedBroadcastOperatorTestHarness<String, VersionedTrigger, Row, UserCampaignState> stateMachine;

    @BeforeEach
    void start() throws Exception {
        decision = new DecisionPipeline(new RecordingDatabase(storedRows).userMetrics(), new NoProfiles());
        stateMachine = ProcessFunctionTestHarnesses
            .forKeyedBroadcastProcessFunction(
                new JourneyStateMachineFunction(GRAPHS, 1000, 4_194_304L, 7_776_000_000L, 300_000L),
                VersionedTrigger::journeyKey, Types.STRING, GRAPHS, JourneyStateMachineFunction.GRAPH_LOADS);

        decision.definition(purchaseCount());
        decision.rules(Either.Left(activeCampaign()));
        for (Row row : List
            .of(node("n1_view", "setup", null, null, "{\"kind\":\"event\",\"event\":\"view_product\"}", null),
                node("n7_buyer", "segment", "n1_view", "next", null, PURCHASED_TWICE),
                node("n8_push", "engagement", "n7_buyer", "yes", null, null))) {
            decision.rules(Either.Right(row));
            stateMachine.processBroadcastElement(row, 0L);
        }
    }

    @AfterEach
    void close() throws Exception {
        stateMachine.close();
        decision.close();
    }

    @Test
    void aPersonWhoAlreadyMeetsTheConditionPassesTheSegmentWhenTheyReachIt() throws Exception {
        track(event("purchase-1", "purchase", T - 2 * HOUR));
        track(event("purchase-2", "purchase", T - HOUR));

        track(event("view-1", "view_product", T));

        assertEquals(List.of("n1_view/next", "n7_buyer/yes", "n8_push/next"), transitions());
        assertEquals(T, completion("n7_buyer").eventTimestamp());
    }

    @Test
    void aPersonWhoseHistoryIsOnlyInUserMetricsPassesTheSegmentWhenTheyReachIt() throws Exception {
        storedRows.add(storedPurchases(T - 2 * DAY, T - DAY));

        track(event("view-1", "view_product", T));

        assertEquals(List.of("n1_view/next", "n7_buyer/yes", "n8_push/next"), transitions());
    }

    @Test
    void aPersonWhoDoesNotMeetTheConditionWaitsAtTheSegment() throws Exception {
        track(event("purchase-1", "purchase", T - HOUR));

        track(event("view-1", "view_product", T));

        assertEquals(List.of("n1_view/next"), transitions());
    }

    @Test
    void theChangeThatMakesTheConditionHoldPassesAPersonWaitingAtTheSegment() throws Exception {
        track(event("purchase-1", "purchase", T - HOUR));
        track(event("view-1", "view_product", T));

        track(event("purchase-2", "purchase", T + HOUR));

        assertEquals(List.of("n1_view/next", "n7_buyer/yes", "n8_push/next"), transitions());
        assertEquals(T + HOUR, completion("n7_buyer").eventTimestamp());
    }

    @Test
    void aSegmentCheckAnsweredAfterTheWatermarkPassedTheParentStillPassesTheSegment() throws Exception {
        track(event("purchase-1", "purchase", T - 2 * HOUR));
        track(event("purchase-2", "purchase", T - HOUR));
        watermarkBeforeAnswers = T + HOUR;

        track(event("view-1", "view_product", T));

        assertEquals(List.of("n1_view/next", "n7_buyer/yes", "n8_push/next"), transitions());
        assertEquals(T, completion("n7_buyer").eventTimestamp());
    }

    @Test
    void aPurchaseFromBeforeTheParentThatArrivesAfterTheCheckStillPassesTheSegment() throws Exception {
        track(event("purchase-1", "purchase", T - 2 * HOUR));
        track(event("view-1", "view_product", T));

        track(event("purchase-2", "purchase", T - HOUR));

        assertEquals(List.of("n1_view/next", "n7_buyer/yes", "n8_push/next"), transitions());
        assertEquals(T, completion("n7_buyer").eventTimestamp());
    }

    @Test
    void aPurchaseFromBeforeTheParentThatArrivesBehindTheWatermarkStillPassesTheSegment() throws Exception {
        track(event("purchase-1", "purchase", T - 2 * HOUR));
        track(event("view-1", "view_product", T));
        stateMachine.watermark(T - 10 * 60_000L);

        track(event("purchase-2", "purchase", T - HOUR));

        assertEquals(List.of("n1_view/next", "n7_buyer/yes", "n8_push/next"), transitions());
        assertEquals(T, completion("n7_buyer").eventTimestamp());
    }

    @Test
    void aSegmentCheckDeliveredAgainCompletesTheSegmentOnce() throws Exception {
        track(event("purchase-1", "purchase", T - 2 * HOUR));
        track(event("purchase-2", "purchase", T - HOUR));
        track(event("view-1", "view_product", T));

        List<SegmentCheck> replayed = List.copyOf(sentChecks);
        for (SegmentCheck check : replayed) {
            deliver(Either.Right(check));
        }

        assertEquals(1, replayed.size());
        assertEquals(List.of("n1_view/next", "n7_buyer/yes", "n8_push/next"), transitions());
    }

    /**
     * Delivers a tracked event to customer decision, and each message the two jobs
     * send each other because of it, until neither has anything left to send.
     */
    private void track(Event event) throws Exception {
        deliver(Either.Left(event));
    }

    private void deliver(Either<Event, SegmentCheck> first) throws Exception {
        Queue<Either<Event, SegmentCheck>> toDecision = new ArrayDeque<>(List.of(first));
        while (!toDecision.isEmpty()) {
            for (VersionedTrigger trigger : decision.process(toDecision.remove(), 0L)) {
                stateMachine
                    .processElement(DecisionPipeline.throughNetwork(trigger, VersionedTrigger.class),
                        trigger.eventTimestamp());
            }
            Queue<StreamRecord<SegmentCheck>> checks = stateMachine
                .getSideOutput(JourneyStateMachineFunction.SEGMENT_CHECKS);
            if (checks == null || checks.isEmpty()) continue;
            if (watermarkBeforeAnswers != null) stateMachine.watermark(watermarkBeforeAnswers);
            for (StreamRecord<SegmentCheck> check : checks) {
                sentChecks.add(check.getValue());
                toDecision.add(DecisionPipeline.throughNetwork(Either.Right(check.getValue()), INPUT));
            }
            checks.clear();
        }
    }

    private List<String> transitions() {
        return stateMachine
            .extractOutputValues()
            .stream()
            .map(state -> state.nodeId() + "/" + state.branch())
            .toList();
    }

    private UserCampaignState completion(String nodeId) {
        return stateMachine
            .extractOutputValues()
            .stream()
            .filter(state -> nodeId.equals(state.nodeId()))
            .findFirst()
            .orElseThrow();
    }

    private static MetricConfig purchaseCount() {
        return new MetricConfig("m_purchase_count", "m_purchase_count", "", "purchase", null, null, "COUNT", null,
            "PRESENCE", 30 * DAY, true);
    }

    private static UserMetric storedPurchases(long... eventTimes) {
        MetricSeries series = MetricSeries.empty("m_purchase_count", null);
        for (int index = 0; index < eventTimes.length; index++) {
            series = series
                .add("stored-purchase-" + index, eventTimes[index], null, MetricFunction.COUNT, 30 * DAY, 0L);
        }
        return new UserMetric("customer-42", "m_purchase_count", series.seriesClock(), series.buckets(),
            eventTimes.length);
    }

    private static Event event(String eventId, String eventName, long eventTime) {
        return new Event("customer-42", "d1", null, null, eventName, eventTime, null, null, null, null, "web", "{}",
            eventId);
    }

    private static Row activeCampaign() {
        Row row = Row.withNames(RowKind.INSERT);
        row.setField("id", "CAMP-0001");
        row.setField("name", "CAMP-0001");
        row.setField("description", null);
        row.setField("status", "active");
        row.setField("root", null);
        row.setField("created_user", null);
        row.setField("created_at", null);
        row.setField("updated_at", null);
        return row;
    }

    /** A {@code campaign_nodes} row of the three-node save. */
    private static Row node(String nodeId, String nodeType, String parentNodeId, String parentBranch,
        String trigger, String conditions) {
        Row row = Row.withNames(RowKind.INSERT);
        row.setField("campaign_id", "CAMP-0001");
        row.setField("node_id", nodeId);
        row.setField("node_type", nodeType);
        row.setField("parent_node_id", parentNodeId);
        row.setField("parent_branch", parentBranch);
        row.setField("trigger_json", trigger);
        row.setField("conditions_json", conditions);
        row.setField("paths_json", null);
        row.setField("action_json", "engagement".equals(nodeType) ? "{\"channel\":\"push\"}" : null);
        row.setField("goal_id", null);
        row.setField("campaign_node_count", 3);
        row.setField("graph_version", 1L);
        return row;
    }

    /** Finds no profile, as for a person without one. */
    private static final class NoProfiles implements ProfileLookupFunction.ProfileStore {

        @Override
        public CompletableFuture<UserProfile> find(String userId, String canonId, Set<String> columns,
            Set<String> sources) {
            return CompletableFuture.completedFuture(UserProfile.empty());
        }

        @Override
        public void close() {
        }
    }
}
