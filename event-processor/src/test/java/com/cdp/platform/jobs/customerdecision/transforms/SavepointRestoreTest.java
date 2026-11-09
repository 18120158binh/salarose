package com.cdp.platform.jobs.customerdecision.transforms;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;

import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.runtime.checkpoint.OperatorSubtaskState;
import org.apache.flink.state.rocksdb.EmbeddedRocksDBStateBackend;
import org.apache.flink.streaming.util.KeyedBroadcastOperatorTestHarness;
import org.apache.flink.streaming.util.OperatorSnapshotUtil;
import org.apache.flink.types.Either;
import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;

import com.cdp.platform.shared.db.repositories.UnreachableDatabase;
import com.cdp.platform.shared.db.repositories.UserMetricRepository;
import com.cdp.platform.shared.models.Event;
import com.cdp.platform.shared.models.SegmentCheck;
import com.cdp.platform.shared.models.db.Campaign;
import com.cdp.platform.shared.models.db.CampaignNode;
import com.cdp.platform.shared.models.db.MetricConfig;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import org.junit.jupiter.api.Test;

/**
 * Restores the behavior operator from a snapshot that the job wrote before it
 * read segments, held in {@value #FIXTURE}. The snapshot holds a metric
 * definition, an active campaign, a check node with a profile group and a
 * behavior group, and three counted {@code add_to_cart} events, so a restore
 * that loses or misreads any of them fires nothing.
 *
 * <p>
 * {@link #writeFixture} wrote the file at commit {@code abe59421}. Run it again
 * only to capture a new baseline:
 * {@code ./mvnw test -Dtest=SavepointRestoreTest -Dcdp.writeSavepointFixture=true}.
 */
class SavepointRestoreTest {

    private static final String FIXTURE = "src/test/resources/customer-decision/behavior-before-segments.snapshot";
    private static final long HOUR = 3_600_000L;
    private static final long DAY = 24 * HOUR;
    private static final long T = 1_785_800_000_000L;
    private static final MapStateDescriptor<String, MetricConfig> DEFINITIONS = new MapStateDescriptor<>(
        "metric-config-broadcast-state", String.class, MetricConfig.class);
    private static final MapStateDescriptor<String, Campaign> CAMPAIGNS = new MapStateDescriptor<>("campaigns",
        String.class, Campaign.class);
    private static final MapStateDescriptor<String, CampaignNode> NODES = new MapStateDescriptor<>("campaign-nodes",
        String.class, CampaignNode.class);

    @Test
    void writeFixture() throws Exception {
        assumeTrue(Boolean.getBoolean("cdp.writeSavepointFixture"), "writes the fixture only on request");
        try (var harness = start(null)) {
            harness
                .processBroadcastElement(Either
                    .Left(Either
                        .Left(new MetricConfig("m_add_to_cart_count", "m_add_to_cart_count", "", "add_to_cart", null,
                            null, "COUNT", null, "PRESENCE", 30 * DAY, true))),
                    0L);
            harness.processBroadcastElement(Either.Right(Either.Left(activeCampaign())), 0L);
            harness.processBroadcastElement(Either.Right(Either.Right(hanoiCartBuilderCheck())), 0L);
            for (int index = 0; index < 3; index++) {
                harness.processElement(event("cart-" + index, "add_to_cart", T - (3 - index) * HOUR), T);
            }
            Files.createDirectories(Path.of(FIXTURE).getParent());
            OperatorSnapshotUtil.writeStateHandle(harness.snapshot(1L, T), FIXTURE);
        }
    }

    @Test
    void aSnapshotFromBeforeSegmentsRestoresItsRulesAndSeries() throws Exception {
        try (var harness = start(OperatorSnapshotUtil.readStateHandle(FIXTURE))) {
            harness.processElement(event("view-1", "view_page", T), T);

            var waiting = harness.getSideOutput(CustomerBehaviorProcessFunction.NEEDS_PROFILE);
            List<Decision> decisions = waiting.stream().map(record -> record.getValue()).toList();
            assertEquals(1, decisions.size());
            assertEquals(List.of("node-2"), decisions.getFirst().rules().stream().map(RuleDecision::nodeId).toList());
            assertEquals(Set.of("profile.city"), decisions.getFirst().profileFields());
        }
    }

