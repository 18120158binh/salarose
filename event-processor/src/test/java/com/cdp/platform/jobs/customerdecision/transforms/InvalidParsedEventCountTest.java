package com.cdp.platform.jobs.customerdecision.transforms;

import java.lang.reflect.Proxy;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import org.apache.flink.api.common.functions.RuntimeContext;
import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.metrics.Counter;
import org.apache.flink.metrics.SimpleCounter;
import org.apache.flink.runtime.metrics.groups.UnregisteredMetricGroups;
import org.apache.flink.streaming.util.KeyedBroadcastOperatorTestHarness;
import org.apache.flink.types.Either;

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
 * Step 1 of the customer decision drops an event with no name, id, or time, and
 * a job metric counts each drop (DEC-KI-36, acceptance criterion 3).
 */
class InvalidParsedEventCountTest {

    private static final String COUNTER = "invalidParsedEvents";
    /**
     * The function is serialized into the operator, so its counters are kept here.
     */
    private static final Map<String, Counter> COUNTERS = new ConcurrentHashMap<>();
    private static final long T = 1_785_800_000_000L;
    private static final MapStateDescriptor<String, MetricConfig> DEFINITIONS = new MapStateDescriptor<>(
        "metric-config-broadcast-state", String.class, MetricConfig.class);
    private static final MapStateDescriptor<String, Campaign> CAMPAIGNS = new MapStateDescriptor<>("campaigns",
        String.class, Campaign.class);
    private static final MapStateDescriptor<String, CampaignNode> NODES = new MapStateDescriptor<>("campaign-nodes",
        String.class, CampaignNode.class);

    @Test
    void anEventWithNoTimestampIsDroppedAndCountedOnce() throws Exception {
        assertEquals(1, droppedOf(event("event-1", "add_to_cart", null)));
    }

    @Test
    void anEventWithNoNameIsDroppedAndCountedOnce() throws Exception {
        assertEquals(1, droppedOf(event("event-1", null, T)));
    }

    @Test
    void anEventWithNoIdIsDroppedAndCountedOnce() throws Exception {
        assertEquals(1, droppedOf(event(null, "add_to_cart", T)));
    }

    @Test
    void anEventWithABlankIdIsDroppedAndCountedOnce() throws Exception {
        assertEquals(1, droppedOf(event(" ", "add_to_cart", T)));
    }

    @Test
    void eachDroppedEventAddsOneAndAValidEventAddsNothing() throws Exception {
        assertEquals(2, droppedOf(event("event-1", "add_to_cart", null), event("event-2", "add_to_cart", T),
            event("event-3", null, T)));
    }

    @Test
    void aValidEventIsNotCounted() throws Exception {
        assertEquals(0, droppedOf(event("event-1", "add_to_cart", T)));
    }

    @Test
    void theSameBadEventDeliveredTwiceIsCountedTwice() throws Exception {
        assertEquals(2, droppedOf(event("event-1", "add_to_cart", null), event("event-1", "add_to_cart", null)));
    }

    @Test
    void anEventOverTheContextLimitIsCountedByItsOwnCounterOnly() throws Exception {
        Either<Event, SegmentCheck> huge = Either
            .Left(new Event("customer-42", "d1", null, null, "add_to_cart", T, null, null, null, null, "web",
                "{\"x\":\"" + "a".repeat(40_000) + "\"}", "event-1"));

        assertEquals(0, droppedOf(huge));
        assertEquals(1, COUNTERS.get("eventContextLimitExceeded").getCount());
    }

    @Test
    void aSegmentCheckIsNotCounted() throws Exception {
        assertEquals(0, droppedOf(Either
            .Right(new SegmentCheck(1, "event-1", "customer-42", "d1", null, null, "campaign-1", "n1",
                "add_to_cart", T))));
    }

    @SafeVarargs
    private static long droppedOf(Either<Event, SegmentCheck>... events) throws Exception {
        COUNTERS.clear();
        try (var harness = new KeyedBroadcastOperatorTestHarness<>(
            new CustomerBehaviorOperator(new Recording(), DEFINITIONS, CAMPAIGNS, NODES),
            CustomerBehaviorProcessFunction::canonIdOf, Types.STRING, 128, 1, 0)) {
            harness.open();
            for (Either<Event, SegmentCheck> event : events) {
                harness.processElement(event, T);
            }
        }
        Counter counter = COUNTERS.get(COUNTER);
        return counter == null ? 0 : counter.getCount();
    }

    private static Either<Event, SegmentCheck> event(String eventId, String eventName, Long eventTime) {
        return Either
            .Left(new Event("customer-42", "d1", null, null, eventName, eventTime, null, null, null, null, "web", "{}",
                eventId));
    }

    /**
     * The function as the job builds it, with its counters kept where the test
     * reads them.
     */
    private static final class Recording extends CustomerBehaviorProcessFunction {

        private static final long serialVersionUID = 1L;

        Recording() {
            super(UnreachableDatabase.CONFIG, DEFINITIONS, CAMPAIGNS, NODES, 31, 600_000L, 128, 4_096, 32_768);
        }

        @Override
        UserMetricRepository openMetricRepository() {
            return null;
        }

        @Override
        public RuntimeContext getRuntimeContext() {
            RuntimeContext context = super.getRuntimeContext();
            return (RuntimeContext) Proxy
                .newProxyInstance(RuntimeContext.class.getClassLoader(), new Class<?>[] {RuntimeContext.class},
                    (proxy, method, args) -> method.getName().equals("getMetricGroup")
                        ? new RecordingGroup()
                        : method.invoke(context, args));
        }
    }

    private static final class RecordingGroup
        extends
            UnregisteredMetricGroups.UnregisteredOperatorMetricGroup {
        @Override
        public Counter counter(String name) {
            Counter counter = new SimpleCounter();
            COUNTERS.put(name, counter);
            return counter;
        }
    }
}
