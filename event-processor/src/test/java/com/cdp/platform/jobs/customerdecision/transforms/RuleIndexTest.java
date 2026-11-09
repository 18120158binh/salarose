package com.cdp.platform.jobs.customerdecision.transforms;

import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;

import com.cdp.platform.shared.models.Event;
import com.cdp.platform.shared.models.db.Campaign;
import com.cdp.platform.shared.models.db.CampaignNode;
import com.cdp.platform.shared.models.db.Segment;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * Candidate selection through the rule index, checked against a scan of every
 * rule (DEC-NFR-10).
 */
class RuleIndexTest {

    private static final String SALE = """
        {"type":"event_property","field":"page.url","op":"LIKE","value":"%sale%"}""";
    private static final String HOME = """
        {"type":"event_property","field":"page.url","op":"LIKE","value":"%home%"}""";
    private static final String HANOI = """
        {"type":"profile_property","field":"city","op":"=","value":"Hanoi"}""";
    private static final String ADDED_TO_CART = """
        {"type":"behavior","metric_id":"m_add_to_cart_count","event":"add_to_cart","measure":"COUNT","window":{"value":30,"unit":"DAYS"},"op":">=",
         "value":1}""";
    private static final String PURCHASED = """
        {"type":"behavior","metric_id":"m_purchase_count","event":"purchase","measure":"COUNT","window":{"value":30,"unit":"DAYS"},"op":">=","value":1}""";
    private static final String VIEWED_5_PAGES = """
        {"type":"behavior","metric_id":"m_view_page_count","event":"view_page","measure":"COUNT","window":{"value":30,"unit":"DAYS"},"op":">=",
         "value":5}""";
    private static final List<String> EVENT_NAMES = List
        .of("view_page", "add_to_cart", "purchase", " purchase ",
            "search", "");
    private static final List<Set<String>> CHANGED_METRICS = List
        .of(Set.of(), Set.of("m_add_to_cart_count"),
            Set.of("m_purchase_count"), Set.of("m_view_page_count", "m_add_to_cart_count"));

    private final Map<String, CampaignNode> nodes = new LinkedHashMap<>();
    private final Map<String, Campaign> campaigns = new LinkedHashMap<>();

    @Test
    void anEventReadsOnlyTheRulesThatItsNameOrAChangedMetricCanFire() {
        put(check("CAMP-0001", "view-page", on("view_page"), null));
        put(check("CAMP-0001", "add-to-cart", on("add_to_cart"), null));
        put(check("CAMP-0001", "view-page-if-name-in", on("view_page", in("event.name", "add_to_cart", "purchase")),
            null));
        put(check("CAMP-0001", "purchase-on-sale", on("purchase", SALE), null));
        put(check("CAMP-0001", "purchase-in-hanoi", on("purchase"), groups(HANOI)));
        put(check("CAMP-0001", "view-page-after-cart", on("view_page"), groups(ADDED_TO_CART)));
        put(segment("CAMP-0001", "added-to-cart", groups(ADDED_TO_CART)));
        put(segment("CAMP-0001", "purchased", groups(PURCHASED + "," + VIEWED_5_PAGES)));
        RuleIndex index = RuleIndex.of(nodes.entrySet(), campaigns.entrySet(), Map.<String, Segment>of().entrySet());

        Set<String> read = Set.copyOf(index.rulesFor(event("purchase"), Set.of("m_add_to_cart_count")));

        assertEquals(Set.of("CAMP-0001:purchase-on-sale", "CAMP-0001:purchase-in-hanoi", "CAMP-0001:added-to-cart"),
            read);
    }

    @Test
    void indexedSelectionReturnsTheSameCandidatesAsAScanOfEveryRule() {
        putMixOfRules();
        RuleIndex index = RuleIndex.of(nodes.entrySet(), campaigns.entrySet(), Map.<String, Segment>of().entrySet());

        assertSameAsFullScan(index);
    }

