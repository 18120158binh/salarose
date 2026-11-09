package com.cdp.platform.jobs.eventparser.transforms;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.apache.flink.runtime.checkpoint.OperatorSubtaskState;
import org.apache.flink.streaming.api.operators.co.CoBroadcastWithNonKeyedOperator;
import org.apache.flink.streaming.util.BroadcastOperatorTestHarness;
import org.apache.flink.types.Either;
import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;

import com.cdp.platform.shared.models.ParsedEvent;
import com.cdp.platform.shared.utils.JacksonMapper;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

class SchemaGateFunctionTest {

    private static final String SECRET = "carol_ssn_123456789";
    private static final String DROP_LINE = "Dropping an event that does not match its catalog schema: ";

    @Test
    void anEventThatMatchesItsSchemaPasses() throws Exception {
        try (var gate = openGate()) {
            addToCartSchema(gate, true);

            List<ParsedEvent> passed = process(gate, event("add_to_cart", """
                {"product":{"id":"SKU-1","price":12990000},"quantity":2,"gift":false,
                 "added_at":"2026-10-18T09:30:00+07:00","extra":"not in the catalog"}"""));

            assertEquals(1, passed.size());
        }
    }

    @Test
    void anEventWithoutARequiredAttributeIsDroppedAndLoggedWithoutContent() throws Exception {
        try (var gate = openGate()) {
            addToCartSchema(gate, true);

            String log = capturingLog(() -> assertEquals(List.of(), process(gate, event("add_to_cart", """
                {"product":{"id":"%s"},"quantity":2}""".formatted(SECRET)))));

            assertTrue(log.contains(DROP_LINE + "product.price missing (number)"), log);
            assertFalse(log.contains(SECRET), log);
        }
    }

    @Test
    void aDroppedEventIsWrittenAsADeadLetterWithTheParsedEvent() throws Exception {
        try (var gate = openGate()) {
            addToCartSchema(gate, true);
            gate.setProcessingTime(1760346765000L);
            ParsedEvent event = event("add_to_cart", "{\"product\":{\"id\":\"%s\"}}".formatted(SECRET));

            capturingLog(() -> assertEquals(List.of(), process(gate, event)));

            List<JsonNode> deadLetters = gate
                .getSideOutput(DeadLetter.OUTPUT)
                .stream()
                .map(record -> JacksonMapper.readTree(JacksonMapper.writeValueAsString(record.getValue())))
                .toList();
            ObjectNode expected = JacksonMapper.instance().createObjectNode();
            expected.put("record", "event");
            expected.put("reason", "schema_invalid");
            expected.put("detail", "product.price missing (number)");
            expected.put("dropped_at", 1760346765000L);
            expected.putNull("payload_id");
            expected.putNull("payload");
            expected.putNull("payload_size");
            expected.putNull("payload_truncated");
            expected.set("event", JacksonMapper.readTree(JacksonMapper.writeValueAsString(event)));
            expected.put("event_name", "add_to_cart");
            expected.put("collector_timestamp", 0);
            assertEquals(List.of(expected), deadLetters);
        }
    }

    @Test
    void anAttributeOfTheWrongTypeDropsTheEvent() throws Exception {
        Map<String, String> causeByEventJson = new LinkedHashMap<>();
        causeByEventJson.put("{\"product\":{\"id\":\"SKU-1\",\"price\":\"12990000\"}}", "product.price not number");
        causeByEventJson.put("{\"product\":{\"id\":1,\"price\":1}}", "product.id not string");
        causeByEventJson.put("{\"product\":\"SKU-1\"}", "product not json");
        causeByEventJson.put("{\"product\":{\"id\":\"SKU-1\",\"price\":1},\"gift\":\"no\"}", "gift not boolean");
        causeByEventJson
            .put("{\"product\":{\"id\":\"SKU-1\",\"price\":1},\"added_at\":1760346764120}",
                "added_at not datetime");
        causeByEventJson
            .put("{\"product\":{\"id\":\"SKU-1\",\"price\":1},\"added_at\":\"18/10/2026\"}",
                "added_at not datetime");

        for (Map.Entry<String, String> example : causeByEventJson.entrySet()) {
            try (var gate = openGate()) {
                addToCartSchema(gate, true);

                String log = capturingLog(
                    () -> assertEquals(List.of(), process(gate, event("add_to_cart", example.getKey()))));

                assertTrue(log.contains(DROP_LINE + example.getValue()), example.getKey() + "\n" + log);
            }
        }
    }

