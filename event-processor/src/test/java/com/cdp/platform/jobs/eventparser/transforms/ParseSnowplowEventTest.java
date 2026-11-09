package com.cdp.platform.jobs.eventparser.transforms;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;

import org.apache.flink.api.common.functions.DefaultOpenContext;
import org.apache.flink.api.common.functions.RuntimeContext;
import org.apache.flink.api.common.functions.util.ListCollector;
import org.apache.flink.metrics.Counter;
import org.apache.flink.metrics.MetricGroup;
import org.apache.flink.metrics.SimpleCounter;
import org.apache.flink.metrics.groups.OperatorMetricGroup;
import org.apache.flink.metrics.groups.UnregisteredMetricsGroup;
import org.apache.flink.runtime.metrics.groups.UnregisteredMetricGroups;
import org.apache.flink.streaming.api.TimerService;
import org.apache.flink.streaming.api.functions.ProcessFunction;
import org.apache.flink.types.Row;
import org.apache.flink.util.OutputTag;

import com.cdp.platform.shared.models.CollectorPayload;
import com.cdp.platform.shared.models.ParsedEvent;
import com.cdp.platform.shared.utils.JacksonMapper;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.thrift.TSerializer;
import org.junit.jupiter.api.Test;

class ParseSnowplowEventTest {

    private static final String EVENT_ID = "5f0c1a2e-8a51-4c4e-9d1b-1d2f3e4a5b6c";
    private static final long COLLECTOR_TIMESTAMP = 1760346764380L;
    private static final String SECRET = "carol_ssn_123456789";
    private static final long DROPPED_AT = 1760346765000L;

    // "???>>>" puts both '+' and '/' in the standard Base64 of these payloads.
    private static final String ADD_TO_CART = """
        {"schema":"iglu:com.snowplowanalytics.snowplow/unstruct_event/jsonschema/1-0-0",\
        "data":{"schema":"iglu:com.acme/add_to_cart/jsonschema/1-0-0","data":{"sku":"SKU-1","note":"???>>>"}}}""";
    private static final String CLIENT_SESSION = """
        {"schema":"iglu:com.snowplowanalytics.snowplow/contexts/jsonschema/1-0-0",\
        "data":[{"schema":"iglu:com.snowplowanalytics.snowplow/client_session/jsonschema/1-0-2",\
        "data":{"userId":"session-user","note":"???>>>"}}]}""";

    @Test
    void getHitWithItsEventInTheQueryStringIsParsed() throws Exception {
        CollectorPayload hit = payload("/i")
            .setQuerystring("e=pv&eid=" + EVENT_ID + "&dtm=1760346764000&stm=1760346764100"
                + "&duid=a1b2c3&p=web&page=Product+page&url=https%3A%2F%2Fshop.example%2Fp%2F1");

        List<ParsedEvent> events = parse(hit);

        assertEquals(1, events.size());
        ParsedEvent event = events.get(0);
        assertEquals(EVENT_ID, event.eventId());
        assertEquals("view_page", event.eventName());
        assertEquals(COLLECTOR_TIMESTAMP - 100, event.eventTimestamp());
        assertEquals("a1b2c3", event.domainUserid());
        assertEquals("https://shop.example/p/1", event.url());
        assertEquals("Product page", event.screenLocation());
    }

    @Test
    void structuredEventIsNamedByItsLowercasedActionAndKeepsItsFields() throws Exception {
        List<ParsedEvent> events = parse(getHit("e=se&se_ca=Video&se_ac=Play&se_la=intro&se_va=12.5"));

        assertEquals(1, events.size());
        assertEquals("play", events.get(0).eventName());
        assertEquals(
            JacksonMapper.readTree("{\"category\":\"Video\",\"action\":\"Play\",\"label\":\"intro\",\"value\":12.5}"),
            JacksonMapper.readTree(events.get(0).eventJson()));
    }

    @Test
    void structuredEventWithoutAnActionIsDropped() throws Exception {
        Parsed parsed = parseCapturingLog(getHit("e=se&se_ca=Video&se_la=intro"));

        assertTrue(parsed.events().isEmpty());
        assertEquals(1, parsed.dropped("event_not_decoded"));
        assertFalse(parsed.log().contains("intro"), parsed.log());
    }

    @Test
    void transactionKeepsItsFieldsWithNumbersAsNumbers() throws Exception {
        List<ParsedEvent> events = parse(getHit("e=tr&tr_id=ORD-1&tr_tt=150000&tr_tx=15000&tr_sh=0&tr_cu=VND"));

        assertEquals("transaction", events.get(0).eventName());
        assertEquals(
            JacksonMapper
                .readTree(
                    "{\"order_id\":\"ORD-1\",\"total\":150000,\"tax\":15000,\"shipping\":0,\"currency\":\"VND\"}"),
            JacksonMapper.readTree(events.get(0).eventJson()));
    }

    @Test
    void transactionItemKeepsItsFieldsWithNumbersAsNumbers() throws Exception {
        List<ParsedEvent> events = parse(getHit("e=ti&ti_id=ORD-1&ti_sk=SKU-1&ti_nm=Shirt&ti_pr=75000.5&ti_qu=2"));

        assertEquals("transaction_item", events.get(0).eventName());
        assertEquals(
            JacksonMapper
                .readTree(
                    "{\"order_id\":\"ORD-1\",\"sku\":\"SKU-1\",\"name\":\"Shirt\",\"price\":75000.5,\"quantity\":2}"),
            JacksonMapper.readTree(events.get(0).eventJson()));
    }

