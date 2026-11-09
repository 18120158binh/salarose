package com.cdp.platform.jobs.customerdecision.transforms;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.BooleanSupplier;
import java.util.stream.Collectors;

import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.runtime.checkpoint.OperatorSubtaskState;
import org.apache.flink.state.rocksdb.EmbeddedRocksDBStateBackend;
import org.apache.flink.streaming.api.watermark.Watermark;
import org.apache.flink.streaming.runtime.streamrecord.StreamRecord;
import org.apache.flink.streaming.runtime.tasks.mailbox.Mail;
import org.apache.flink.streaming.runtime.tasks.mailbox.TaskMailbox;
import org.apache.flink.streaming.util.KeyedBroadcastOperatorTestHarness;
import org.apache.flink.types.Either;
import org.apache.flink.types.Row;

import com.cdp.platform.shared.db.repositories.RecordingDatabase;
import com.cdp.platform.shared.db.repositories.UnreachableDatabase;
import com.cdp.platform.shared.db.repositories.UserMetricRepository;
import com.cdp.platform.shared.models.CustomerProfileMutationEvent;
import com.cdp.platform.shared.models.Event;
import com.cdp.platform.shared.models.MetricBucket;
import com.cdp.platform.shared.models.MetricBucket.Size;
import com.cdp.platform.shared.models.MetricSeries;
import com.cdp.platform.shared.models.SegmentCheck;
import com.cdp.platform.shared.models.db.Campaign;
import com.cdp.platform.shared.models.db.CampaignNode;
import com.cdp.platform.shared.models.db.MetricConfig;
import com.cdp.platform.shared.models.db.UserMetric;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * A state miss reads {@code user_metrics} without holding up the subtask: the
 * person whose state missed waits for the read, and everyone else goes on.
 */
class StateMissReadTest {

    private static final long DAY = 86_400_000L;
    private static final long T = 1_785_800_000_000L;
    // Longer than any read the tests let through, shorter than a held one.
    private static final Duration NOT_BLOCKED = Duration.ofSeconds(5);
    private static final MapStateDescriptor<String, MetricConfig> DEFINITIONS = new MapStateDescriptor<>(
        "metric-config-broadcast-state", String.class, MetricConfig.class);
    private static final MapStateDescriptor<String, Campaign> CAMPAIGNS = new MapStateDescriptor<>("campaigns",
        String.class, Campaign.class);
    private static final MapStateDescriptor<String, CampaignNode> NODES = new MapStateDescriptor<>("campaign-nodes",
        String.class, CampaignNode.class);

    private final List<KeyedBroadcastOperatorTestHarness<String, Either<Event, SegmentCheck>, Either<Either<MetricConfig, Row>, Either<Row, Row>>, Decision>> harnesses = new ArrayList<>();
    private final List<Runnable> releases = new ArrayList<>();

    @AfterEach
    void close() throws Exception {
        releases.forEach(Runnable::run);
        for (var harness : harnesses)
            harness.close();
    }

    @Test
    void anotherPersonsEventIsCountedWhileAReadIsHeld() throws Exception {
        RecordingDatabase database = new RecordingDatabase(stored("customer-42", "m_add_to_cart_count", 41L));
        var harness = start(database, null);
        harness.processBroadcastElement(definition("m_add_to_cart_count"), 0L);
        harness.processElement(addToCart("customer-7", "event-0", T), T);
        awaitMutations(harness, 1);

        hold(database);
        assertTimeoutPreemptively(NOT_BLOCKED, () -> {
            harness.processElement(addToCart("customer-42", "event-1", T + 1), T + 1);
            harness.processElement(addToCart("customer-7", "event-2", T + 2), T + 2);
        });

        assertEquals(List.of("event-0", "event-2"), eventIds(harness));
    }

    @Test
    void thePersonsLaterEventsWaitForTheReadAndKeepTheirOrder() throws Exception {
        RecordingDatabase database = new RecordingDatabase(stored("customer-42", "m_add_to_cart_count", 41L));
        var harness = start(database, null);
        harness.processBroadcastElement(definition("m_add_to_cart_count"), 0L);

        Runnable release = hold(database);
        assertTimeoutPreemptively(NOT_BLOCKED, () -> {
            harness.processElement(addToCart("customer-42", "event-1", T), T);
            harness.processElement(addToCart("customer-42", "event-2", T + 1), T + 1);
        });
        assertEquals(List.of(), eventIds(harness));

        release.run();
        awaitMutations(harness, 2);

        assertEquals(List.of("event-1", "event-2"), eventIds(harness));
        assertEquals(List.of(42L, 43L), mutations(harness)
            .stream()
            .map(CustomerProfileMutationEvent::behaviorVersion)
            .toList());
        assertEquals(List.of(2, 3), seriesSizes(harness));
        // One read for the behavior version and one for the series.
        assertEquals(2, database.reads());
    }

