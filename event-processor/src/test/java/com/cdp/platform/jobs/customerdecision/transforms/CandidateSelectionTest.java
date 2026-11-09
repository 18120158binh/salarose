package com.cdp.platform.jobs.customerdecision.transforms;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.runtime.checkpoint.OperatorSubtaskState;
import org.apache.flink.streaming.util.KeyedBroadcastOperatorTestHarness;
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

import org.junit.jupiter.api.Test;

/**
 * Candidate selection, run through the operator that counts each event and then
 * selects the rules that may fire on it.
 */
class CandidateSelectionTest {

    private static final MapStateDescriptor<String, MetricConfig> DEFINITIONS = new MapStateDescriptor<>(
        "metric-config-broadcast-state", String.class, MetricConfig.class);
    private static final MapStateDescriptor<String, Campaign> CAMPAIGNS = new MapStateDescriptor<>("campaigns",
        String.class, Campaign.class);
    private static final MapStateDescriptor<String, CampaignNode> NODES = new MapStateDescriptor<>("campaign-nodes",
        String.class, CampaignNode.class);
    private static final String MULTI_BRANCH = """
        {"path_type":"MultiBranchPath","branches":[
          {"key":"branch_0","filters":{"groups":[{"conditions":[
           {"type":"event_property","field":"page.url","op":"LIKE","value":"%sale%"}]}]}},
          {"key":"branch_1","filters":{"groups":[{"conditions":[
           {"type":"event_property","field":"page.url","op":"LIKE","value":"%home%"}]}]}},
          {"key":"else"}]}""";

    @Test
    void aCandidateCarriesTheBranchesItsRuleMatched() throws Exception {
        try (var operator = openOperator()) {
            operator.processBroadcastElement(campaignUpdate(campaign("CAMP-0001", "active")), 0L);
            Row multiBranch = check("node-2", "purchase");
            multiBranch.setField("paths_json", MULTI_BRANCH);
            operator.processBroadcastElement(nodeUpdate(multiBranch), 0L);

            List<Decision> candidates = process(operator, "purchase");

            assertEquals(List.of(Map.of("CAMP-0001:node-2", List.of("branch_0", "else"))),
                candidates.stream().map(CandidateSelectionTest::branches).toList());
        }
    }

    @Test
    void aRuleChangedAfterTheFirstEventIsSelectedByItsNewEventName() throws Exception {
        try (var operator = openOperator()) {
            operator.processBroadcastElement(campaignUpdate(campaign("CAMP-0001", "active")), 0L);
            operator.processBroadcastElement(nodeUpdate(check("node-2", "view_page")), 0L);
            List<Decision> before = process(operator, "view_page");

            operator.processBroadcastElement(nodeUpdate(check("node-2", "purchase")), 0L);
            operator.processBroadcastElement(nodeUpdate(check("node-3", "view_page")), 0L);

            assertEquals(List.of(List.of("CAMP-0001:node-2")), ruleKeys(before));
            assertEquals(List.of(List.of("CAMP-0001:node-3")), ruleKeys(process(operator, "view_page")));
            assertEquals(List.of(List.of("CAMP-0001:node-2")), ruleKeys(process(operator, "purchase")));
        }
    }

    @Test
    void aRuleOrCampaignRemovedAfterTheFirstEventIsNoLongerSelected() throws Exception {
        try (var operator = openOperator()) {
            operator.processBroadcastElement(campaignUpdate(campaign("CAMP-0001", "active")), 0L);
            operator.processBroadcastElement(campaignUpdate(campaign("CAMP-0002", "active")), 0L);
            operator.processBroadcastElement(nodeUpdate(check("node-2", "view_page")), 0L);
            operator.processBroadcastElement(nodeUpdate(check("CAMP-0002", "node-3", "view_page")), 0L);
            List<Decision> before = process(operator, "view_page");

            operator.processBroadcastElement(nodeUpdate(removed(check("node-2", "view_page"))), 0L);
            operator.processBroadcastElement(campaignUpdate(campaign("CAMP-0002", "paused")), 0L);

            assertEquals(List.of("CAMP-0001:node-2", "CAMP-0002:node-3"),
                ruleKeys(before).getFirst().stream().sorted().toList());
            assertEquals(List.of(), process(operator, "view_page"));
        }
    }

    @Test
    void aConditionGroupWithoutConditionsDoesNotStopTheJob() throws Exception {
        try (var operator = openOperator()) {
            operator.processBroadcastElement(campaignUpdate(campaign("CAMP-0001", "paused")), 0L);
            operator.processBroadcastElement(campaignUpdate(campaign("CAMP-0002", "active")), 0L);
            Row withoutExpressions = check("node-2", "view_page");
            withoutExpressions.setField("conditions_json", "{\"groups\":[{\"conditions\":[]}]}");
            operator.processBroadcastElement(nodeUpdate(withoutExpressions), 0L);
            operator.processBroadcastElement(nodeUpdate(check("CAMP-0002", "node-3", "view_page")), 0L);

            assertEquals(List.of(List.of("CAMP-0002:node-3")), ruleKeys(process(operator, "view_page")));
        }
    }

    @Test
    void anOperatorRestoredFromItsCheckpointSelectsTheRulesItHeld() throws Exception {
        OperatorSubtaskState snapshot;
        try (var operator = openOperator()) {
            operator.processBroadcastElement(campaignUpdate(campaign("CAMP-0001", "active")), 0L);
            operator.processBroadcastElement(nodeUpdate(check("node-2", "view_page")), 0L);
            snapshot = operator.snapshot(1L, 1L);
        }

        try (var restored = selection()) {
            restored.initializeState(snapshot);
            restored.open();

            assertEquals(List.of(List.of("CAMP-0001:node-2")), ruleKeys(process(restored, "view_page")));
            assertEquals(List.of(), process(restored, "purchase"));
        }
    }

