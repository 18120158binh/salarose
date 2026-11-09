package com.cdp.platform.jobs.customerdecision.transforms;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.runtime.checkpoint.OperatorSubtaskState;
import org.apache.flink.state.rocksdb.EmbeddedRocksDBStateBackend;
import org.apache.flink.streaming.runtime.streamrecord.StreamRecord;
import org.apache.flink.streaming.runtime.tasks.mailbox.TaskMailbox;
import org.apache.flink.streaming.util.KeyedBroadcastOperatorTestHarness;
import org.apache.flink.types.Either;
import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;

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
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * The metric update step of customer decision, run through the operator with
 * its keyed state in RocksDB and its broadcast state, for a person with no
 * stored metric rows.
 */
class CustomerBehaviorStateTest {

    private static final long DAY = 86_400_000L;
    private static final long T = 1_785_800_000_000L;
    private static final MapStateDescriptor<String, MetricConfig> DEFINITIONS = new MapStateDescriptor<>(
        "metric-config-broadcast-state", String.class, MetricConfig.class);
    private static final MapStateDescriptor<String, Campaign> CAMPAIGNS = new MapStateDescriptor<>("campaigns",
        String.class, Campaign.class);
    private static final MapStateDescriptor<String, CampaignNode> NODES = new MapStateDescriptor<>("campaign-nodes",
        String.class, CampaignNode.class);

    private final List<KeyedBroadcastOperatorTestHarness<String, Either<Event, SegmentCheck>, Either<Either<MetricConfig, Row>, Either<Row, Row>>, Decision>> harnesses = new ArrayList<>();

    @AfterEach
    void close() throws Exception {
        for (var harness : harnesses)
            harness.close();
    }

    @Test
    void aDefinitionChangeAfterARestoreKeepsTheRestoredDefinitionsCounting() throws Exception {
        var before = start(null);
        before.processBroadcastElement(definition("m_add_to_cart_count", "add_to_cart", 30 * DAY), 0L);
        before.processBroadcastElement(definition("m_view_page_count", "view_page", 30 * DAY), 0L);
        OperatorSubtaskState checkpoint = before.snapshot(1L, 0L);

        var after = start(checkpoint);
        after.processBroadcastElement(definition("m_view_page_count", "view_page", 7 * DAY), 0L);
        after.processElement(event("event-1", "add_to_cart", T), T);
        after.processElement(event("event-2", "view_page", T + 1), T + 1);

        assertEquals(List.of(List.of("m_add_to_cart_count"), List.of("m_view_page_count")), changedMetrics(after));
    }

    @Test
    void aLateEventOutsideTheRetentionPeriodIsNotCounted() throws Exception {
        var harness = start(null);
        harness.processBroadcastElement(definition("m_add_to_cart_count", "add_to_cart", 30 * DAY), 0L);
        harness.processElement(event("event-1", "add_to_cart", T), T);
        harness.processElement(event("event-2", "add_to_cart", T - 90 * DAY), T);

        assertEquals(List.of(List.of("m_add_to_cart_count")), changedMetrics(harness));
    }

    @Test
    void aLateEventAmongTheLast512AcceptedIsDroppedWhenReplayed() throws Exception {
        var harness = start(null);
        selectEveryViewPage(harness);
        for (int index = 0; index < 512; index++) {
            harness.processElement(event("event-" + index, "view_page", T + index), T);
        }
        harness.processElement(event("late", "view_page", T - DAY), T);
        harness.processElement(event("event-512", "view_page", T + 512), T);
        int accepted = harness.extractOutputValues().size();

        harness.processElement(event("late", "view_page", T - DAY), T);

        assertEquals(accepted, harness.extractOutputValues().size());
    }

    @Test
    void idsAreForgottenInTheOrderTheyWereAccepted() throws Exception {
        var harness = start(null);
        selectEveryViewPage(harness);
        for (int index = 0; index <= 512; index++) {
            harness.processElement(event("event-" + index, "view_page", T + index), T);
        }
        int accepted = harness.extractOutputValues().size();

        // event-512 pushed out event-0. Accepting event-0 again pushes out event-1.
        harness.processElement(event("event-0", "view_page", T), T);
        harness.processElement(event("event-1", "view_page", T + 1), T);

        assertEquals(accepted + 2, harness.extractOutputValues().size());
    }