    @Test
    void aReadInFlightAtACheckpointRunsAgainAfterARestore() throws Exception {
        RecordingDatabase slow = new RecordingDatabase(stored("customer-42", "m_add_to_cart_count", 41L));
        var before = start(slow, null);
        before.processBroadcastElement(definition("m_add_to_cart_count"), 0L);
        hold(slow);
        assertTimeoutPreemptively(NOT_BLOCKED,
            () -> before.processElement(addToCart("customer-42", "event-1", T), T));
        OperatorSubtaskState checkpoint = before.snapshot(1L, 0L);

        var after = start(new RecordingDatabase(stored("customer-42", "m_add_to_cart_count", 41L)), checkpoint);
        awaitMutations(after, 1);

        assertEquals(List.of("event-1"), eventIds(after));
        assertEquals(42L, mutations(after).getFirst().behaviorVersion());
        assertEquals(List.of(2), seriesSizes(after));
    }

    @Test
    void theWatermarkWaitsForAHeldEvent() throws Exception {
        RecordingDatabase database = new RecordingDatabase();
        var harness = start(database, null);
        harness.processBroadcastElement(definition("m_add_to_cart_count"), 0L);

        Runnable release = hold(database);
        assertTimeoutPreemptively(NOT_BLOCKED, () -> {
            harness.processElement(addToCart("customer-42", "event-1", T), T);
            harness.watermark(T + 10);
        });
        assertTrue(watermarks(harness).stream().allMatch(watermark -> watermark < T),
            "Watermarks before the read returned: " + watermarks(harness));

        release.run();
        awaitMutations(harness, 1);

        assertEquals(T + 10, watermarks(harness).getLast());
    }

    @Test
    void aDefinitionAddedDuringTheReadIsReadBeforeTheEventCounts() throws Exception {
        RecordingDatabase database = new RecordingDatabase(stored("customer-42", "m_add_to_cart_count", 41L),
            stored("customer-42", "m_add_to_cart_any", 40L));
        var harness = start(database, null);
        harness.processBroadcastElement(definition("m_add_to_cart_count"), 0L);

        Runnable release = hold(database);
        assertTimeoutPreemptively(NOT_BLOCKED,
            () -> harness.processElement(addToCart("customer-42", "event-1", T), T));
        harness.processBroadcastElement(definition("m_add_to_cart_any"), 0L);
        release.run();
        awaitMutations(harness, 1);

        assertEquals(Map.of("m_add_to_cart_count", 2, "m_add_to_cart_any", 2), mutations(harness)
            .getFirst()
            .metrics()
            .stream()
            .collect(Collectors.toMap(MetricSeries::metricId, StateMissReadTest::occurrences)));
    }

    @Test
    void aFailedReadFailsTheEventAndEmitsNothing() throws Exception {
        var harness = start(new ReadingStoredMetrics(UnreachableDatabase.userMetrics()), null);
        harness.processBroadcastElement(definition("m_add_to_cart_count"), 0L);

        Throwable failure = null;
        try {
            harness.processElement(addToCart("customer-42", "event-1", T), T);
            awaitMutations(harness, 1);
        } catch (IllegalStateException expected) {
            failure = expected;
        }

        assertTrue(failure != null, "The read failed, so the event must fail");
        assertEquals(List.of(), mutations(harness));
    }

    private Runnable hold(RecordingDatabase database) {
        Runnable release = database.holdReads();
        releases.add(release);
        return release;
    }

    /**
     * Runs the operator's mail until it has emitted the mutations, as the task
     * would between records.
     */
    private static void awaitMutations(
        KeyedBroadcastOperatorTestHarness<String, Either<Event, SegmentCheck>, Either<Either<MetricConfig, Row>, Either<Row, Row>>, Decision> harness,
        int count) throws Exception {
        BooleanSupplier done = () -> mutations(harness).size() >= count;
        long deadline = System.nanoTime() + NOT_BLOCKED.toNanos();
        while (!done.getAsBoolean()) {
            Optional<Mail> mail = harness.getTaskMailbox().tryTake(TaskMailbox.MIN_PRIORITY);
            if (mail.isPresent()) {
                mail.get().run();
            } else if (System.nanoTime() > deadline) {
                fail("Expected " + count + " mutations, got " + mutations(harness).size());
            } else {
                Thread.onSpinWait();
            }
        }
    }