    @Test
    void pagePingIsNotPublishedOrDropped() throws Exception {
        Parsed parsed = parseCapturingLog(getHit("e=pp&pp_mix=0&pp_max=200"));

        assertTrue(parsed.events().isEmpty());
        assertTrue(parsed.deadLetters().isEmpty());
        for (DroppedEvents.Reason reason : DroppedEvents.Reason.values()) {
            assertEquals(0, parsed.dropped(reason.label()), reason.label());
        }
    }

    @Test
    void transactionNumberFieldThatIsNotANumberStaysAString() throws Exception {
        List<ParsedEvent> events = parse(getHit("e=tr&tr_id=ORD-1&tr_tt=abc"));

        assertEquals(JacksonMapper.readTree("{\"order_id\":\"ORD-1\",\"total\":\"abc\"}"),
            JacksonMapper.readTree(events.get(0).eventJson()));
    }

    @Test
    void standardBase64InUePxAndCxKeepsTheEventData() throws Exception {
        String uePx = Base64.getEncoder().encodeToString(ADD_TO_CART.getBytes(StandardCharsets.UTF_8));
        String cx = Base64.getEncoder().encodeToString(CLIENT_SESSION.getBytes(StandardCharsets.UTF_8));
        assertTrue(uePx.contains("+") && uePx.contains("/") && cx.contains("+") && cx.contains("/"));

        List<ParsedEvent> events = parse(postHit(uePx, cx));

        assertEquals(1, events.size());
        ParsedEvent event = events.get(0);
        assertEquals("com.acme/add_to_cart", event.eventName());
        assertEquals("{\"sku\":\"SKU-1\",\"note\":\"???>>>\",\"com.snowplowanalytics.snowplow/client_session\":"
            + "{\"userId\":\"session-user\",\"note\":\"???>>>\"}}", event.eventJson());
        assertEquals("session-user", event.domainUserid());
    }

    @Test
    void urlSafeBase64InUePxAndCxKeepsTheEventData() throws Exception {
        String uePx = Base64
            .getUrlEncoder()
            .withoutPadding()
            .encodeToString(ADD_TO_CART.getBytes(StandardCharsets.UTF_8));
        String cx = Base64
            .getUrlEncoder()
            .withoutPadding()
            .encodeToString(CLIENT_SESSION.getBytes(StandardCharsets.UTF_8));

        List<ParsedEvent> events = parse(postHit(uePx, cx));

        assertEquals(1, events.size());
        ParsedEvent event = events.get(0);
        assertEquals("com.acme/add_to_cart", event.eventName());
        assertEquals("{\"sku\":\"SKU-1\",\"note\":\"???>>>\",\"com.snowplowanalytics.snowplow/client_session\":"
            + "{\"userId\":\"session-user\",\"note\":\"???>>>\"}}", event.eventJson());
        assertEquals("session-user", event.domainUserid());
    }

    @Test
    void getHitWithAnUnescapedStandardBase64UePxKeepsTheEventData() throws Exception {
        String uePx = Base64.getEncoder().encodeToString(ADD_TO_CART.getBytes(StandardCharsets.UTF_8));
        CollectorPayload hit = payload("/i")
            .setQuerystring("e=ue&eid=" + EVENT_ID + "&ttm=1760346764120&duid=a1b2c3&ue_px=" + uePx);

        List<ParsedEvent> events = parse(hit);

        assertEquals(1, events.size());
        assertEquals("com.acme/add_to_cart", events.get(0).eventName());
        assertEquals("{\"sku\":\"SKU-1\",\"note\":\"???>>>\"}", events.get(0).eventJson());
    }

    @Test
    void entitiesWithoutAValidSchemaOrAFirstNameAreSkippedAndLogged() throws Exception {
        String contexts = """
            {"schema":"iglu:com.snowplowanalytics.snowplow/contexts/jsonschema/1-0-0","data":[\
            {"schema":"iglu:com.acme/product/jsonschema/1-0-0","data":{"sku":"SKU-1"}},\
            {"schema":"iglu:com.acme/product/jsonschema/1-0-0","data":{"sku":"SKU-2"}},\
            {"schema":"not-a-schema-%s","data":{"sku":"SKU-3"}}]}""".formatted(SECRET);
        String cx = Base64.getEncoder().encodeToString(contexts.getBytes(StandardCharsets.UTF_8));
        String uePx = Base64.getEncoder().encodeToString(ADD_TO_CART.getBytes(StandardCharsets.UTF_8));

        Parsed parsed = parseCapturingLog(postHit(uePx, cx));

        assertEquals(1, parsed.events().size());
        assertEquals("{\"sku\":\"SKU-1\",\"note\":\"???>>>\",\"com.acme/product\":{\"sku\":\"SKU-1\"}}",
            parsed.events().get(0).eventJson());
        assertFalse(parsed.log().contains(SECRET), parsed.log());
        assertLogged(parsed, "Skipping entity com.acme/product: event_json already has that key");
        assertLogged(parsed, "Skipping an entity without a valid schema or object data");
    }

