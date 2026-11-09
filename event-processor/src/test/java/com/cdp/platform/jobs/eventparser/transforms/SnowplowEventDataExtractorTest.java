package com.cdp.platform.jobs.eventparser.transforms;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

import com.cdp.platform.jobs.eventparser.transforms.SnowplowEventDataExtractor.RawPayloads;
import com.cdp.platform.shared.utils.JacksonMapper;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;

class SnowplowEventDataExtractorTest {

    private static final String CONTEXTS = """
        {"schema":"iglu:com.snowplowanalytics.snowplow/contexts/jsonschema/1-0-0","data":[\
        {"schema":"iglu:com.acme.app/basic/jsonschema/1-0-0","data":{"event_name":"purchase"}},\
        {"schema":"iglu:com.acme.app/cart/jsonschema/1-0-0","data":{"total":3}},\
        {"schema":"iglu:com.acme.app/nested/name/jsonschema/1-0-0","data":{"skipped":true}},\
        {"schema":"iglu:com.example.snowplow/product/jsonschema/1-0-0","data":{"price":1}},\
        {"schema":"iglu:com.snowplowanalytics.snowplow/client_session/jsonschema/1-0-2",\
        "data":{"userId":"session-user"}}]}""";

    @Test
    void theConfiguredPrefixPicksTheLegacyContexts() {
        RawPayloads payloads = parse("{\"co\":" + quoted(CONTEXTS) + "}");

        JsonNode eventData = payloads.getEventData(LegacyContextPrefix.parse("iglu:com.acme.app/"));

        assertEquals("{\"event_name\":\"purchase\",\"cart\":{\"total\":3}}", eventData.toString());
        assertNull(payloads.getEventData(LegacyContextPrefix.DEFAULT));
        assertEquals("session-user", payloads.getSessionUserId());
    }

    @Test
    void theSelfDescribingEventWinsOverALegacyContext() {
        String unstructured = """
            {"data":{"schema":"iglu:com.acme/add_to_cart\\\\/jsonschema/1-0-0","data":{"sku":"SKU-1"}}}""";
        String uePx = Base64.getEncoder().encodeToString(unstructured.getBytes(StandardCharsets.UTF_8));
        RawPayloads payloads = parse("{\"ue_px\":\"" + uePx + "\",\"co\":" + quoted(CONTEXTS) + "}");

        assertEquals("{\"sku\":\"SKU-1\"}",
            payloads.getEventData(LegacyContextPrefix.parse("iglu:com.acme.app/")).toString());
        assertEquals("com.acme/add_to_cart", payloads.getSchemaName());
    }

    @Test
    void theEventNameKeepsTheVendorAndDropsTheVersion() {
        assertEquals("com.acme/purchase", schemaName("iglu:com.acme/purchase/jsonschema/1-0-0"));
        assertEquals("com.partner/purchase", schemaName("iglu:com.partner/purchase/jsonschema/2-0-0"));
        assertEquals("com.acme/purchase", schemaName("iglu:com.acme\\\\/purchase\\\\/jsonschema/1-0-0"));
        assertEquals("com.acme/purchase", schemaName("iglu:com.Acme/Purchase/jsonschema/1-0-0"));
    }

    @Test
    void anEventWithoutContextsHasNoEventDataOrSessionUser() {
        RawPayloads payloads = parse("{\"e\":\"pv\"}");

        assertNull(payloads.getEventData(LegacyContextPrefix.DEFAULT));
        assertNull(payloads.getSchemaName());
        assertNull(payloads.getSessionUserId());
    }

    @Test
    void eachEntityIsAddedUnderItsVendorAndName() {
        String contexts = """
            {"schema":"iglu:com.snowplowanalytics.snowplow/contexts/jsonschema/1-0-0","data":[\
            {"schema":"iglu:com.Acme/Product/jsonschema/1-0-0","data":{"sku":"SKU-1"}},\
            {"schema":"iglu:com.snowplowanalytics.snowplow/web_page/jsonschema/1-0-0","data":{"id":"page-1"}}]}""";
        RawPayloads payloads = parse("{\"co\":" + quoted(contexts) + "}");

        assertEquals("{\"cart\":1,\"com.acme/product\":{\"sku\":\"SKU-1\"},"
            + "\"com.snowplowanalytics.snowplow/web_page\":{\"id\":\"page-1\"}}",
            payloads.withEntities(JacksonMapper.readTree("{\"cart\":1}")).toString());
    }

    @Test
    void oneEntityGivesEventDataToAnEventWithoutAny() {
        String contexts = """
            {"schema":"iglu:com.snowplowanalytics.snowplow/contexts/jsonschema/1-0-0","data":[\
            {"schema":"iglu:com.acme/product/jsonschema/1-0-0","data":{"sku":"SKU-1"}}]}""";
        String cx = Base64.getEncoder().encodeToString(contexts.getBytes(StandardCharsets.UTF_8));
        RawPayloads payloads = parse("{\"cx\":\"" + cx + "\"}");

        assertEquals("{\"com.acme/product\":{\"sku\":\"SKU-1\"}}", payloads.withEntities(null).toString());
    }

    @Test
    void theFirstEntityOfANameAndTheEventsOwnKeysWin() {
        String contexts = """
            {"schema":"iglu:com.snowplowanalytics.snowplow/contexts/jsonschema/1-0-0","data":[\
            {"schema":"iglu:com.acme/product/jsonschema/1-0-0","data":{"sku":"SKU-1"}},\
            {"schema":"iglu:com.acme/product/jsonschema/1-0-1","data":{"sku":"SKU-2"}},\
            {"schema":"iglu:com.acme/cart/jsonschema/1-0-0","data":{"total":3}},\
            {"schema":"bad","data":{"sku":"SKU-3"}},\
            {"schema":"iglu:com.acme/list/jsonschema/1-0-0","data":[1]}]}""";
        RawPayloads payloads = parse("{\"co\":" + quoted(contexts) + "}");

        assertEquals("{\"com.acme/cart\":\"own\",\"com.acme/product\":{\"sku\":\"SKU-1\"}}",
            payloads.withEntities(JacksonMapper.readTree("{\"com.acme/cart\":\"own\"}")).toString());
    }

    @Test
    void noEntityLeavesTheEventDataAsItIs() {
        RawPayloads payloads = parse("{\"e\":\"pv\"}");

        assertNull(payloads.withEntities(null));
    }

    @Test
    void aPrefixThatIsNotAnIgluVendorIsRejected() {
        assertEquals(LegacyContextPrefix.DEFAULT, LegacyContextPrefix.parse("  "));
        for (String prefix : new String[] {"com.acme/", "iglu:com.acme", "iglu:/"}) {
            IllegalArgumentException error = assertThrows(IllegalArgumentException.class,
                () -> LegacyContextPrefix.parse(prefix));
            assertEquals("SNOWPLOW_LEGACY_CONTEXT_SCHEMA_PREFIX must start with \"iglu:\" and end with \"/\": \""
                + prefix + "\"", error.getMessage());
        }
    }

    private static String schemaName(String schema) {
        String unstructured = "{\"data\":{\"schema\":\"" + schema + "\",\"data\":{}}}";
        String uePx = Base64.getEncoder().encodeToString(unstructured.getBytes(StandardCharsets.UTF_8));
        return parse("{\"ue_px\":\"" + uePx + "\"}").getSchemaName();
    }

    private static RawPayloads parse(String event) {
        return SnowplowEventDataExtractor.parseRaw(JacksonMapper.instance(), JacksonMapper.readTree(event));
    }

    private static String quoted(String json) {
        return JacksonMapper.writeValueAsString(json);
    }
}