    private KeyedBroadcastOperatorTestHarness<String, Either<Event, SegmentCheck>, Either<Either<MetricConfig, Row>, Either<Row, Row>>, Decision> start(
        RecordingDatabase database, OperatorSubtaskState restored) throws Exception {
        return start(new ReadingStoredMetrics(database.userMetrics()), restored);
    }

    private KeyedBroadcastOperatorTestHarness<String, Either<Event, SegmentCheck>, Either<Either<MetricConfig, Row>, Either<Row, Row>>, Decision> start(
        CustomerBehaviorProcessFunction function, OperatorSubtaskState restored) throws Exception {
        var harness = new KeyedBroadcastOperatorTestHarness<>(
            new CustomerBehaviorOperator(function, DEFINITIONS, CAMPAIGNS, NODES),
            CustomerBehaviorProcessFunction::canonIdOf, Types.STRING, 128, 1, 0);
        harnesses.add(harness);
        harness.setStateBackend(new EmbeddedRocksDBStateBackend());
        if (restored != null) harness.initializeState(restored);
        harness.open();
        return harness;
    }

    private static List<CustomerProfileMutationEvent> mutations(
        KeyedBroadcastOperatorTestHarness<String, Either<Event, SegmentCheck>, Either<Either<MetricConfig, Row>, Either<Row, Row>>, Decision> harness) {
        var emitted = harness.getSideOutput(CustomerBehaviorProcessFunction.MUTATIONS);
        return emitted == null ? List.of() : emitted.stream().map(StreamRecord::getValue).toList();
    }

    private static List<String> eventIds(
        KeyedBroadcastOperatorTestHarness<String, Either<Event, SegmentCheck>, Either<Either<MetricConfig, Row>, Either<Row, Row>>, Decision> harness) {
        return mutations(harness).stream().map(CustomerProfileMutationEvent::eventId).toList();
    }

    /** The size of the add-to-cart count series in each mutation. */
    private static List<Integer> seriesSizes(
        KeyedBroadcastOperatorTestHarness<String, Either<Event, SegmentCheck>, Either<Either<MetricConfig, Row>, Either<Row, Row>>, Decision> harness) {
        return mutations(harness)
            .stream()
            .flatMap(mutation -> mutation.metrics().stream())
            .filter(series -> series.metricId().equals("m_add_to_cart_count"))
            .map(StateMissReadTest::occurrences)
            .toList();
    }

    /** How many occurrences the series counts. */
    private static int occurrences(MetricSeries series) {
        return (int) series.buckets().stream().mapToLong(MetricBucket::count).sum();
    }

    private static List<Long> watermarks(
        KeyedBroadcastOperatorTestHarness<String, Either<Event, SegmentCheck>, Either<Either<MetricConfig, Row>, Either<Row, Row>>, Decision> harness) {
        return harness
            .getOutput()
            .stream()
            .filter(Watermark.class::isInstance)
            .map(element -> ((Watermark) element).getTimestamp())
            .toList();
    }

    /** One stored occurrence a day before {@code T}. */
    private static UserMetric stored(String canonId, String metricId, long behaviorVersion) {
        MetricBucket bucket = new MetricBucket(Size.MINUTE, Size.MINUTE.startOf(T - DAY), 1, null, null, null, null,
            null, null, null);
        return new UserMetric(canonId, metricId, T - DAY, List.of(bucket), behaviorVersion);
    }

    private static Either<Either<MetricConfig, Row>, Either<Row, Row>> definition(String id) {
        return Either
            .Left(Either
                .Left(new MetricConfig(id, id, "", "add_to_cart", null, null, "COUNT", null, "PRESENCE", 30 * DAY,
                    true)));
    }

    private static Either<Event, SegmentCheck> addToCart(String canonId, String eventId, long eventTime) {
        return Either
            .Left(new Event(canonId, "d1", null, null, "add_to_cart", eventTime, null, null, null, null, "web", "{}",
                eventId));
    }

    /** Reads the stored rows through the repository. */
    private static final class ReadingStoredMetrics extends CustomerBehaviorProcessFunction {

        private static final long serialVersionUID = 1L;
        private final transient UserMetricRepository repository;

        ReadingStoredMetrics(UserMetricRepository repository) {
            super(UnreachableDatabase.CONFIG, DEFINITIONS, CAMPAIGNS, NODES, 31, 600_000L, 128, 4_096, 32_768);
            this.repository = repository;
        }

        @Override
        UserMetricRepository openMetricRepository() {
            return repository;
        }
    }
}