    @Test
    void aSegmentThatArrivesAfterTheRestoreAnswersAMembershipFromTheRestoredSeries() throws Exception {
        try (var harness = start(OperatorSnapshotUtil.readStateHandle(FIXTURE))) {
            Row segment = Row.withNames(RowKind.INSERT);
            segment.setField("id", "SEG-3f9a0c1d7e2b4a65");
            segment.setField("conditions_json", """
                {"groups":[{"conditions":[{"type":"behavior","metric_id":"m_add_to_cart_count","event":"add_to_cart",
                 "measure":"COUNT","op":">=","value":3,"window":{"value":7,"unit":"DAYS"}}]}]}""");
            harness.processBroadcastElement(Either.Left(Either.Right(segment)), 0L);
            Row check = hanoiCartBuilderCheck();
            check.setField("node_id", "node-3");
            check.setField("conditions_json", """
                {"groups":[{"conditions":[
                 {"type":"segment_membership","segment_id":"SEG-3f9a0c1d7e2b4a65","op":"in"}]}]}""");
            harness.processBroadcastElement(Either.Right(Either.Right(check)), 0L);

            harness.processElement(event("view-1", "view_page", T), T);

            // The restored node-2 waits for the profile, so the decision that holds
            // node-3 waits with it.
            List<String> withoutProfile = harness
                .getSideOutput(CustomerBehaviorProcessFunction.NEEDS_PROFILE)
                .stream()
                .flatMap(record -> record.getValue().rules().stream())
                .filter(rule -> !rule.needsProfile())
                .map(RuleDecision::nodeId)
                .toList();
            assertEquals(List.of("node-3"), withoutProfile);
        }
    }

    private static KeyedBroadcastOperatorTestHarness<String, Either<Event, SegmentCheck>, Either<Either<MetricConfig, Row>, Either<Row, Row>>, Decision> start(
        OperatorSubtaskState restored) throws Exception {
        var harness = new KeyedBroadcastOperatorTestHarness<>(
            new CustomerBehaviorOperator(new WithoutStoredMetrics(), DEFINITIONS, CAMPAIGNS, NODES),
            CustomerBehaviorProcessFunction::canonIdOf, Types.STRING, 128, 1, 0);
        harness.setStateBackend(new EmbeddedRocksDBStateBackend());
        if (restored != null) harness.initializeState(restored);
        harness.open();
        return harness;
    }

    private static Either<Event, SegmentCheck> event(String eventId, String eventName, long eventTime) {
        return Either
            .Left(new Event("customer-42", "d1", null, null, eventName, eventTime, null, null, null, null, "web", "{}",
                eventId));
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

    /**
     * A check on {@code view_page} for people in Hanoi who added to cart at least
     * 3 times in 7 days.
     */
    private static Row hanoiCartBuilderCheck() {
        Row row = Row.withNames(RowKind.INSERT);
        row.setField("campaign_id", "CAMP-0001");
        row.setField("node_id", "node-2");
        row.setField("node_type", "check");
        row.setField("parent_node_id", "node-1");
        row.setField("parent_branch", "next");
        row.setField("trigger_json", "{\"kind\":\"event\",\"event\":\"view_page\"}");
        row.setField("conditions_json", """
            {"groups":[
             {"conditions":[{"type":"profile_property","field":"city","op":"=","value":"Hanoi"}]},
             {"conditions":[{"type":"behavior","metric_id":"m_add_to_cart_count","event":"add_to_cart",
              "measure":"COUNT","op":">=","value":3,"window":{"value":7,"unit":"DAYS"}}]}]}""");
        row.setField("paths_json", null);
        row.setField("action_json", null);
        row.setField("goal_id", null);
        row.setField("graph_version", 1L);
        return row;
    }

    private static final class WithoutStoredMetrics extends CustomerBehaviorProcessFunction {

        private static final long serialVersionUID = 1L;

        WithoutStoredMetrics() {
            super(UnreachableDatabase.CONFIG, DEFINITIONS, CAMPAIGNS, NODES, 31, 600_000L, 128, 4_096, 32_768);
        }

        @Override
        UserMetricRepository openMetricRepository() {
            return null;
        }
    }
}