    @Test
    void fieldThatDoesNotDecodeIsLoggedWithoutItsContent() throws Exception {
        CollectorPayload hit = payload("/com.snowplowanalytics.snowplow/tp2")
            .setBody("""
                {"data":[{"e":"pv","eid":"%s","ttm":"1760346764120","duid":"a1b2c3","co":"%s"}]}"""
                .formatted(EVENT_ID, SECRET));

        Parsed parsed = parseCapturingLog(hit);

        assertEquals(1, parsed.events().size());
        assertFalse(parsed.log().contains(SECRET), parsed.log());
        assertLogged(parsed, "Ignoring co that does not decode: com.fasterxml.jackson.core.JsonParseException");
    }

    @Test
    void payloadThatDoesNotDecodeIsLoggedWithoutItsContent() throws Exception {
        CollectorPayload hit = payload("/com.snowplowanalytics.snowplow/tp2").setBody("{\"data\":[" + SECRET + "]}");

        Parsed parsed = parseCapturingLog(hit);

        assertEquals(0, parsed.events().size());
        assertFalse(parsed.log().contains(SECRET), parsed.log());
        assertLogged(parsed,
            "Dropping a collector payload that does not decode: com.fasterxml.jackson.core.JsonParseException");
    }

    @Test
    void getHitWithABadPercentEscapeIsDroppedAndLogged() throws Exception {
        CollectorPayload hit = payload("/i")
            .setQuerystring("e=pv&eid=" + EVENT_ID + "&ttm=1760346764120&uid=" + SECRET + "%zz");

        Parsed parsed = parseCapturingLog(hit);

        assertEquals(0, parsed.events().size());
        assertFalse(parsed.log().contains(SECRET), parsed.log());
        assertLogged(parsed, "Dropping a collector payload that does not decode: java.lang.IllegalArgumentException");
    }

    @Test
    void placeholderIdsAreTreatedAsAbsent() throws Exception {
        CollectorPayload hit = payload("/com.snowplowanalytics.snowplow/tp2")
            .setBody("""
                {"data":[\
                {"e":"pv","eid":"%s","ttm":"1760346764120","duid":"a1b2c3","uid":"  Unknown "},\
                {"e":"pv","eid":"%s","ttm":"1760346764120","duid":"NULL","uid":"0912345678"}]}"""
                .formatted(EVENT_ID, EVENT_ID));

        List<ParsedEvent> events = parse(hit);

        assertEquals(2, events.size());
        assertNull(events.get(0).userId());
        assertEquals("a1b2c3", events.get(0).domainUserid());
        assertNull(events.get(1).domainUserid());
        assertEquals("0912345678", events.get(1).userId());
    }

    @Test
    void configuredPlaceholderIdsReplaceTheDefault() throws Exception {
        CollectorPayload hit = payload("/com.snowplowanalytics.snowplow/tp2")
            .setBody("""
                {"data":[{"e":"pv","eid":"%s","ttm":"1760346764120","duid":"unknown","uid":" GUEST "}]}"""
                .formatted(EVENT_ID));

        List<ParsedEvent> events = parseCapturingLog(
            new ParseSnowplowEvent(PlaceholderIds.parse("guest, n/a"), LegacyContextPrefix.DEFAULT,
                DeadLetter.DEFAULT_PAYLOAD_LIMIT),
            hit)
            .events();

        assertEquals(1, events.size());
        assertNull(events.get(0).userId());
        assertEquals("unknown", events.get(0).domainUserid());
    }

    @Test
    void placeholderListWithAnEmptyEntryIsRejected() {
        IllegalArgumentException error = assertThrows(IllegalArgumentException.class,
            () -> PlaceholderIds.parse("unknown,,null"));

        assertEquals("EVENT_PARSE_PLACEHOLDER_IDS has an empty entry: \"unknown,,null\"", error.getMessage());
    }

    @Test
    void droppedEventsAreCountedByReasonAndLoggedOncePerReason() throws Exception {
        CollectorPayload hit = payload("/com.snowplowanalytics.snowplow/tp2")
            .setBody("""
                {"data":[\
                {"e":"pv","eid":"%s","ttm":"1760346764120","duid":"a1b2c3"},\
                {"e":"pv","ttm":"1760346764120","duid":"a1b2c3"},\
                {"e":"pv","eid":"%s","ttm":"1760346764120","duid":"a1b2c3"},\
                {"e":"pv","eid":"%s","duid":"a1b2c3"},\
                {"e":"pv","eid":"%s","ttm":"1760346764120","duid":"a1b2c3"}]}"""
                .formatted(SECRET, SECRET, EVENT_ID, EVENT_ID));

        Parsed parsed = parseCapturingLog(hit);

        assertEquals(1, parsed.events().size());
        assertEquals(3, parsed.dropped("invalid_event_id"));
        assertEquals(1, parsed.dropped("no_timestamp"));
        assertFalse(parsed.log().contains(SECRET), parsed.log());
        assertEquals(1, parsed.lines("Dropping an event whose id is missing or not a UUID: eid"), parsed.log());
        assertEquals(1, parsed.lines("Dropping an event without a usable timestamp: ttm, dtm, stm"), parsed.log());
    }