    @Test
    void aFailedSeriesReadFailsTheEventInsteadOfCountingFromAnEmptySeries() throws Exception {
        var before = start(null);
        before.processBroadcastElement(definition("m_add_to_cart_count", "add_to_cart", 30 * DAY), 0L);
        before.processBroadcastElement(definition("m_view_page_count", "view_page", 30 * DAY), 0L);
        before.processElement(event("event-1", "add_to_cart", T), T);
        OperatorSubtaskState checkpoint = before.snapshot(1L, 0L);

        // The behavior version is in state, so only the read of the view_page
        // series reaches the database.
        var after = start(new WithUnreachableStoredMetrics(), checkpoint);

        after.processElement(event("event-2", "view_page", T + 1), T + 1);

        assertThrows(IllegalStateException.class, () -> completeRead(after));
        assertEquals(List.of(), mutations(after));
        assertEquals(List.of(), after.extractOutputValues());
    }

    @Test
    void aSnapshotRowThatDoesNotParseRemovesTheDefinitionItReplaces() throws Exception {
        var harness = start(null);
        apply(harness, definitionRow("{}"));
        apply(harness, definitionRow("{\"type\":\"unknown\"}"));
        harness.processElement(event("event-1", "add_to_cart", T), T);

        assertEquals(List.of(), changedMetrics(harness));
    }

    @Test
    void anEventWithoutTheAttributeOrWithAnUnreadableOneIsAnOccurrenceWithNoValue() throws Exception {
        var harness = start(null);
        harness.processBroadcastElement(valueOf("m_cart_value", "NUMBER"), 0L);
        harness.processBroadcastElement(valueOf("m_gift_wrap", "BOOLEAN"), 0L);
        harness.processElement(addToCart("event-1", "{\"value\":\"5\"}", T), T);
        harness.processElement(addToCart("event-2", "{}", T + 1), T + 1);
        harness.processElement(addToCart("event-3", "{\"value\":\"abc\"}", T + 2), T + 2);

        MetricSeries cartValue = lastSeries(harness, "m_cart_value");
        MetricSeries giftWrap = lastSeries(harness, "m_gift_wrap");
        assertEquals(3, occurrences(cartValue));
        assertEquals(Arrays.asList(5.0, 1L), sumAndValueCount(cartValue));
        assertEquals(3, occurrences(giftWrap));
        assertEquals(Arrays.asList(null, 0L), sumAndValueCount(giftWrap));
    }

    @Test
    void anOccurrenceWithNoValueSurvivesASavepoint() throws Exception {
        var before = start(null);
        before.processBroadcastElement(valueOf("m_cart_value", "NUMBER"), 0L);
        before.processElement(addToCart("event-1", "{}", T), T);
        OperatorSubtaskState savepoint = before.snapshot(1L, 0L);

        var after = start(savepoint);
        after.processElement(addToCart("event-2", "{\"value\":\"5\"}", T + 1), T + 1);

        MetricSeries cartValue = lastSeries(after, "m_cart_value");
        assertEquals(2, occurrences(cartValue));
        assertEquals(Arrays.asList(5.0, 1L), sumAndValueCount(cartValue));
    }

    @Test
    void everyEventOfAMetricCountsPastAHundred() throws Exception {
        var harness = start(null);
        harness.processBroadcastElement(definition("m_add_to_cart_count", "add_to_cart", 30 * DAY), 0L);
        int sent = 150;
        for (int index = 0; index < sent; index++) {
            harness.processElement(event("event-" + index, "add_to_cart", T + index * 1_000L), T + index * 1_000L);
        }

        assertEquals(sent, occurrences(lastSeries(harness, "m_add_to_cart_count")));
    }

    @Test
    void onlyAnEventThatChangesASeriesEmitsAMutation() throws Exception {
        var harness = start(null);
        harness.processBroadcastElement(definition("m_add_to_cart_count", "add_to_cart", 30 * DAY), 0L);
        harness.processElement(event("event-1", "view_page", T), T);
        harness.processElement(event("event-2", "add_to_cart", T + 1), T + 1);
        harness.processElement(event("event-3", "view_page", T + 2), T + 2);
        harness.processElement(event("event-4", "add_to_cart", T + 3), T + 3);

        List<CustomerProfileMutationEvent> mutations = mutations(harness);
        assertEquals(List.of("event-2", "event-4"), mutations
            .stream()
            .map(CustomerProfileMutationEvent::eventId)
            .toList());
        assertEquals(List.of(1L, 2L), mutations
            .stream()
            .map(CustomerProfileMutationEvent::behaviorVersion)
            .toList());
    }

