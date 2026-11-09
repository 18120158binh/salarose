package com.cdp.platform.jobs.statemachine.transforms;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.apache.flink.api.common.serialization.DeserializationSchema;
import org.apache.flink.metrics.Counter;
import org.apache.flink.metrics.MetricGroup;
import org.apache.flink.metrics.SimpleCounter;
import org.apache.flink.metrics.groups.UnregisteredMetricsGroup;
import org.apache.flink.util.Collector;
import org.apache.flink.util.SimpleUserCodeClassLoader;
import org.apache.flink.util.UserCodeClassLoader;

import com.cdp.platform.shared.models.JourneyTriggerEvent;
import com.cdp.platform.shared.models.VersionedTrigger;
import com.cdp.platform.shared.utils.JsonSerializationSchema;

import static org.junit.jupiter.api.Assertions.assertAll;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * The parser decodes each record of the trigger topic. A record that does not
 * decode, or a trigger without a journey key or an event time, cannot apply,
 * so the parser drops it, logs it, and counts it in
 * {@code invalidMatchedEvents}, and passes every other trigger on.
 */
class TriggerParserTest {

    private static final long T_10_00 = 1_760_346_000_000L;

    private final Map<String, Counter> counters = new HashMap<>();
    private TriggerParser parser;

    @BeforeEach
    void open() throws Exception {
        parser = new TriggerParser();
        parser.open(new DeserializationSchema.InitializationContext() {
            @Override
            public MetricGroup getMetricGroup() {
                return new RecordingMetricGroup(counters);
            }

            @Override
            public UserCodeClassLoader getUserCodeClassLoader() {
                return SimpleUserCodeClassLoader.create(TriggerParserTest.class.getClassLoader());
            }
        });
    }

    @Test
    void aTriggerDecodesAsTheTopicsJsonFormatDidBefore() throws Exception {
        String message = """
            {"schema_version":3,"event_id":"event-1","canon_id":"canon-1","domain_userid":"domain-1",
             "network_userid":null,"user_id":"user-1","campaign_id":"campaign-1","node_id":"n1_view",
             "branch":"next","event_name":"view_product","event_time":%d,"context_json":"{\\"sku\\":\\"A1\\"}",
             "unknown":{"nested":[1,2]}}
            """.formatted(T_10_00);

        assertEquals(List
            .of(new JourneyTriggerEvent(3, "event-1", "canon-1", "domain-1", null, "user-1", "campaign-1",
                "n1_view", "next", "view_product", T_10_00, "{\"sku\":\"A1\"}")),
            decode(message));
    }

    @Test
    void aFieldOfAnotherJsonTypeIsReadTheWayTheJsonFormatReadIt() throws Exception {
        String message = """
            {"schema_version":"2","canon_id":42,"campaign_id":"campaign-1","node_id":"n1_view",
             "event_time":" %d ","context_json":{"sku":"A1"}}
            """.formatted(T_10_00);

        assertEquals(List
            .of(new JourneyTriggerEvent(2, null, "42", null, null, null, "campaign-1", "n1_view", null, null,
                T_10_00, "{\"sku\":\"A1\"}")),
            decode(message));
    }

    /**
     * The producers write the graph version beside the trigger's fields, in the
     * same JSON object, and leave it out when they have none.
     */
    @Test
    void aTriggerReadsBackWithTheGraphVersionItsProducerWrote() throws Exception {
        JourneyTriggerEvent trigger = new JourneyTriggerEvent(4, "event-1", "canon-1", "domain-1", null, "user-1",
            "campaign-1", "n1_view", "next", "view_product", T_10_00, "{}");
        JsonSerializationSchema<VersionedTrigger> producer = new JsonSerializationSchema<>(VersionedTrigger.class);

        assertAll(
            () -> assertEquals(List.of(new VersionedTrigger(trigger, 7L)),
                decodeVersioned(producer.serialize(new VersionedTrigger(trigger, 7L)))),
            () -> assertEquals(List.of(new VersionedTrigger(trigger, null)),
                decodeVersioned(producer.serialize(new VersionedTrigger(trigger, null)))));
    }

    /**
     * A setup trigger may name its entry. A trigger without an entry id, or with
     * a blank one, names no entry.
     */
    @Test
    void aTriggerReadsBackWithTheEntryIdItsProducerWrote() throws Exception {
        JourneyTriggerEvent trigger = new JourneyTriggerEvent(4, "event-1", "canon-1", "domain-1", null, "user-1",
            "campaign-1", "n1_view", "next", "view_product", T_10_00, "{}");
        JsonSerializationSchema<VersionedTrigger> producer = new JsonSerializationSchema<>(VersionedTrigger.class);
        String blankEntryId = """
            {"canon_id":"canon-1","campaign_id":"campaign-1","node_id":"n1_view","event_time":%d,"entry_id":" "}
            """.formatted(T_10_00);

        assertAll(
            () -> assertEquals(List.of(new VersionedTrigger(trigger, 7L, "be-1")),
                decodeVersioned(producer.serialize(new VersionedTrigger(trigger, 7L, "be-1")))),
            () -> assertEquals(List.of(new VersionedTrigger(trigger, 7L)),
                decodeVersioned(producer.serialize(new VersionedTrigger(trigger, 7L)))),
            () -> assertNull(decodeVersioned(blankEntryId.getBytes(StandardCharsets.UTF_8)).getFirst().entryId()));
    }