    @Test
    void payloadsThatDoNotDecodeAreCountedAndLoggedOnce() throws Exception {
        CollectorPayload badEscape = payload("/i")
            .setQuerystring("e=pv&eid=" + EVENT_ID + "&ttm=1760346764120&uid=" + SECRET + "%zz");
        CollectorPayload badBody = payload("/com.snowplowanalytics.snowplow/tp2")
            .setBody("{\"data\":[" + SECRET + "]}");

        Parsed parsed = parseCapturingLog(badEscape, badBody);

        assertEquals(0, parsed.events().size());
        assertEquals(2, parsed.dropped("payload_not_decoded"));
        assertEquals(1, parsed.lines("Dropping a collector payload that does not decode"), parsed.log());
    }

    @Test
    void payloadsWithoutAnEventArrayAreCountedAsNotDecoded() throws Exception {
        CollectorPayload emptyObject = payload("/com.snowplowanalytics.snowplow/tp2").setBody("{}");
        CollectorPayload bareArray = payload("/com.snowplowanalytics.snowplow/tp2").setBody("[{\"e\":\"pv\"}]");
        CollectorPayload dataObject = payload("/com.snowplowanalytics.snowplow/tp2").setBody("{\"data\":{}}");
        CollectorPayload noBodyOrQuery = payload("/i");
        CollectorPayload emptyBatch = payload("/com.snowplowanalytics.snowplow/tp2").setBody("{\"data\":[]}");

        Parsed parsed = parseCapturingLog(emptyObject, bareArray, dataObject, noBodyOrQuery, emptyBatch);

        assertEquals(0, parsed.events().size());
        assertEquals(4, parsed.dropped("payload_not_decoded"));
    }

    @Test
    void emptyRecordIsCountedAsNotDecoded() throws Exception {
        List<byte[]> inputs = new ArrayList<>();
        inputs.add(null);

        Parsed parsed = parseCapturingLog(new ParseSnowplowEvent(), inputs);

        assertEquals(1, parsed.dropped("payload_not_decoded"));
        assertLogged(parsed, "Dropping a collector payload that does not decode: raw_payload");
    }

    @Test
    void blankOrUndefinedAppIdGetsTheDefault() throws Exception {
        CollectorPayload hit = payload("/com.snowplowanalytics.snowplow/tp2")
            .setBody("""
                {"data":[\
                {"e":"pv","eid":"%s","ttm":"1760346764120","aid":""},\
                {"e":"pv","eid":"%s","ttm":"1760346764120","aid":" undefined "},\
                {"e":"pv","eid":"%s","ttm":"1760346764120"},\
                {"e":"pv","eid":"%s","ttm":"1760346764120","aid":" shop "}]}"""
                .formatted(EVENT_ID, EVENT_ID, EVENT_ID, EVENT_ID));

        List<Row> rows = parseCapturingLog(hit).rows();

        assertEquals(List.of("auroracy-ecommerce", "auroracy-ecommerce", "auroracy-ecommerce", "shop"),
            rows.stream().map(row -> row.<String>getFieldAs("app_id")).toList());
    }

    @Test
    void placeholderAppIdGetsTheDefault() throws Exception {
        String body = """
            {"data":[\
            {"e":"pv","eid":"%s","ttm":"1760346764120","aid":" Unknown "},\
            {"e":"pv","eid":"%s","ttm":"1760346764120","aid":"NULL"},\
            {"e":"pv","eid":"%s","ttm":"1760346764120","aid":"guest"}]}"""
            .formatted(EVENT_ID, EVENT_ID, EVENT_ID);
        CollectorPayload hit = payload("/com.snowplowanalytics.snowplow/tp2").setBody(body);

        List<Row> defaults = parseCapturingLog(hit).rows();
        List<Row> configured = parseCapturingLog(
            new ParseSnowplowEvent(PlaceholderIds.parse("guest"), LegacyContextPrefix.DEFAULT,
                DeadLetter.DEFAULT_PAYLOAD_LIMIT),
            hit).rows();

        assertEquals(List.of("auroracy-ecommerce", "auroracy-ecommerce", "guest"),
            defaults.stream().map(row -> row.<String>getFieldAs("app_id")).toList());
        assertEquals(List.of("Unknown", "NULL", "auroracy-ecommerce"),
            configured.stream().map(row -> row.<String>getFieldAs("app_id")).toList());
    }

    @Test
    void anUnsetOrZeroCollectorTimeIsPublishedAsNull() throws Exception {
        String body = """
            {"data":[{"e":"pv","eid":"%s","ttm":"1760346764120","duid":"a1b2c3"}]}""".formatted(EVENT_ID);
        CollectorPayload unset = payload("/com.snowplowanalytics.snowplow/tp2").setTimestamp(0).setBody(body);
        unset.unsetTimestamp();
        CollectorPayload zero = payload("/com.snowplowanalytics.snowplow/tp2").setTimestamp(0).setBody(body);
        CollectorPayload set = payload("/com.snowplowanalytics.snowplow/tp2").setBody(body);

        List<ParsedEvent> events = parseCapturingLog(unset, zero, set).events();

        assertEquals(Arrays.asList(null, null, COLLECTOR_TIMESTAMP),
            events.stream().map(ParsedEvent::collectorTimestamp).toList());
    }

