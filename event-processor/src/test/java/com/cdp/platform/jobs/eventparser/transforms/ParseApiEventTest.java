package com.cdp.platform.jobs.eventparser.transforms;

import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

import org.apache.flink.api.common.functions.DefaultOpenContext;
import org.apache.flink.api.common.functions.RuntimeContext;
import org.apache.flink.api.common.functions.util.ListCollector;
import org.apache.flink.runtime.metrics.groups.UnregisteredMetricGroups;
import org.apache.flink.streaming.api.TimerService;
import org.apache.flink.streaming.api.functions.ProcessFunction;
import org.apache.flink.types.Row;
import org.apache.flink.util.OutputTag;

import com.cdp.platform.shared.models.CollectorPayload;
import com.cdp.platform.shared.models.ParsedEvent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.apache.thrift.TSerializer;
import org.junit.jupiter.api.Test;

class ParseApiEventTest {

    private static final String EVENT_ID = "6b0c8f3e-1d2a-4c55-9a77-1f0e2d3c4b5a";
    private static final long EVENT_TIME = 1792314782120L;
    private static final long DROPPED_AT = 1792314790000L;
    private static final String ORDER = "{\"order\":{\"id\":\"SO-1001\",\"total\":12990000}}";

    /** The purchase of the data ingestion API contract, as the API writes it. */
    private static final String PURCHASE = "{\"schema_version\":1,\"event_id\":\"" + EVENT_ID
        + "\",\"event_name\":\"com.acme/purchase\",\"event_time\":" + EVENT_TIME
        + ",\"user_id\":\"0912345678\",\"anonymous_id\":\"a1b2c3\",\"app_id\":\"order-service\",\"attributes\":"
        + ORDER + "}";

    @Test
    void apiEventParsesIntoTheSameEventAsTheEquivalentTrackerHit() throws Exception {
        String unstructured = "{\"schema\":\"iglu:com.snowplowanalytics.snowplow/unstruct_event/jsonschema/1-0-0\","
            + "\"data\":{\"schema\":\"iglu:com.acme/purchase/jsonschema/1-0-0\",\"data\":" + ORDER + "}}";
        String uePx = Base64.getEncoder().encodeToString(unstructured.getBytes(StandardCharsets.UTF_8));
        CollectorPayload hit = new CollectorPayload()
            .setSchema("iglu:com.snowplowanalytics.snowplow/CollectorPayload/thrift/1-0-0")
            .setEncoding("UTF-8")
            .setCollector("opensnowcat-test")
            .setPath("/com.snowplowanalytics.snowplow/tp2")
            .setBody("{\"schema\":\"iglu:com.snowplowanalytics.snowplow/payload_data/jsonschema/1-0-4\","
                + "\"data\":[{\"e\":\"ue\",\"eid\":\"" + EVENT_ID + "\",\"ttm\":\"" + EVENT_TIME
                + "\",\"aid\":\"order-service\",\"uid\":\"0912345678\",\"duid\":\"a1b2c3\",\"ue_px\":\"" + uePx
                + "\"}]}");
        List<ParsedEvent> fromTracker = new ArrayList<>();
        ParseSnowplowEvent tracker = open(new ParseSnowplowEvent());
        Row record = Row.withNames();
        record.setField("raw_payload", new TSerializer().serialize(hit));
        tracker.processElement(record, context(tracker, new ArrayList<>()), new ListCollector<>(fromTracker));

        Parsed fromApi = parse(PURCHASE);

        assertEquals(1, fromTracker.size());
        assertEquals(fromTracker, fromApi.events());
        ParsedEvent event = fromApi.events().get(0);
        assertEquals("com.acme/purchase", event.eventName());
        assertEquals("a1b2c3", event.domainUserid());
        assertEquals("order-service", event.appId());
    }

    @Test
    void anEventWithOnlyAnAnonymousIdKeepsItAsTheDevice() throws Exception {
        Parsed parsed = parse(PURCHASE.replace("\"user_id\":\"0912345678\",", ""));

        assertEquals(1, parsed.events().size());
        assertNull(parsed.events().get(0).userId());
        assertEquals("a1b2c3", parsed.events().get(0).domainUserid());
    }

    @Test
    void messagesThatDoNotParseAreDroppedToDeadLetters() throws Exception {
        Parsed parsed = parse("not json", PURCHASE.replace(EVENT_ID, "not-a-uuid"),
            PURCHASE.replace("\"event_time\":" + EVENT_TIME, "\"event_time\":\"yesterday\""),
            PURCHASE.replace(ORDER, "[1]"));

        assertTrue(parsed.events().isEmpty());
        assertEquals(List.of("payload_not_decoded", "invalid_event_id", "no_timestamp", "event_not_decoded"),
            parsed.deadLetters().stream().filter(letter -> letter.reason() != null).map(DeadLetter::reason).toList());
        assertEquals(List.of("com.acme/purchase", "com.acme/purchase", "com.acme/purchase"),
            parsed
                .deadLetters()
                .stream()
                .filter(letter -> "event".equals(letter.record()))
                .map(DeadLetter::eventName)
                .toList());
    }

    private record Parsed(List<ParsedEvent> events, List<DeadLetter> deadLetters) {
    }

    private static Parsed parse(String... messages) throws Exception {
        List<ParsedEvent> events = new ArrayList<>();
        List<DeadLetter> deadLetters = new ArrayList<>();
        ParseApiEvent function = open(new ParseApiEvent());
        for (String message : messages) {
            function.processElement(message, context(function, deadLetters), new ListCollector<>(events));
        }
        return new Parsed(events, deadLetters);
    }

    private static <F extends ProcessFunction<?, ?>> F open(F function) throws Exception {
        RuntimeContext runtime = (RuntimeContext) Proxy
            .newProxyInstance(RuntimeContext.class.getClassLoader(), new Class<?>[] {RuntimeContext.class},
                (proxy, method, args) -> {
                    if (method.getName().equals("getMetricGroup"))
                        return UnregisteredMetricGroups.createUnregisteredOperatorMetricGroup();
                    throw new UnsupportedOperationException(method.getName());
                });
        function.setRuntimeContext(runtime);
        function.open(DefaultOpenContext.INSTANCE);
        return function;
    }

    private static <I> ProcessFunction<I, ParsedEvent>.Context context(ProcessFunction<I, ParsedEvent> function,
        List<DeadLetter> deadLetters) {
        return function.new Context() {
            @Override
            public Long timestamp() {
                return null;
            }

            @Override
            public TimerService timerService() {
                return new ProcessingTime();
            }

            @Override
            public <X> void output(OutputTag<X> outputTag, X value) {
                assertEquals(DeadLetter.OUTPUT, outputTag);
                deadLetters.add((DeadLetter) value);
            }
        };
    }

    private static final class ProcessingTime implements TimerService {

        @Override
        public long currentProcessingTime() {
            return DROPPED_AT;
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
}