    @Test
    void withTheGateOffAnEventThatBreaksItsSchemaPasses() throws Exception {
        try (var gate = openGate()) {
            addToCartSchema(gate, false);

            assertEquals(1, process(gate, event("add_to_cart", "{\"product\":{\"price\":\"free\"}}")).size());
            assertEquals(1, process(gate, event("add_to_cart", null)).size());
        }
    }

    @Test
    void anEventThatIsNotInTheCatalogPasses() throws Exception {
        try (var gate = openGate()) {
            addToCartSchema(gate, true);

            assertEquals(1, process(gate, event("view_page", null)).size());
        }
    }

    @Test
    void nullOptionalValuesPassAndARequiredChildIsCheckedOnlyWhenItsParentIsPresent() throws Exception {
        try (var gate = openGate()) {
            gate.processBroadcastElement(Either.Left(catalogEvent("ue_1", "checkout", true)), 0L);
            gate.processBroadcastElement(Either.Right(attribute(1, "ue_1", "coupon", "json", false)), 0L);
            gate.processBroadcastElement(Either.Right(attribute(2, "ue_1", "coupon.code", "string", true)), 0L);
            gate.processBroadcastElement(Either.Right(attribute(3, "ue_1", "note", "string", false)), 0L);

            assertEquals(1, process(gate, event("checkout", "{\"note\":null}")).size());
            assertEquals(1, process(gate, event("checkout", null)).size());
            assertEquals(1, process(gate, event("checkout", "{\"coupon\":{\"code\":\"X\"}}")).size());
            assertEquals(List.of(), process(gate, event("checkout", "{\"coupon\":{}}")));
            assertEquals(List.of(), process(gate, event("checkout", "{\"coupon\":{\"code\":null}}")));
        }
    }

    @Test
    void aCatalogChangeAppliesFromTheNextEvent() throws Exception {
        try (var gate = openGate()) {
            addToCartSchema(gate, true);
            String withoutPrice = "{\"product\":{\"id\":\"SKU-1\"}}";
            assertEquals(List.of(), process(gate, event("add_to_cart", withoutPrice)));

            Row optionalPrice = attribute(3, "ue_1", "product.price", "number", false);
            gate
                .processBroadcastElement(Either
                    .Right(withKind(RowKind.UPDATE_BEFORE,
                        attribute(3, "ue_1", "product.price", "number", true))),
                    0L);
            gate.processBroadcastElement(Either.Right(withKind(RowKind.UPDATE_AFTER, optionalPrice)), 0L);
            assertEquals(1, process(gate, event("add_to_cart", withoutPrice)).size());

            gate.processBroadcastElement(Either.Right(withKind(RowKind.DELETE, optionalPrice)), 0L);
            gate
                .processBroadcastElement(Either
                    .Left(withKind(RowKind.UPDATE_AFTER,
                        catalogEvent("ue_1", "add_to_cart", false))),
                    0L);
            assertEquals(1, process(gate, event("add_to_cart", "{}")).size());
        }
    }

    @Test
    void anEventBetweenTheBeforeAndAfterImagesOfAnEditIsStillChecked() throws Exception {
        try (var gate = openGate()) {
            addToCartSchema(gate, true);
            String withoutPrice = "{\"product\":{\"id\":\"SKU-1\"}}";

            gate
                .processBroadcastElement(Either
                    .Right(withKind(RowKind.UPDATE_BEFORE,
                        attribute(3, "ue_1", "product.price", "number", true))),
                    0L);
            gate
                .processBroadcastElement(Either
                    .Left(withKind(RowKind.UPDATE_BEFORE,
                        catalogEvent("ue_1", "add_to_cart", true))),
                    0L);
            assertEquals(List.of(), process(gate, event("add_to_cart", withoutPrice)));

            gate
                .processBroadcastElement(Either
                    .Right(withKind(RowKind.UPDATE_AFTER,
                        attribute(3, "ue_1", "product.price", "number", true))),
                    0L);
            gate
                .processBroadcastElement(Either
                    .Left(withKind(RowKind.UPDATE_AFTER,
                        catalogEvent("ue_1", "add_to_cart", true))),
                    0L);
            assertEquals(List.of(), process(gate, event("add_to_cart", withoutPrice)));
        }
    }