    @Test
    void networkUserIdPassesThroughUnchanged() throws Exception {
        CollectorPayload hit = payload("/com.snowplowanalytics.snowplow/tp2")
            .setNetworkUserId(" Unknown ")
            .setBody("""
                {"data":[{"e":"pv","eid":"%s","ttm":"1760346764120","duid":"a1b2c3"}]}""".formatted(EVENT_ID));

        List<ParsedEvent> events = parse(hit);

        assertEquals(1, events.size());
        assertEquals(" Unknown ", events.get(0).networkUserid());
    }

    @Test
    void eventWithoutTtmIsDroppedWhenTheCollectorTimestampIsUnsetOrNotPositive() throws Exception {
        String body = """
            {"data":[\
            {"e":"pv","eid":"%s","dtm":"800","stm":"900","duid":"a1b2c3"},\
            {"e":"pv","eid":"%s","ttm":"1760346764120","duid":"a1b2c3"}]}""".formatted(EVENT_ID, EVENT_ID);
        // A writer that leaves the field out gives the reader 0 and no isset bit.
        CollectorPayload unset = payload("/com.snowplowanalytics.snowplow/tp2").setTimestamp(0).setBody(body);
        unset.unsetTimestamp();
        CollectorPayload zero = payload("/com.snowplowanalytics.snowplow/tp2").setTimestamp(0).setBody(body);

        Parsed parsed = parseCapturingLog(unset, zero);

        assertEquals(List.of(1760346764120L, 1760346764120L),
            parsed.events().stream().map(ParsedEvent::eventTimestamp).toList());
        assertEquals(2, parsed.dropped("no_timestamp"));
    }

    @Test
    void derivedTimestampCorrectsTheCollectorTimeByTheDeviceClockOffset() throws Exception {
        CollectorPayload hit = payload("/com.snowplowanalytics.snowplow/tp2")
            .setTimestamp(1000)
            .setBody("""
                {"data":[{"e":"pv","eid":"%s","dtm":"800","stm":"900","duid":"a1b2c3"}]}""".formatted(EVENT_ID));

        List<ParsedEvent> events = parse(hit);

        assertEquals(1, events.size());
        assertEquals(900L, events.get(0).eventTimestamp());
    }

    @Test
    void domainUserIdComesOnlyFromTheSnowplowClientSessionContext() throws Exception {
        String vendorSession = """
            {"schema":"iglu:com.snowplowanalytics.snowplow/contexts/jsonschema/1-0-0",\
            "data":[{"schema":"iglu:com.acme/client_session_v2/jsonschema/1-0-0","data":{"userId":"vendor-user"}}]}""";
        String cx = Base64.getEncoder().encodeToString(vendorSession.getBytes(StandardCharsets.UTF_8));
        CollectorPayload hit = payload("/com.snowplowanalytics.snowplow/tp2")
            .setBody("""
                {"data":[{"e":"pv","eid":"%s","ttm":"1760346764120","duid":"a1b2c3","cx":"%s"}]}"""
                .formatted(EVENT_ID, cx));

        List<ParsedEvent> events = parse(hit);

        assertEquals(1, events.size());
        assertEquals("a1b2c3", events.get(0).domainUserid());
    }

    @Test
    void parserLeavesCanonIdToIdentityStitching() throws Exception {
        CollectorPayload hit = payload("/com.snowplowanalytics.snowplow/tp2")
            .setBody("""
                {"data":[{"e":"pv","eid":"%s","ttm":"1760346764120","duid":"a1b2c3","uid":"0912345678"}]}"""
                .formatted(EVENT_ID));

        List<ParsedEvent> events = parse(hit);

        assertEquals(1, events.size());
        assertNull(events.get(0).canonId());
    }

    @Test
    void postHitWithSeveralEventsEmitsOneEventEach() throws Exception {
        String second = "6f0c1a2e-8a51-4c4e-9d1b-1d2f3e4a5b6c";
        CollectorPayload hit = payload("/com.snowplowanalytics.snowplow/tp2")
            .setUserAgent("Mozilla/5.0")
            .setNetworkUserId("nuid-1")
            .setBody("""
                {"data":[\
                {"e":"pv","eid":"%s","ttm":"1760346764120","duid":"a1b2c3","url":"https://shop.example/",\
                "refr":"https://search.example/","p":"web"},\
                {"e":"se","se_ac":"play","eid":"%s","ttm":"1760346764121","uid":"0912345678","p":"mob"}]}"""
                .formatted(EVENT_ID, second));

        List<Row> rows = parseCapturingLog(hit).rows();

        assertEquals(2, rows.size());
        Row first = rows.get(0);
        assertEquals(EVENT_ID, first.getField("event_id"));
        assertEquals("view_page", first.getField("event_name"));
        assertEquals(1760346764120L, first.getField("event_timestamp"));
        assertEquals(COLLECTOR_TIMESTAMP, first.getField("collector_timestamp"));
        assertEquals("203.0.113.7", first.getField("ip"));
        assertEquals("Mozilla/5.0", first.getField("user_agent"));
        assertEquals("nuid-1", first.getField("network_userid"));
        assertEquals("https://shop.example/", first.getField("url"));
        assertEquals("https://search.example/", first.getField("referrer_url"));
        assertEquals("web", first.getField("platform"));
        assertEquals("a1b2c3", first.getField("domain_userid"));
        assertNull(first.getField("event_json"));
        Row next = rows.get(1);
        assertEquals(second, next.getField("event_id"));
        assertEquals("play", next.getField("event_name"));
        assertEquals("0912345678", next.getField("user_id"));
        assertNull(next.getField("domain_userid"));
    }