    @Test
    void indexedSelectionFollowsRuleAndCampaignChanges() {
        putMixOfRules();
        RuleIndex index = RuleIndex.of(nodes.entrySet(), campaigns.entrySet(), Map.<String, Segment>of().entrySet());

        CampaignNode renamed = check("CAMP-0001", "purchase-on-sale-or-home", on("search", SALE + "," + HOME), null);
        nodes.put(renamed.stateKey(), renamed);
        index.putNode(renamed.stateKey(), renamed);
        CampaignNode nowMetricOnly = segment("CAMP-0001", "view-page", groups(ADDED_TO_CART));
        nodes.put(nowMetricOnly.stateKey(), nowMetricOnly);
        index.putNode(nowMetricOnly.stateKey(), nowMetricOnly);
        nodes.remove("CAMP-0001:added-to-cart");
        index.putNode("CAMP-0001:added-to-cart", null);
        Campaign resumed = campaign("CAMP-0002", "active");
        campaigns.put(resumed.id(), resumed);
        index.putCampaign(resumed.id(), resumed);
        Campaign paused = campaign("CAMP-0003", "paused");
        campaigns.put(paused.id(), paused);
        index.putCampaign(paused.id(), paused);

        assertSameAsFullScan(index);
    }

    @Test
    void removingTheLastRuleOfAnEventNameOrMetricDropsItsKey() {
        put(check("CAMP-0001", "view-page", on("view_page"), null));
        put(check("CAMP-0001", "also-view-page", on("view_page"), null));
        put(segment("CAMP-0001", "added-to-cart", groups(ADDED_TO_CART)));
        RuleIndex index = RuleIndex.of(nodes.entrySet(), campaigns.entrySet(), Map.<String, Segment>of().entrySet());
        int before = index.keyCount();

        index.putNode("CAMP-0001:view-page", null);
        int oneRuleLeftOnTheName = index.keyCount();
        index.putNode("CAMP-0001:also-view-page", check("CAMP-0001", "also-view-page", on("purchase"), null));
        index.putNode("CAMP-0001:added-to-cart", null);

        assertEquals(2, before);
        assertEquals(2, oneRuleLeftOnTheName);
        assertEquals(1, index.keyCount());
        assertEquals(Set.of("CAMP-0001:also-view-page"), index.rulesFor(event("purchase"), Set.of()));
    }

    private void assertSameAsFullScan(RuleIndex index) {
        int compared = 0;
        for (String eventName : EVENT_NAMES) {
            for (String url : new String[] {"https://shop.example/sale", "https://shop.example/home"}) {
                for (Set<String> changed : CHANGED_METRICS) {
                    Event event = event(eventName, url);
                    CandidateSelection fullScan = CandidateSelection
                        .select(event, nodes.entrySet(), activeCampaignIds(), changed, CampaignNode::metricIds);

                    assertEquals(fullScan, index.select(event, changed), eventName + " " + url + " " + changed);
                    if (fullScan.hasCandidates()) compared++;
                }
            }
        }
        // Most of the combinations select some rule, so the comparison is not empty.
        assertTrue(compared > EVENT_NAMES.size(), "combinations with candidates: " + compared);
    }

    /**
     * Triggers with and without filters, filters on the event name, rules with
     * profile and behavior conditions, segments, branches with filters and with
     * conditions, node types, and campaigns that are not active.
     */
    private void putMixOfRules() {
        campaigns.put("CAMP-0001", campaign("CAMP-0001", "active"));
        campaigns.put("CAMP-0002", campaign("CAMP-0002", "paused"));
        campaigns.put("CAMP-0003", campaign("CAMP-0003", "LIVE"));
        put(check("CAMP-0001", "view-page", on("view_page"), null));
        put(check("CAMP-0001", "cart-on-sale", on("add_to_cart", SALE), null));
        put(check("CAMP-0001", "cart-if-name-in", on("add_to_cart", in("event.name", "add_to_cart", "purchase")),
            null));
        put(check("CAMP-0001", "purchase-on-sale-or-home", on("purchase", SALE + "," + HOME), null));
        put(check("CAMP-0001", "purchase-on-sale-and-home", on("purchase", SALE, HOME), null));
        put(check("CAMP-0001", "search-not-view-page", on("search", """
            {"type":"event_property","field":"event.name","op":"!=","value":"view_page"}"""), null));
        put(check("CAMP-0001", "search-url-in", on("search", in("page.url", "https://shop.example/sale")), null));
        put(check("CAMP-0001", "view-page-in-hanoi", on("view_page"), groups(HANOI)));
        put(check("CAMP-0001", "view-page-and-cart", on("view_page"), groups(HANOI, ADDED_TO_CART)));
        put(check("CAMP-0001", "view-page-or-cart", on("view_page"), groups(HANOI + "," + ADDED_TO_CART)));
        put(segment("CAMP-0001", "added-to-cart", groups(ADDED_TO_CART)));
        put(segment("CAMP-0001", "purchased", groups(PURCHASED + "," + VIEWED_5_PAGES)));
        put(check("CAMP-0001", "branches", on("purchase"), null, """
            {"path_type":"MultiBranchPath","branches":[{"key":"branch_0","filters":%s},{"key":"else"}]}"""
            .formatted(groups(SALE))));
        put(check("CAMP-0001", "branches-only", on("search"), null, """
            {"path_type":"MultiBranchPath","branches":[{"key":"branch_0","filters":%s},
             {"key":"branch_1","filters":%s}]}""".formatted(groups(HOME), groups(SALE))));
        put(check("CAMP-0001", "branches-on-metric", on("view_page"), null, """
            {"path_type":"MultiBranchPath","branches":[{"key":"branch_0","filters":%s,"conditions":%s}]}"""
            .formatted(groups(SALE), groups(ADDED_TO_CART))));
        put(node("CAMP-0001", "setup", "setup", on("view_page"), null, null));
        put(node("CAMP-0001", "watch", "watch", on("add_to_cart"), null, """
            {"path_type":"SuccessOrTimeoutPath","limit":{"value":15,"unit":"MINUTES"}}"""));
        put(check("CAMP-0002", "paused-view-page", on("view_page"), null));
        put(segment("CAMP-0002", "paused-metric", groups(ADDED_TO_CART)));
        put(check("CAMP-0003", "live-purchase", on("purchase"), null));
        put(check("CAMP-0004", "no-campaign", on("view_page"), null));
    }