    @Test
    void metricStateExpiresTheConfiguredNumberOfDaysAfterItsLastWrite() throws Exception {
        var harness = start(null);
        harness.processBroadcastElement(definition("m_add_to_cart_count", "add_to_cart", 60 * DAY), 0L);
        harness.setStateTtlProcessingTime(0L);
        harness.processElement(event("event-1", "add_to_cart", T), T);

        harness.setStateTtlProcessingTime(31 * DAY);
        harness.processElement(event("event-2", "add_to_cart", T + 1), T + 1);

        assertEquals(List.of(1, 1), seriesSizes(harness, "m_add_to_cart_count"));
    }

    @Test
    void metricStateIsKeptUntilTheConfiguredNumberOfDaysHasPassed() throws Exception {
        var harness = start(null);
        harness.processBroadcastElement(definition("m_add_to_cart_count", "add_to_cart", 60 * DAY), 0L);
        harness.setStateTtlProcessingTime(0L);
        harness.processElement(event("event-1", "add_to_cart", T), T);

        harness.setStateTtlProcessingTime(31 * DAY - 1);
        harness.processElement(event("event-2", "add_to_cart", T + 1), T + 1);

        assertEquals(List.of(1, 2), seriesSizes(harness, "m_add_to_cart_count"));
    }

    @Test
    void aStateMissReadsEverySeriesTheEventUpdatesInOneQuery() throws Exception {
        RecordingDatabase database = new RecordingDatabase(
            new UserMetric("customer-42", "m_add_to_cart_count", T - DAY, List.of(storedBucket(T - DAY)), 41L),
            new UserMetric("customer-42", "m_view_page_count", T - DAY, List.of(storedBucket(T - DAY)), 40L));
        var harness = start(new WithStoredMetrics(database), null);
        harness.processBroadcastElement(definition("m_add_to_cart_count", "add_to_cart", 30 * DAY), 0L);
        harness.processBroadcastElement(definition("m_add_to_cart_any", "add_to_cart", 30 * DAY), 0L);
        harness.processBroadcastElement(definition("m_add_to_cart_recent", "add_to_cart", 30 * DAY), 0L);

        harness.processElement(event("event-1", "add_to_cart", T), T);
        completeRead(harness);

        // One read for the behavior version and one for the three series.
        assertEquals(2, database.reads());
        CustomerProfileMutationEvent mutation = mutations(harness).getFirst();
        assertEquals(42L, mutation.behaviorVersion());
        assertEquals(Map.of("m_add_to_cart_count", 2, "m_add_to_cart_any", 1, "m_add_to_cart_recent", 1),
            mutation
                .metrics()
                .stream()
                .collect(Collectors
                    .toMap(MetricSeries::metricId, CustomerBehaviorStateTest::occurrences)));
    }

    private KeyedBroadcastOperatorTestHarness<String, Either<Event, SegmentCheck>, Either<Either<MetricConfig, Row>, Either<Row, Row>>, Decision> start(
        OperatorSubtaskState restored) throws Exception {
        return start(new WithoutStoredMetrics(), restored);
    }

    private KeyedBroadcastOperatorTestHarness<String, Either<Event, SegmentCheck>, Either<Either<MetricConfig, Row>, Either<Row, Row>>, Decision> start(
        CustomerBehaviorProcessFunction function, OperatorSubtaskState restored) throws Exception {
        var harness = new KeyedBroadcastOperatorTestHarness<>(
            new CustomerBehaviorOperator(function, DEFINITIONS, CAMPAIGNS, NODES),
            CustomerBehaviorProcessFunction::canonIdOf,
            Types.STRING, 128, 1, 0);
        harnesses.add(harness);
        harness.setStateBackend(new EmbeddedRocksDBStateBackend());
        if (restored != null) harness.initializeState(restored);
        harness.open();
        return harness;
    }