    @Test
    void eventNameFromTheEventDataWinsAndLosesTrailingBackslashes() throws Exception {
        String named = """
            {"schema":"iglu:com.snowplowanalytics.snowplow/unstruct_event/jsonschema/1-0-0",\
            "data":{"schema":"iglu:com.acme/add_to_cart/jsonschema/1-0-0",\
            "data":{"event_name":"checkout\\\\","screen_location":"Cart","value":"Shoe"}}}""";
        String uePx = Base64.getEncoder().encodeToString(named.getBytes(StandardCharsets.UTF_8));
        CollectorPayload hit = payload("/com.snowplowanalytics.snowplow/tp2")
            .setBody("""
                {"data":[{"e":"ue","eid":"%s","ttm":"1760346764120","duid":"a1b2c3","page":"Ignored","ue_px":"%s"}]}"""
                .formatted(EVENT_ID, uePx));

        List<Row> rows = parseCapturingLog(hit).rows();

        assertEquals(1, rows.size());
        assertEquals("checkout", rows.get(0).getField("event_name"));
        assertEquals("Cart", rows.get(0).getField("screen_location"));
        assertEquals("Shoe", rows.get(0).getField("product_name"));
    }

    @Test
    void legacyBasicContextBecomesTheEventJsonWithItsVendorContextsNestedAndEveryEntityAdded() throws Exception {
        String contexts = """
            {"schema":"iglu:com.snowplowanalytics.snowplow/contexts/jsonschema/1-0-0","data":[\
            {"schema":"iglu:com.example.snowplow/basic/jsonschema/1-0-0","data":{"event_name":"purchase"}},\
            {"schema":"iglu:com.example.snowplow/product/jsonschema/1-0-0","data":{"price":12990000}},\
            {"schema":"iglu:com.other/product_v2/jsonschema/1-0-0","data":{"price":1}}]}""";
        CollectorPayload hit = payload("/com.snowplowanalytics.snowplow/tp2")
            .setBody("""
                {"data":[{"e":"pv","eid":"%s","ttm":"1760346764120","duid":"a1b2c3","co":%s}]}"""
                .formatted(EVENT_ID, JacksonMapper.instance().writeValueAsString(contexts)));

        List<Row> rows = parseCapturingLog(hit).rows();

        assertEquals(1, rows.size());
        assertEquals("purchase", rows.get(0).getField("event_name"));
        assertEquals("{\"event_name\":\"purchase\",\"product\":{\"price\":12990000},"
            + "\"com.example.snowplow/basic\":{\"event_name\":\"purchase\"},"
            + "\"com.example.snowplow/product\":{\"price\":12990000},\"com.other/product_v2\":{\"price\":1}}",
            rows.get(0).getField("event_json"));
    }

    @Test
    void aPayloadThatDoesNotDecodeIsWrittenAsADeadLetterWithItsBytes() throws Exception {
        CollectorPayload hit = payload("/com.snowplowanalytics.snowplow/tp2").setBody("{\"data\":[" + SECRET + "]}");
        byte[] bytes = new TSerializer().serialize(hit);

        Parsed parsed = parseCapturingLog(new ParseSnowplowEvent(), List.of(bytes));

        assertEquals(List
            .of(payloadLetter("payload_not_decoded", "com.fasterxml.jackson.core.JsonParseException", bytes,
                bytes.length, false)),
            parsed.deadLetterJson());
        assertEquals(1, parsed.dropped("payload_not_decoded"));
    }

    @Test
    void anEmptyRecordIsWrittenAsADeadLetterWithoutAPayload() throws Exception {
        List<byte[]> inputs = new ArrayList<>();
        inputs.add(null);

        Parsed parsed = parseCapturingLog(new ParseSnowplowEvent(), inputs);

        ObjectNode letter = letter("payload", "payload_not_decoded", "raw_payload");
        letter.putNull("event_name");
        letter.putNull("collector_timestamp");
        letter.putNull("payload_id");
        letter.putNull("payload");
        letter.putNull("payload_size");
        letter.putNull("payload_truncated");
        letter.putNull("event");
        assertEquals(List.of(letter), parsed.deadLetterJson());
    }