    private Set<String> activeCampaignIds() {
        return Set
            .copyOf(campaigns.values().stream().filter(Campaign::isActive).map(Campaign::id).toList());
    }

    private void put(CampaignNode node) {
        nodes.put(node.stateKey(), node);
    }

    /** A trigger on the event name, with one group of filters per argument. */
    private static String on(String eventName, String... filterGroups) {
        String filters = filterGroups.length == 0 ? "" : ",\"filters\":" + groups(filterGroups);
        return "{\"kind\":\"event\",\"event\":\"%s\"%s}".formatted(eventName, filters);
    }

    /** A list of groups, each the comma-joined conditions of one argument. */
    private static String groups(String... groups) {
        return "{\"groups\":[" + String
            .join(",", Arrays
                .stream(groups)
                .map(group -> "{\"conditions\":[" + group + "]}")
                .toList())
            + "]}";
    }

    private static String in(String field, String... values) {
        return "{\"type\":\"event_property\",\"field\":\"%s\",\"op\":\"IN\",\"value\":[%s]}"
            .formatted(field, String.join(",", Arrays.stream(values).map(v -> "\"" + v + "\"").toList()));
    }

    private static Event event(String eventName) {
        return event(eventName, "https://shop.example/sale");
    }

    private static Event event(String eventName, String url) {
        return new Event("customer-42", "d1", null, null, eventName, 1_785_800_000_000L, null, null, url, null,
            "web", "{}", "event-1");
    }

    private static Campaign campaign(String id, String status) {
        return new Campaign(id, id, null, status, null, null, null, null);
    }

    private static CampaignNode check(String campaignId, String nodeId, String trigger, String conditions) {
        return check(campaignId, nodeId, trigger, conditions, null);
    }

    private static CampaignNode check(String campaignId, String nodeId, String trigger, String conditions,
        String paths) {
        return node(campaignId, nodeId, "check", trigger, conditions, paths);
    }

    private static CampaignNode segment(String campaignId, String nodeId, String conditions) {
        return node(campaignId, nodeId, "segment", null, conditions, null);
    }

    private static CampaignNode node(String campaignId, String nodeId, String nodeType, String trigger,
        String conditions, String paths) {
        Row row = Row.withNames(RowKind.INSERT);
        row.setField("campaign_id", campaignId);
        row.setField("node_id", nodeId);
        row.setField("node_type", nodeType);
        row.setField("parent_node_id", "node-1");
        row.setField("parent_branch", "next");
        row.setField("trigger_json", trigger);
        row.setField("conditions_json", conditions);
        row.setField("paths_json", paths);
        row.setField("action_json", null);
        row.setField("goal_id", null);
        row.setField("graph_version", 1L);
        return CampaignNode.load(row).orElseThrow();
    }
}