    /** Applies the next state miss read when it returns, as the task would. */
    private static void completeRead(
        KeyedBroadcastOperatorTestHarness<String, Either<Event, SegmentCheck>, Either<Either<MetricConfig, Row>, Either<Row, Row>>, Decision> harness)
        throws Exception {
        harness.getTaskMailbox().take(TaskMailbox.MIN_PRIORITY).run();
    }

    private static void apply(
        KeyedBroadcastOperatorTestHarness<String, Either<Event, SegmentCheck>, Either<Either<MetricConfig, Row>, Either<Row, Row>>, Decision> harness,
        Row row) throws Exception {
        harness.processBroadcastElement(Either.Left(Either.Left(MetricConfig.load(row))), 0L);
    }

    /** Makes every accepted {@code view_page} event a candidate of one rule. */
    private static void selectEveryViewPage(
        KeyedBroadcastOperatorTestHarness<String, Either<Event, SegmentCheck>, Either<Either<MetricConfig, Row>, Either<Row, Row>>, Decision> harness)
        throws Exception {
        Row campaign = Row.withNames(RowKind.INSERT);
        campaign.setField("id", "CAMP-0001");
        campaign.setField("name", "CAMP-0001");
        campaign.setField("description", null);
        campaign.setField("status", "active");
        campaign.setField("root", null);
        campaign.setField("created_user", null);
        campaign.setField("created_at", null);
        campaign.setField("updated_at", null);
        Row node = Row.withNames(RowKind.INSERT);
        node.setField("campaign_id", "CAMP-0001");
        node.setField("node_id", "node-2");
        node.setField("node_type", "check");
        node.setField("parent_node_id", "node-1");
        node.setField("parent_branch", "next");
        node.setField("trigger_json", "{\"kind\":\"event\",\"event\":\"view_page\"}");
        node.setField("conditions_json", null);
        node.setField("paths_json", null);
        node.setField("action_json", null);
        node.setField("goal_id", null);
        node.setField("graph_version", 1L);
        harness.processBroadcastElement(Either.Right(Either.Left(campaign)), 0L);
        harness.processBroadcastElement(Either.Right(Either.Right(node)), 0L);
    }

    private static List<List<String>> changedMetrics(
        KeyedBroadcastOperatorTestHarness<String, Either<Event, SegmentCheck>, Either<Either<MetricConfig, Row>, Either<Row, Row>>, Decision> harness) {
        return mutations(harness)
            .stream()
            .map(mutation -> mutation.metrics().stream().map(MetricSeries::metricId).toList())
            .toList();
    }

    private static List<CustomerProfileMutationEvent> mutations(
        KeyedBroadcastOperatorTestHarness<String, Either<Event, SegmentCheck>, Either<Either<MetricConfig, Row>, Either<Row, Row>>, Decision> harness) {
        var emitted = harness.getSideOutput(CustomerBehaviorProcessFunction.MUTATIONS);
        return emitted == null ? List.of() : emitted.stream().map(StreamRecord::getValue).toList();
    }

    /** The size of the metric's series in each mutation that changed it. */
    private static List<Integer> seriesSizes(
        KeyedBroadcastOperatorTestHarness<String, Either<Event, SegmentCheck>, Either<Either<MetricConfig, Row>, Either<Row, Row>>, Decision> harness,
        String metricId) {
        return mutations(harness)
            .stream()
            .flatMap(mutation -> mutation.metrics().stream())
            .filter(series -> series.metricId().equals(metricId))
            .map(CustomerBehaviorStateTest::occurrences)
            .toList();
    }

    /** How many occurrences the series counts. */
    private static int occurrences(MetricSeries series) {
        return (int) series.buckets().stream().mapToLong(MetricBucket::count).sum();
    }

    private static MetricBucket storedBucket(long eventTime) {
        return new MetricBucket(Size.MINUTE, Size.MINUTE.startOf(eventTime), 1, null, null, null, null, null, null,
            null);
    }

    /** The metric's series in the last mutation that changed it. */
    private static MetricSeries lastSeries(
        KeyedBroadcastOperatorTestHarness<String, Either<Event, SegmentCheck>, Either<Either<MetricConfig, Row>, Either<Row, Row>>, Decision> harness,
        String metricId) {
        MetricSeries last = null;
        for (CustomerProfileMutationEvent mutation : mutations(harness)) {
            for (MetricSeries series : mutation.metrics()) {
                if (series.metricId().equals(metricId)) last = series;
            }
        }
        return last;
    }