    @Test
    void aPayloadWithSeveralDroppedEventsIsWrittenOnceAndEachEventRefersToIt() throws Exception {
        CollectorPayload hit = payload("/com.snowplowanalytics.snowplow/tp2")
            .setBody("""
                {"data":[\
                {"e":"pv","eid":"%s","ttm":"1760346764120","duid":"a1b2c3"},\
                {"e":"pv","eid":"%s","ttm":"1760346764120","duid":"a1b2c3"},\
                {"e":"pv","eid":"bad","ttm":"1760346764120"},\
                {"e":"pv","eid":"%s","duid":"a1b2c3"}]}"""
                .formatted(EVENT_ID, SECRET, EVENT_ID));
        byte[] bytes = new TSerializer().serialize(hit);

        Parsed parsed = parseCapturingLog(new ParseSnowplowEvent(), List.of(bytes));

        assertEquals(1, parsed.events().size());
        assertEquals(List
            .of(payloadLetter(null, null, bytes, bytes.length, false),
                eventLetter("invalid_event_id", "eid", bytes, """
                    {"e":"pv","eid":"%s","ttm":"1760346764120","duid":"a1b2c3"}""".formatted(SECRET)),
                eventLetter("invalid_event_id", "eid", bytes, """
                    {"e":"pv","eid":"bad","ttm":"1760346764120"}"""),
                eventLetter("no_timestamp", "ttm, dtm, stm", bytes, """
                    {"e":"pv","eid":"%s","duid":"a1b2c3"}""".formatted(EVENT_ID))),
            parsed.deadLetterJson());
        assertFalse(parsed.log().contains(SECRET), parsed.log());
    }

    @Test
    void aPayloadOverTheLimitIsTruncatedAndFlagged() throws Exception {
        String filler = "x".repeat(600 * 1024);
        CollectorPayload hit = payload("/com.snowplowanalytics.snowplow/tp2").setBody("{\"data\":[" + filler + "]}");
        byte[] bytes = new TSerializer().serialize(hit);

        Parsed parsed = parseCapturingLog(new ParseSnowplowEvent(), List.of(bytes));

        byte[] kept = Arrays.copyOf(bytes, 512 * 1024);
        ObjectNode expected = payloadLetter("payload_not_decoded", "com.fasterxml.jackson.core.JsonParseException",
            bytes, bytes.length, true);
        expected.put("payload", Base64.getEncoder().encodeToString(kept));
        assertEquals(List.of(expected), parsed.deadLetterJson());
    }

    @Test
    void thePayloadLimitMustBeAPositiveInteger() {
        assertEquals(512 * 1024, DeadLetter.payloadLimit(" "));
        assertEquals(1000, DeadLetter.payloadLimit(" 1000 "));
        for (String limit : new String[] {"0", "-1", "512KB"}) {
            IllegalArgumentException error = assertThrows(IllegalArgumentException.class,
                () -> DeadLetter.payloadLimit(limit));
            assertEquals("EVENT_PARSE_DEAD_LETTER_PAYLOAD_LIMIT must be a positive integer: \"" + limit + "\"",
                error.getMessage());
        }
    }

    /** A dead letter that holds a payload, as its JSON. */
    private static ObjectNode payloadLetter(String reason, String detail, byte[] bytes, int size, boolean truncated)
        throws Exception {
        ObjectNode letter = letter("payload", reason, detail);
        letter.put("payload_id", sha256(bytes));
        letter.put("payload", Base64.getEncoder().encodeToString(bytes));
        letter.put("payload_size", size);
        letter.put("payload_truncated", truncated);
        letter.putNull("event");
        letter.putNull("event_name");
        letter.putNull("collector_timestamp");
        return letter;
    }

    /** A dead letter that holds one page view of a payload, as its JSON. */
    private static ObjectNode eventLetter(String reason, String detail, byte[] bytes, String event) throws Exception {
        ObjectNode letter = letter("event", reason, detail);
        letter.put("payload_id", sha256(bytes));
        letter.putNull("payload");
        letter.putNull("payload_size");
        letter.putNull("payload_truncated");
        letter.set("event", JacksonMapper.readTree(event));
        letter.put("event_name", "view_page");
        letter.put("collector_timestamp", COLLECTOR_TIMESTAMP);
        return letter;
    }