    @Test
    void aRestoredGateKeepsTheCatalog() throws Exception {
        OperatorSubtaskState snapshot;
        try (var gate = openGate()) {
            addToCartSchema(gate, true);
            snapshot = gate.snapshot(1L, 1L);
        }

        try (var restored = gate()) {
            restored.initializeState(snapshot);
            restored.open();

            assertEquals(List.of(), process(restored, event("add_to_cart", "{}")));
        }
    }

    /**
     * {@code add_to_cart} with {@code product} (json, required),
     * {@code product.id} (string, required), {@code product.price} (number,
     * required), {@code quantity} (number), {@code gift} (boolean), and
     * {@code added_at} (datetime).
     */
    private static void addToCartSchema(BroadcastOperatorTestHarness<ParsedEvent, Either<Row, Row>, ParsedEvent> gate,
        boolean enforced) throws Exception {
        // Attributes before their event, as a CDC snapshot of two tables can deliver
        // them.
        gate.processBroadcastElement(Either.Right(attribute(1, "ue_1", "product", "json", true)), 0L);
        gate.processBroadcastElement(Either.Right(attribute(2, "ue_1", "product.id", "string", true)), 0L);
        gate.processBroadcastElement(Either.Right(attribute(3, "ue_1", "product.price", "number", true)), 0L);
        gate.processBroadcastElement(Either.Right(attribute(4, "ue_1", "quantity", "number", false)), 0L);
        gate.processBroadcastElement(Either.Right(attribute(5, "ue_1", "gift", "boolean", false)), 0L);
        gate.processBroadcastElement(Either.Right(attribute(6, "ue_1", "added_at", "datetime", false)), 0L);
        gate.processBroadcastElement(Either.Left(catalogEvent("ue_1", "add_to_cart", enforced)), 0L);
    }

    private static Row catalogEvent(String id, String eventName, boolean enforceSchema) {
        Row row = Row.withNames(RowKind.INSERT);
        row.setField("id", id);
        row.setField("event_name", eventName);
        row.setField("enforce_schema", enforceSchema);
        return row;
    }

    private static Row attribute(int id, String eventId, String path, String dataType, boolean required) {
        Row row = Row.withNames(RowKind.INSERT);
        row.setField("id", id);
        row.setField("user_event_id", eventId);
        row.setField("field_path", path);
        row.setField("data_type", dataType);
        row.setField("required", required);
        return row;
    }

    private static Row withKind(RowKind kind, Row row) {
        row.setKind(kind);
        return row;
    }

    private static ParsedEvent event(String eventName, String eventJson) {
        return new ParsedEvent(null, null, null, 0L, 0L, null, eventName, null, null, null, null, null, "d1", null,
            eventJson, null, "5f0c1a2e-8a51-4c4e-9d1b-1d2f3e4a5b6c");
    }

    private static List<ParsedEvent> process(
        BroadcastOperatorTestHarness<ParsedEvent, Either<Row, Row>, ParsedEvent> gate, ParsedEvent event)
        throws Exception {
        gate.getOutput().clear();
        gate.processElement(event, 0L);
        return gate.extractOutputValues();
    }

    private static BroadcastOperatorTestHarness<ParsedEvent, Either<Row, Row>, ParsedEvent> openGate()
        throws Exception {
        var gate = gate();
        gate.open();
        return gate;
    }

    private static BroadcastOperatorTestHarness<ParsedEvent, Either<Row, Row>, ParsedEvent> gate() throws Exception {
        return new BroadcastOperatorTestHarness<>(new CoBroadcastWithNonKeyedOperator<>(new SchemaGateFunction(),
            List.of(SchemaGateFunction.CATALOG_EVENTS, SchemaGateFunction.CATALOG_ATTRIBUTES)), 1, 1, 0);
    }

    @FunctionalInterface
    private interface ThrowingAction {
        void run() throws Exception;
    }

    // slf4j-simple writes to whatever System.err is at the time of each log call.
    private static String capturingLog(ThrowingAction action) throws Exception {
        PrintStream original = System.err;
        ByteArrayOutputStream log = new ByteArrayOutputStream();
        System.setErr(new PrintStream(log, true, StandardCharsets.UTF_8));
        try {
            action.run();
        } finally {
            System.setErr(original);
        }
        return log.toString(StandardCharsets.UTF_8);
    }
}