    /** The sum and the number of values the series holds, over all its buckets. */
    private static List<Object> sumAndValueCount(MetricSeries series) {
        Double sum = null;
        long valueCount = 0;
        for (MetricBucket bucket : series.buckets()) {
            if (bucket.sum() != null) sum = (sum == null ? 0 : sum) + bucket.sum();
            if (bucket.valueCount() != null) valueCount += bucket.valueCount();
        }
        return Arrays.asList(sum, valueCount);
    }

    /** A metric of the {@code value} attribute of {@code add_to_cart}. */
    private static Either<Either<MetricConfig, Row>, Either<Row, Row>> valueOf(String id, String valueType) {
        return Either
            .Left(Either
                .Left(new MetricConfig(id, id, "", "add_to_cart", null, null, "SUM", "value", valueType, 30 * DAY,
                    true)));
    }

    private static Either<Event, SegmentCheck> addToCart(String eventId, String eventJson, long eventTime) {
        return Either
            .Left(new Event("customer-42", "d1", null, null, "add_to_cart", eventTime, null, null, null, null, "web",
                eventJson, eventId));
    }

    private static Either<Either<MetricConfig, Row>, Either<Row, Row>> definition(String id, String eventName,
        long retentionMs) {
        return Either
            .Left(Either
                .Left(new MetricConfig(id, id, "", eventName, null, null, "COUNT", null, "PRESENCE", retentionMs,
                    true)));
    }

    private static Either<Event, SegmentCheck> event(String eventId, String eventName, long eventTime) {
        return Either
            .Left(new Event("customer-42", "d1", null, null, eventName, eventTime, null, null, null, null, "web", "{}",
                eventId));
    }

    private static Row definitionRow(String filterConditions) {
        Row row = Row.withNames(RowKind.INSERT);
        row.setField("id", "m_add_to_cart_count");
        row.setField("name", "add_to_cart_count");
        row.setField("processing_mode", "LIVE");
        row.setField("user_event_id", "add_to_cart");
        row.setField("event_name", "add_to_cart");
        row.setField("default_properties", "{}");
        row.setField("filter_conditions", filterConditions);
        row.setField("agg_operator", "COUNT");
        row.setField("agg_field", null);
        row.setField("metric_type", "EVENT_SERIES");
        row.setField("value_type", "PRESENCE");
        row.setField("retention_ms", 30 * DAY);
        row.setField("enabled", true);
        return row;
    }

    /** Reads nothing from Postgres, as for a person with no stored rows. */
    private static final class WithoutStoredMetrics extends CustomerBehaviorProcessFunction {

        private static final long serialVersionUID = 1L;

        WithoutStoredMetrics() {
            super(UnreachableDatabase.CONFIG, DEFINITIONS, CAMPAIGNS, NODES, 31, 600_000L, 128, 4_096, 32_768);
        }

        @Override
        UserMetricRepository openMetricRepository() {
            return null;
        }
    }

    /** Reads the rows of a table held in memory. */
    private static final class WithStoredMetrics extends CustomerBehaviorProcessFunction {

        private static final long serialVersionUID = 1L;
        private final transient RecordingDatabase database;

        WithStoredMetrics(RecordingDatabase database) {
            super(UnreachableDatabase.CONFIG, DEFINITIONS, CAMPAIGNS, NODES, 31, 600_000L, 128, 4_096, 32_768);
            this.database = database;
        }

        @Override
        UserMetricRepository openMetricRepository() {
            return database.userMetrics();
        }
    }

    /** Every read of the database fails, as when Postgres is down. */
    private static final class WithUnreachableStoredMetrics extends CustomerBehaviorProcessFunction {

        private static final long serialVersionUID = 1L;

        WithUnreachableStoredMetrics() {
            super(UnreachableDatabase.CONFIG, DEFINITIONS, CAMPAIGNS, NODES, 31, 600_000L, 128, 4_096, 32_768);
        }

        @Override
        UserMetricRepository openMetricRepository() {
            return UnreachableDatabase.userMetrics();
        }
    }
}