    private static ObjectNode letter(String record, String reason, String detail) {
        ObjectNode letter = JacksonMapper.instance().createObjectNode();
        letter.put("record", record);
        letter.put("reason", reason);
        letter.put("detail", detail);
        letter.put("dropped_at", DROPPED_AT);
        return letter;
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static CollectorPayload postHit(String uePx, String cx) {
        return payload("/com.snowplowanalytics.snowplow/tp2")
            .setBody(
                """
                    {"schema":"iglu:com.snowplowanalytics.snowplow/payload_data/jsonschema/1-0-4",\
                    "data":[{"e":"ue","eid":"%s","ttm":"1760346764120","duid":"a1b2c3","p":"web","ue_px":"%s","cx":"%s"}]}"""
                    .formatted(EVENT_ID, uePx, cx));
    }

    private static CollectorPayload getHit(String params) {
        return payload("/i").setQuerystring(params + "&eid=" + EVENT_ID + "&ttm=1760346764120&duid=a1b2c3");
    }

    private static CollectorPayload payload(String path) {
        return new CollectorPayload()
            .setSchema("iglu:com.snowplowanalytics.snowplow/CollectorPayload/thrift/1-0-0")
            .setIpAddress("203.0.113.7")
            .setTimestamp(COLLECTOR_TIMESTAMP)
            .setEncoding("UTF-8")
            .setCollector("opensnowcat-test")
            .setPath(path);
    }

    private static List<ParsedEvent> parse(CollectorPayload payload) throws Exception {
        return parseCapturingLog(payload).events();
    }

    private record Parsed(List<ParsedEvent> events, List<DeadLetter> deadLetters, String log,
        Map<String, Counter> counters) {

        /** Each event as a row named by its published columns. */
        List<Row> rows() {
            String[] names = ParsedEvent.ROW_TYPE.getFieldNames();
            return events.stream().map(event -> {
                Row positional = event.toRow();
                Row named = Row.withNames();
                for (int i = 0; i < names.length; i++) {
                    named.setField(names[i], positional.getField(i));
                }
                return named;
            }).toList();
        }

        /** Each dead letter as the JSON the dead-letter topic receives. */
        List<JsonNode> deadLetterJson() {
            return deadLetters.stream().map(JacksonMapper::writeValueAsString).map(JacksonMapper::readTree).toList();
        }

        long dropped(String reason) {
            Counter counter = counters.get("reason=" + reason + ".droppedEvents");
            return counter == null ? 0 : counter.getCount();
        }

        long lines(String text) {
            return log.lines().filter(line -> line.contains(text)).count();
        }
    }

    private static void assertLogged(Parsed parsed, String line) {
        assertTrue(parsed.log().contains(line), parsed.log());
    }

    // slf4j-simple writes to whatever System.err is at the time of each log call.
    private static Parsed parseCapturingLog(CollectorPayload... payloads) throws Exception {
        return parseCapturingLog(new ParseSnowplowEvent(), payloads);
    }

    private static Parsed parseCapturingLog(ParseSnowplowEvent function, CollectorPayload... payloads)
        throws Exception {
        List<byte[]> inputs = new ArrayList<>();
        for (CollectorPayload payload : payloads) {
            inputs.add(new TSerializer().serialize(payload));
        }
        return parseCapturingLog(function, inputs);
    }

    private static Parsed parseCapturingLog(ParseSnowplowEvent function, List<byte[]> inputs) throws Exception {
        List<ParsedEvent> events = new ArrayList<>();
        List<DeadLetter> deadLetters = new ArrayList<>();
        Map<String, Counter> counters = new HashMap<>();
        function.setRuntimeContext(runtimeContext(new RecordingOperatorMetricGroup(counters)));
        ProcessFunction<Row, ParsedEvent>.Context context = function.new Context() {
            @Override
            public Long timestamp() {
                return null;
            }

            @Override
            public TimerService timerService() {
                return new ProcessingTimeAt(DROPPED_AT);
            }

            @Override
            public <X> void output(OutputTag<X> outputTag, X value) {
                assertEquals(DeadLetter.OUTPUT, outputTag);
                deadLetters.add((DeadLetter) value);
            }
        };

        PrintStream original = System.err;
        ByteArrayOutputStream log = new ByteArrayOutputStream();
        System.setErr(new PrintStream(log, true, StandardCharsets.UTF_8));
        try {
            function.open(DefaultOpenContext.INSTANCE);
            for (byte[] input : inputs) {
                Row record = Row.withNames();
                record.setField("raw_payload", input);
                function.processElement(record, context, new ListCollector<>(events));
            }
        } finally {
            System.setErr(original);
        }
        return new Parsed(events, deadLetters, log.toString(StandardCharsets.UTF_8), counters);
    }

    /** A runtime context that answers only for its metric group. */
    private static RuntimeContext runtimeContext(OperatorMetricGroup metrics) {
        return (RuntimeContext) Proxy
            .newProxyInstance(RuntimeContext.class.getClassLoader(), new Class<?>[] {RuntimeContext.class},
                (proxy, method, args) -> {
                    if (method.getName().equals("getMetricGroup")) return metrics;
                    throw new UnsupportedOperationException(method.getName());
                });
    }

    private record ProcessingTimeAt(long now) implements TimerService {

        @Override
        public long currentProcessingTime() {
            return now;
        }

        @Override
        public long currentWatermark() {
            throw new UnsupportedOperationException();
        }

        @Override
        public void registerProcessingTimeTimer(long time) {
            throw new UnsupportedOperationException();
        }

        @Override
        public void registerEventTimeTimer(long time) {
            throw new UnsupportedOperationException();
        }

        @Override
        public void deleteProcessingTimeTimer(long time) {
            throw new UnsupportedOperationException();
        }

        @Override
        public void deleteEventTimeTimer(long time) {
            throw new UnsupportedOperationException();
        }
    }

    private static final class RecordingOperatorMetricGroup
        extends
            UnregisteredMetricGroups.UnregisteredOperatorMetricGroup {
        private final Map<String, Counter> counters;

        RecordingOperatorMetricGroup(Map<String, Counter> counters) {
            this.counters = counters;
        }

        @Override
        public MetricGroup addGroup(String key, String value) {
            return new RecordingMetricGroup(counters, key + "=" + value + ".");
        }
    }

    /**
     * Records each counter by its path of key-value groups, such as
     * {@code reason=x.name}.
     */
    private static final class RecordingMetricGroup extends UnregisteredMetricsGroup {
        private final Map<String, Counter> counters;
        private final String scope;

        RecordingMetricGroup(Map<String, Counter> counters, String scope) {
            this.counters = counters;
            this.scope = scope;
        }

        @Override
        public MetricGroup addGroup(String key, String value) {
            return new RecordingMetricGroup(counters, scope + key + "=" + value + ".");
        }

        @Override
        public Counter counter(String name) {
            return counter(name, new SimpleCounter());
        }

        @Override
        public <C extends Counter> C counter(String name, C counter) {
            counters.put(scope + name, counter);
            return counter;
        }
    }
}
