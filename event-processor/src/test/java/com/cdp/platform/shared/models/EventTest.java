package com.cdp.platform.shared.models;

import java.util.List;
import java.util.Map;

import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;

import com.cdp.platform.shared.models.db.CampaignNode;

import static com.cdp.platform.shared.models.EventFieldNames.COLLIDING;
import static com.cdp.platform.shared.models.EventFieldNames.FROM_JSON;
import static com.cdp.platform.shared.models.EventFieldNames.jsonWith;
import static com.cdp.platform.shared.models.EventFieldNames.withEveryField;
import static org.junit.jupiter.api.Assertions.assertAll;
import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class EventTest {

    @Test
    void aNullCollectorTimestampFallsBackToTheEventTimestamp() {
        Row row = Row.withNames();
        row.setField("event_timestamp", 900L);
        row.setField("collector_timestamp", null);

        assertEquals(900L, Event.fromRow(row).collectorTimestamp());
    }

    @Test
    void setupNodeFiresOnNext() {
        CampaignNode setup = node("setup", on("view_product"));

        assertEquals(List.of("next"), event("view_product").matchAll(setup));
    }

    @Test
    void singlePathCheckFiresOnYes() {
        CampaignNode check = node("check", on("add_to_cart"));

        assertEquals(List.of("yes"), event("add_to_cart").matchAll(check));
    }

    @Test
    void watchNodeFiresOnSuccess() {
        CampaignNode watch = node("watch", on("add_to_cart"), """
            {"path_type":"SuccessOrTimeoutPath","limit":{"value":15,"unit":"MINUTES"}}""");

        assertEquals(List.of("success"), event("add_to_cart").matchAll(watch));
    }

    @Test
    void multiBranchCheckFiresOnEachMatchingBranchKey() {
        CampaignNode check = multiBranchCheck();

        assertEquals(List.of("branch_0"), addToCart("iphone").matchAll(check));
    }

    @Test
    void multiBranchCheckWithNoMatchingBranchEmitsNothing() {
        CampaignNode check = multiBranchCheck();

        assertEquals(List.of(), addToCart("pixel").matchAll(check));
    }

    @Test
    void engagementNodeEmitsNothingBecauseItCompletesWithItsParent() {
        CampaignNode engagement = node("engagement", null);

        assertEquals(List.of(), event("view_product").matchAll(engagement));
    }

    @Test
    void failedCheckEmitsNothing() {
        CampaignNode check = node("check", on("add_to_cart"));

        assertEquals(List.of(), event("view_product").matchAll(check));
    }

    @Test
    void anEventJsonUrlIsReadInsteadOfThePageUrl() {
        CampaignNode onSale = node("check", onAddToCartWhere("url", "LIKE", "%/sale%"));

        assertEquals(List.of("yes"), withEveryField("{\"url\":\"https://shop.vn/sale\"}").matchAll(onSale));
    }

    @Test
    void everyNameOutsideTheContractListReadsEventJson() {
        assertAll(COLLIDING
            .stream()
            .map(name -> () -> assertEquals(List.of("yes"),
                withEveryField(jsonWith(name)).matchAll(node("check", onAddToCartWhere(name, "=", FROM_JSON))), name)));
    }

    @Test
    void theFiveContractNamesReadTheEventsOwnFields() {
        Event event = withEveryField("""
            {"event.name":"j","page.location":"j","page.url":"j","page.referrer":"j","product.name":"j",
             "event":{"name":"j"},"page":{"location":"j","url":"j","referrer":"j"},"product":{"name":"j"}}""");

        assertAll(
            () -> assertEquals("add_to_cart", event.propertyValue("event.name")),
            () -> assertEquals("checkout", event.propertyValue("page.location")),
            () -> assertEquals("https://shop.vn/home", event.propertyValue("page.url")),
            () -> assertEquals("https://google.com", event.propertyValue("page.referrer")),
            () -> assertEquals("iphone", event.propertyValue("product.name")));
    }

    @Test
    void aContractNameWhoseFieldIsUnsetReadsEventJson() {
        Event event = new Event("domain-1", "user-1", "add_to_cart", 1_760_346_764_120L, null, null, null, null,
            "web", "{\"product\":{\"name\":\"iphone\"}}");

        assertEquals("iphone", event.propertyValue("product.name"));
    }

    @Test
    void contextNamesAnEventJsonAttributeByItsPathWithNoPrefix() {
        Event event = new Event("domain-1", "user-1", "view_product", 1_760_346_764_120L, null, null, null, null,
            "web", "{\"product\":{\"price\":10}}");

        assertEquals(Map.of("event.name", "view_product", "product.price", "10"), event.buildContext());
    }

    @Test
    void contextKeepsTheNamesOfTheEventsOwnFields() {
        Event event = new Event("domain-1", "user-1", "view_product", 1_760_346_764_120L, "product_detail",
            "Phone X", "https://shop.example/p/1", "https://search.example", "web", "{\"color\":\"red\"}");

        assertEquals(Map
            .of("event.name", "view_product", "page.location", "product_detail", "page.url", "https://shop.example/p/1",
                "page.referrer", "https://search.example", "product.name", "Phone X", "color", "red"),
            event.buildContext());
    }

    @Test
    void anEventsOwnFieldWinsOverAnEventJsonAttributeOfTheSameNameAsInConditions() {
        Event event = new Event("domain-1", "user-1", "view_product", 1_760_346_764_120L, null, null,
            "https://shop.example/cart", null, "web",
            "{\"event\":{\"name\":\"x\"},\"page\":{\"url\":\"x\",\"referrer\":\"y\"}}");

        Map<String, String> context = event.buildContext();

        assertEquals(Map
            .of("event.name", "view_product", "page.url", "https://shop.example/cart", "page.referrer", "y"),
            context);
        assertEquals("view_product", event.propertyValue("event.name"));
        assertEquals("https://shop.example/cart", event.propertyValue("page.url"));
        assertEquals("y", event.propertyValue("page.referrer"));
    }

    @Test
    void aBlankProductNameWinsOverAnEventJsonProductNameAsInConditions() {
        Event event = new Event("domain-1", "user-1", "view_product", 1_760_346_764_120L, null, "", null, null, "web",
            "{\"product\":{\"name\":\"Z\"}}");

        assertEquals(Map.of("event.name", "view_product", "product.name", ""), event.buildContext());
        assertEquals("", event.propertyValue("product.name"));
    }

    /**
     * A check on add_to_cart whose first branch passes for an iphone and whose
     * second for an ipad.
     */
    private static CampaignNode multiBranchCheck() {
        return node("check", on("add_to_cart"), """
            {"path_type":"MultiBranchPath","branches":[
              {"key":"branch_0","filters":{"groups":[{"conditions":[
               {"type":"event_property","field":"product.name","op":"=","value":"iphone"}]}]}},
              {"key":"branch_1","filters":{"groups":[{"conditions":[
               {"type":"event_property","field":"product.name","op":"=","value":"ipad"}]}]}}]}""");
    }

    private static String on(String eventName) {
        return "{\"kind\":\"event\",\"event\":\"%s\"}".formatted(eventName);
    }

    /** A trigger on add_to_cart with one filter. */
    private static String onAddToCartWhere(String field, String op, String value) {
        return """
            {"kind":"event","event":"add_to_cart","filters":{"groups":[{"conditions":[
             {"type":"event_property","field":"%s","op":"%s","value":"%s"}]}]}}""".formatted(field, op, value);
    }

    private static Event event(String eventName) {
        return new Event("domain-1", "user-1", eventName, 1_760_346_764_120L, null, null, null, null, "web", null);
    }

    private static Event addToCart(String productName) {
        return new Event("domain-1", "user-1", "add_to_cart", 1_760_346_764_120L, null, productName, null, null, "web",
            null);
    }

    private static CampaignNode node(String nodeType, String trigger) {
        return node(nodeType, trigger, null);
    }

    private static CampaignNode node(String nodeType, String trigger, String paths) {
        Row row = Row.withNames(RowKind.INSERT);
        row.setField("campaign_id", "campaign-1");
        row.setField("node_id", "node-1");
        row.setField("node_type", nodeType);
        row.setField("parent_node_id", null);
        row.setField("parent_branch", null);
        row.setField("trigger_json", trigger);
        row.setField("conditions_json", null);
        row.setField("paths_json", paths);
        row.setField("action_json", null);
        row.setField("goal_id", null);
        row.setField("graph_version", 1L);
        return CampaignNode.fromRow(row).valueOrThrow();
    }
}