    @Test
    void anEventBetweenTheBeforeAndAfterImagesOfAnEditStillMeetsTheRule() throws Exception {
        try (var operator = openOperator()) {
            operator.processBroadcastElement(campaignUpdate(campaign("CAMP-0001", "active")), 0L);
            operator.processBroadcastElement(nodeUpdate(check("node-2", "view_page")), 0L);
            process(operator, "view_page");

            operator
                .processBroadcastElement(
                    campaignUpdate(withKind(RowKind.UPDATE_BEFORE, campaign("CAMP-0001", "active"))),
                    0L);
            operator
                .processBroadcastElement(nodeUpdate(withKind(RowKind.UPDATE_BEFORE, check("node-2", "view_page"))),
                    0L);

            assertEquals(List.of(List.of("CAMP-0001:node-2")), ruleKeys(process(operator, "view_page")));
        }
    }

    @Test
    void anEditToAnInvalidCampaignRowRemovesTheCampaign() throws Exception {
        try (var operator = openOperator()) {
            operator.processBroadcastElement(campaignUpdate(campaign("CAMP-0001", "active")), 0L);
            operator.processBroadcastElement(nodeUpdate(check("node-2", "view_page")), 0L);

            Row invalid = withKind(RowKind.UPDATE_AFTER, campaign("CAMP-0001", "active"));
            invalid.setField("name", null);
            operator
                .processBroadcastElement(
                    campaignUpdate(withKind(RowKind.UPDATE_BEFORE, campaign("CAMP-0001", "active"))),
                    0L);
            operator.processBroadcastElement(campaignUpdate(invalid), 0L);

            assertEquals(List.of(), process(operator, "view_page"));
        }
    }

    private int events;

    private static KeyedBroadcastOperatorTestHarness<String, Either<Event, SegmentCheck>, Either<Either<MetricConfig, Row>, Either<Row, Row>>, Decision> openOperator()
        throws Exception {
        var operator = selection();
        operator.open();
        return operator;
    }

    private static KeyedBroadcastOperatorTestHarness<String, Either<Event, SegmentCheck>, Either<Either<MetricConfig, Row>, Either<Row, Row>>, Decision> selection()
        throws Exception {
        return new KeyedBroadcastOperatorTestHarness<>(
            new CustomerBehaviorOperator(new WithoutStoredMetrics(), DEFINITIONS, CAMPAIGNS, NODES),
            CustomerBehaviorProcessFunction::canonIdOf, Types.STRING, 128, 1, 0);
    }

    /** The candidates of one new event that needs no lookup. */
    private List<Decision> process(
        KeyedBroadcastOperatorTestHarness<String, Either<Event, SegmentCheck>, Either<Either<MetricConfig, Row>, Either<Row, Row>>, Decision> operator,
        String eventName) throws Exception {
        operator.getOutput().clear();
        events++;
        Event event = new Event("customer-42", "d1", null, null, eventName, 1_785_800_000_000L + events, null, null,
            "https://shop.example/sale", null, "web", "{}", "event-" + events);
        operator.processElement(Either.Left(event), 0L);
        return operator.extractOutputValues();
    }

    private static Either<Either<MetricConfig, Row>, Either<Row, Row>> campaignUpdate(Row row) {
        return Either.Right(Either.Left(row));
    }

    private static Either<Either<MetricConfig, Row>, Either<Row, Row>> nodeUpdate(Row row) {
        return Either.Right(Either.Right(row));
    }

    private static List<List<String>> ruleKeys(List<Decision> decisions) {
        return decisions.stream().map(decision -> List.copyOf(branches(decision).keySet())).toList();
    }

    /** The branches of each rule that the decision fires, by rule key. */
    private static Map<String, List<String>> branches(Decision decision) {
        Map<String, List<String>> branches = new LinkedHashMap<>();
        decision
            .rules()
            .forEach(rule -> branches
                .computeIfAbsent(rule.campaignId() + ":" + rule.nodeId(), key -> new ArrayList<>())
                .addAll(rule.branches()));
        return branches;
    }

    private static Row campaign(String id, String status) {
        Row row = Row.withNames(RowKind.INSERT);
        row.setField("id", id);
        row.setField("name", id);
        row.setField("description", null);
        row.setField("status", status);
        row.setField("root", null);
        row.setField("created_user", null);
        row.setField("created_at", null);
        row.setField("updated_at", null);
        return row;
    }

    private static Row check(String nodeId, String eventName) {
        return check("CAMP-0001", nodeId, eventName);
    }

    /** A check node row whose trigger is the event name. */
    private static Row check(String campaignId, String nodeId, String eventName) {
        Row row = Row.withNames(RowKind.INSERT);
        row.setField("campaign_id", campaignId);
        row.setField("node_id", nodeId);
        row.setField("node_type", "check");
        row.setField("parent_node_id", "node-1");
        row.setField("parent_branch", "next");
        row.setField("trigger_json", "{\"kind\":\"event\",\"event\":\"%s\"}".formatted(eventName));
        row.setField("conditions_json", null);
        row.setField("paths_json", null);
        row.setField("action_json", null);
        row.setField("goal_id", null);
        row.setField("graph_version", 1L);
        return row;
    }

    private static Row withKind(RowKind kind, Row row) {
        row.setKind(kind);
        return row;
    }

    private static Row removed(Row row) {
        row.setKind(RowKind.DELETE);
        return row;
    }

    /** Reads nothing from Postgres, as for a person with no stored rows. */
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
