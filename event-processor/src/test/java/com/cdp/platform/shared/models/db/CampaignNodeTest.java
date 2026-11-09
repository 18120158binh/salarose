package com.cdp.platform.shared.models.db;

import java.util.List;
import java.util.Optional;

import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;

import com.cdp.platform.shared.models.node.And;
import com.cdp.platform.shared.models.node.BranchCondition;
import com.cdp.platform.shared.models.node.Comparison;
import com.cdp.platform.shared.models.node.MetricFunction;
import com.cdp.platform.shared.models.node.Or;
import com.cdp.platform.shared.models.node.PersonConditions;
import com.cdp.platform.shared.models.node.TimeWindow;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class CampaignNodeTest {

    // The examples of the saved format in the journey builder contract.
    private static final String ADD_TO_CART_OVER_500000 = """
        {"kind":"event","event":"add_to_cart","filters":{"groups":[
          {"conditions":[{"type":"event_property","field":"product.price","op":">","value":500000}]}]}}""";
    private static final String IN_HANOI_OR_HCMC_AND_ADDED_THREE_TIMES = """
        {"groups":[
          {"conditions":[{"type":"profile_property","field":"city","op":"IN","value":["Hanoi","Ho Chi Minh City"]}]},
          {"conditions":[{"type":"behavior","event":"add_to_cart","measure":"COUNT",
            "window":{"value":7,"unit":"DAYS"},"op":">=","value":3,"metric_id":"m_7c41d0a2e5f61b93"}]}]}""";
    private static final String VIP_OR_REGULAR = """
        {"path_type":"MultiBranchPath","branches":[
          {"key":"vip","filters":{"groups":[
            {"conditions":[{"type":"event_property","field":"order.total","op":">","value":1000}]}]}},
          {"key":"regular"}]}""";

    private static final String PURCHASE = "{\"kind\":\"event\",\"event\":\"purchase\"}";
    private static final And PURCHASE_TRIGGER = new And(List.of(new Comparison("event.name", "=", "purchase")));

    @Test
    void aTriggerReadsAsItsEventNameAndItsFilters() {
        CampaignNode node = load(row("check", ADD_TO_CART_OVER_500000, null, null));

        assertEquals(new And(List
            .of(new Comparison("event.name", "=", "add_to_cart"),
                new And(List.of(new Or(List.of(new Comparison("product.price", ">", "500000"))))))),
            node.condition());
    }

    @Test
    void conditionsReadAsGroupsOfProfileAndBehaviorConditions() {
        CampaignNode node = load(row("check", ADD_TO_CART_OVER_500000, IN_HANOI_OR_HCMC_AND_ADDED_THREE_TIMES, null));

        assertEquals(new PersonConditions(List
            .of(new PersonConditions.Group(
                List
                    .of(new Comparison("profile.city", "=", "Hanoi"),
                        new Comparison("profile.city", "=", "Ho Chi Minh City")),
                List.of(), List.of()),
                new PersonConditions.Group(List.of(), List
                    .of(new Comparison("m_7c41d0a2e5f61b93", ">=", "3", new TimeWindow(7, "DAYS"),
                        MetricFunction.COUNT)),
                    List.of()))),
            node.conditions());
    }

    @Test
    void aProfileAndABehaviorConditionCanShareAGroup() {
        CampaignNode node = load(row("check", PURCHASE,
            """
                {"groups":[{"conditions":[
                  {"type":"profile_property","field":"city","op":"=","value":"Hanoi"},
                  {"type":"behavior","event":"add_to_cart","measure":"COUNT","window":{"value":30,"unit":"DAYS"},"op":">=","value":3,"metric_id":"m_cart"}]}]}""",
            null));

        PersonConditions.Group group = node.conditions().groups().getFirst();
        assertEquals(List.of(new Comparison("profile.city", "=", "Hanoi")), group.profile());
        assertEquals(List.of("m_cart"), group.behavior().stream().map(Comparison::left).toList());
    }

    @Test
    void aMultiBranchCheckReadsItsBranchesInTheirSavedOrder() {
        CampaignNode node = load(row("check", PURCHASE, null, VIP_OR_REGULAR));

        assertEquals(List
            .of(new BranchCondition("vip",
                new And(List.of(new Or(List.of(new Comparison("order.total", ">", "1000"))))), null),
                new BranchCondition("regular", null, null)),
            node.branches());
        assertEquals("MultiBranchPath", node.pathType());
    }

    @Test
    void aBranchsConditionsAddToTheNodesOnThatBranchOnly() {
        CampaignNode node = load(row("check", PURCHASE, profileGroup("city", "Hanoi"), """
            {"path_type":"MultiBranchPath","branches":[
              {"key":"vip","conditions":{"groups":[{"conditions":[
                {"type":"profile_property","field":"tier","op":"=","value":"gold"}]}]}},
              {"key":"regular"}]}"""));

        assertEquals(2, node.conditionsOn("vip").groups().size());
        assertEquals(1, node.conditionsOn("regular").groups().size());
    }

    @Test
    void aWatchReadsItsPathType() {
        CampaignNode node = load(row("watch", PURCHASE, null, """
            {"path_type":"SuccessOrTimeoutPath","limit":{"value":1,"unit":"DAYS"}}"""));

        assertEquals("SuccessOrTimeoutPath", node.pathType());
        assertEquals(PURCHASE_TRIGGER, node.condition());
    }

    @Test
    void aDelayIsNotARuleOfCustomerDecision() {
        Row delay = row("watch", null, null, "{\"path_type\":\"DelayPath\",\"limit\":{\"value\":2,\"unit\":\"DAYS\"}}");

        assertTrue(CampaignNode.fromRow(delay).isValid());
        assertFalse(CampaignNode.load(delay).isPresent());
    }

    @Test
    void aNodeThatMovesOnAnEventWithoutATriggerSkipsTheRow() {
        for (String nodeType : List.of("setup", "check", "watch")) {
            assertFalse(CampaignNode.load(row(nodeType, null, null, null)).isPresent());
        }
    }

    @Test
    void anAbsentListOfConditionsPasses() {
        assertEquals(PersonConditions.NONE, load(row("check", PURCHASE, null, null)).conditions());
        assertEquals(PersonConditions.NONE, load(row("check", PURCHASE, "{\"groups\":[]}", null)).conditions());
    }

    @Test
    void aNodeKeepsTheGraphVersionOfItsSave() {
        Row row = row("check", PURCHASE, null, null);
        row.setField("graph_version", 7L);

        assertEquals(7L, CampaignNode.load(row).orElseThrow().graphVersion());
    }

    @Test
    void aRowWithoutAGraphVersionSkipsTheRow() {
        Row row = row("check", PURCHASE, null, null);
        row.setField("graph_version", null);

        assertFalse(CampaignNode.load(row).isPresent());
    }

    @Test
    void aTriggerWithoutAnEventOfKindEventSkipsTheRow() {
        for (String trigger : List
            .of("{\"kind\":\"business_event\",\"event\":\"price_drop\"}", "{\"kind\":\"event\"}",
                "{\"event\":\"purchase\"}", "\"purchase\"", "not json")) {
            assertFalse(CampaignNode.load(row("check", trigger, null, null)).isPresent());
        }
    }

    @Test
    void aFilterThatDoesNotParseSkipsTheRow() {
        for (String filter : List
            .of(// An unknown type, and a filter that is not on the event.
                "{\"type\":\"segment\",\"field\":\"a\",\"op\":\"=\",\"value\":\"1\"}",
                "{\"type\":\"profile_property\",\"field\":\"city\",\"op\":\"=\",\"value\":\"Hanoi\"}",
                // A missing field, operator, or value, and an operator outside the table.
                "{\"type\":\"event_property\",\"op\":\"=\",\"value\":\"1\"}",
                "{\"type\":\"event_property\",\"field\":\"a\",\"value\":\"1\"}",
                "{\"type\":\"event_property\",\"field\":\"a\",\"op\":\"=\"}",
                "{\"type\":\"event_property\",\"field\":\"a\",\"op\":\"~\",\"value\":\"1\"}",
                // IN takes an array, and the other operators a single value.
                "{\"type\":\"event_property\",\"field\":\"a\",\"op\":\"IN\",\"value\":\"x,y\"}",
                "{\"type\":\"event_property\",\"field\":\"a\",\"op\":\"=\",\"value\":[\"x\"]}")) {
            String trigger = "{\"kind\":\"event\",\"event\":\"purchase\",\"filters\":{\"groups\":[{\"conditions\":["
                + filter + "]}]}}";

            assertFalse(CampaignNode.load(row("check", trigger, null, null)).isPresent());
        }
    }

    @Test
    void fieldOperatorsLoadInAnyCase() {
        String trigger = """
            {"kind":"event","event":"purchase","filters":{"groups":[
              {"conditions":[{"type":"event_property","field":"page.url","op":"like","value":"%sale%"}]}]}}""";

        assertTrue(CampaignNode.load(row("check", trigger, null, null)).isPresent());
    }

    @Test
    void aGroupWithoutConditionsSkipsTheRow() {
        for (String conditions : List
            .of("{\"groups\":[{\"conditions\":[]}]}", "{\"groups\":[{}]}", "{\"groups\":{}}")) {
            assertFalse(CampaignNode.load(row("check", PURCHASE, conditions, null)).isPresent());
            String trigger = "{\"kind\":\"event\",\"event\":\"purchase\",\"filters\":" + conditions + "}";
            assertFalse(CampaignNode.load(row("check", trigger, null, null)).isPresent());
        }
    }

    @Test
    void anEventPropertyAmongConditionsSkipsTheRow() {
        String conditions = """
            {"groups":[{"conditions":[{"type":"event_property","field":"a","op":"=","value":"1"}]}]}""";

        assertFalse(CampaignNode.load(row("check", PURCHASE, conditions, null)).isPresent());
    }

    @Test
    void aBehaviorConditionWithEveryFieldLoads() {
        assertTrue(CampaignNode
            .load(row("check", PURCHASE, behavior("\"metric_id\":\"m\",\"event\":\"purchase\",\"measure\":\"SUM\","
                + "\"attribute\":\"order.total\",\"op\":\"<\",\"value\":2.5,\"window\":{\"value\":3,\"unit\":\"WEEKS\"}"),
                null))
            .isPresent());
    }

    @Test
    void aBehaviorConditionThatDoesNotParseSkipsTheRow() {
        for (String fields : List
            .of(// No metric id, event, measure, operator, or value.
                "\"event\":\"purchase\",\"measure\":\"COUNT\",\"op\":\">=\",\"value\":3,\"window\":{\"value\":7,\"unit\":\"DAYS\"}",
                "\"metric_id\":\"m\",\"measure\":\"COUNT\",\"op\":\">=\",\"value\":3,\"window\":{\"value\":7,\"unit\":\"DAYS\"}",
                "\"metric_id\":\"m\",\"event\":\"purchase\",\"op\":\">=\",\"value\":3,\"window\":{\"value\":7,\"unit\":\"DAYS\"}",
                "\"metric_id\":\"m\",\"event\":\"purchase\",\"measure\":\"COUNT\",\"value\":3,\"window\":{\"value\":7,\"unit\":\"DAYS\"}",
                "\"metric_id\":\"m\",\"event\":\"purchase\",\"measure\":\"COUNT\",\"op\":\">=\",\"window\":{\"value\":7,\"unit\":\"DAYS\"}",
                // An unknown measure or operator, and a value that is not a number.
                "\"metric_id\":\"m\",\"event\":\"purchase\",\"measure\":\"TOTAL\",\"op\":\">=\",\"value\":3,\"window\":{\"value\":7,\"unit\":\"DAYS\"}",
                "\"metric_id\":\"m\",\"event\":\"purchase\",\"measure\":\"COUNT\",\"op\":\"LIKE\",\"value\":3,\"window\":{\"value\":7,\"unit\":\"DAYS\"}",
                "\"metric_id\":\"m\",\"event\":\"purchase\",\"measure\":\"COUNT\",\"op\":\">=\",\"value\":\"3\",\"window\":{\"value\":7,\"unit\":\"DAYS\"}",
                // No window, a window of 0 or less, or one without one of the units.
                "\"metric_id\":\"m\",\"event\":\"purchase\",\"measure\":\"COUNT\",\"op\":\">=\",\"value\":3",
                "\"metric_id\":\"m\",\"event\":\"purchase\",\"measure\":\"COUNT\",\"op\":\">=\",\"value\":3,"
                    + "\"window\":{\"value\":0,\"unit\":\"DAYS\"}",
                "\"metric_id\":\"m\",\"event\":\"purchase\",\"measure\":\"COUNT\",\"op\":\">=\",\"value\":3,"
                    + "\"window\":{\"value\":7,\"unit\":\"days\"}",
                "\"metric_id\":\"m\",\"event\":\"purchase\",\"measure\":\"COUNT\",\"op\":\">=\",\"value\":3,"
                    + "\"window\":{\"value\":7}")) {
            assertFalse(CampaignNode.load(row("check", PURCHASE, behavior(fields), null)).isPresent());
        }
    }

    @Test
    void aSegmentLoadsAsARuleWithOnlyItsBehaviorConditions() {
        Optional<CampaignNode> node = CampaignNode
            .load(row("segment", null, IN_HANOI_OR_HCMC_AND_ADDED_THREE_TIMES,
                null));

        assertTrue(node.isPresent());
        assertNull(node.get().condition());
    }

    @Test
    void aSegmentWithoutABehaviorConditionSkipsTheRow() {
        assertFalse(CampaignNode.load(row("segment", null, null, null)).isPresent());
        assertFalse(CampaignNode.load(row("segment", null, profileGroup("city", "Hanoi"), null)).isPresent());
    }

    @Test
    void aSegmentWithATriggerSkipsTheRow() {
        assertFalse(CampaignNode
            .load(row("segment", PURCHASE, IN_HANOI_OR_HCMC_AND_ADDED_THREE_TIMES, null))
            .isPresent());
    }

    @Test
    void aBranchWithoutAKeySkipsTheRow() {
        assertFalse(CampaignNode
            .load(row("check", PURCHASE, null, "{\"path_type\":\"MultiBranchPath\",\"branches\":[{}]}"))
            .isPresent());
    }

    private static String profileGroup(String field, String value) {
        return "{\"groups\":[{\"conditions\":[{\"type\":\"profile_property\",\"field\":\"%s\",\"op\":\"=\",\"value\":\"%s\"}]}]}"
            .formatted(field, value);
    }

    private static String behavior(String fields) {
        return "{\"groups\":[{\"conditions\":[{\"type\":\"behavior\"," + fields + "}]}]}";
    }

    private static CampaignNode load(Row row) {
        Optional<CampaignNode> node = CampaignNode.load(row);
        assertTrue(node.isPresent(), "the row should load");
        return node.get();
    }

    private static Row row(String nodeType, String triggerJson, String conditionsJson, String pathsJson) {
        Row row = Row.withNames(RowKind.INSERT);
        row.setField("campaign_id", "c1");
        row.setField("node_id", "n1");
        row.setField("node_type", nodeType);
        row.setField("parent_node_id", null);
        row.setField("parent_branch", null);
        row.setField("trigger_json", triggerJson);
        row.setField("conditions_json", conditionsJson);
        row.setField("paths_json", pathsJson);
        row.setField("action_json", null);
        row.setField("goal_id", null);
        row.setField("graph_version", 1L);
        return row;
    }
}