    @Test
    void aTriggerWithoutAVersionGetsTheCurrentOne() throws Exception {
        assertEquals(JourneyTriggerEvent.SCHEMA_VERSION,
            decode(trigger("canon-1", "campaign-1", "n1_view", T_10_00)).getFirst().schemaVersion());
    }

    @Test
    void aTriggerWithoutAKeyFieldOrAnEventTimeIsDroppedAndCountedAndTheRestPassOn() throws Exception {
        List<JourneyTriggerEvent> passed = new ArrayList<>();
        passed.addAll(decode(trigger("canon-1", "campaign-1", "n1_view", T_10_00)));
        passed.addAll(decode(trigger(null, "campaign-1", "n1_view", T_10_00)));
        passed.addAll(decode(trigger("canon-1", null, "n1_view", T_10_00)));
        passed.addAll(decode(trigger("canon-1", "campaign-1", null, T_10_00)));
        passed.addAll(decode(trigger("canon-1", "campaign-1", "n1_view", null)));

        assertAll(
            () -> assertEquals(List.of("canon-1/campaign-1/n1_view@" + T_10_00),
                passed
                    .stream()
                    .map(trigger -> trigger.canonId() + "/" + trigger.campaignId() + "/" + trigger.nodeId() + "@"
                        + trigger.eventTimestamp())
                    .toList()),
            () -> assertEquals(4, invalid()));
    }

    @Test
    void aRecordThatDoesNotDecodeIsDroppedAndCountedAndTheJobGoesOn() throws Exception {
        List<String> undecodable = List
            .of("{\"canon_id\":\"canon-1\",", "not json", "[1,2]", "",
                "{\"canon_id\":\"canon-1\",\"campaign_id\":\"campaign-1\",\"node_id\":\"n1_view\","
                    + "\"event_time\":\"soon\"}",
                "{\"canon_id\":\"canon-1\",\"campaign_id\":\"campaign-1\",\"node_id\":\"n1_view\","
                    + "\"event_time\":true}",
                "{\"schema_version\":\"three\",\"canon_id\":\"canon-1\",\"campaign_id\":\"campaign-1\","
                    + "\"node_id\":\"n1_view\",\"event_time\":1}");
        List<JourneyTriggerEvent> passed = new ArrayList<>();
        for (String message : undecodable) {
            passed.addAll(decode(message));
        }
        passed.addAll(decode((byte[]) null));
        passed.addAll(decode(trigger("canon-1", "campaign-1", "n1_view", T_10_00)));

        assertAll(() -> assertEquals(List.of("canon-1"), passed.stream().map(JourneyTriggerEvent::canonId).toList()),
            () -> assertEquals(undecodable.size() + 1, invalid()));
    }

    private List<JourneyTriggerEvent> decode(String message) throws Exception {
        return decode(message.getBytes(StandardCharsets.UTF_8));
    }

    private List<JourneyTriggerEvent> decode(byte[] message) throws Exception {
        return decodeVersioned(message).stream().map(VersionedTrigger::trigger).toList();
    }

    private List<VersionedTrigger> decodeVersioned(byte[] message) throws Exception {
        List<VersionedTrigger> out = new ArrayList<>();
        parser.deserialize(message, new Collector<VersionedTrigger>() {
            @Override
            public void collect(VersionedTrigger record) {
                out.add(record);
            }

            @Override
            public void close() {
            }
        });
        return out;
    }

    private long invalid() {
        Counter counter = counters.get("invalidMatchedEvents");
        return counter == null ? 0 : counter.getCount();
    }

    private static String trigger(String canonId, String campaignId, String nodeId, Long eventTime) {
        return """
            {"event_id":"event-1","canon_id":%s,"domain_userid":"domain-1","user_id":"user-1","campaign_id":%s,
             "node_id":%s,"branch":"next","event_name":"view_product","event_time":%s,"context_json":"{}"}
            """.formatted(quoted(canonId), quoted(campaignId), quoted(nodeId), eventTime);
    }

    private static String quoted(String value) {
        return value == null ? "null" : "\"" + value + "\"";
    }

    private static final class RecordingMetricGroup extends UnregisteredMetricsGroup {
        private final Map<String, Counter> counters;

        RecordingMetricGroup(Map<String, Counter> counters) {
            this.counters = counters;
        }

        @Override
        public Counter counter(String name) {
            return counter(name, new SimpleCounter());
        }

        @Override
        public <C extends Counter> C counter(String name, C counter) {
            counters.put(name, counter);
            return counter;
        }
    }
}
