package com.cdp.platform.jobs.customerdecision.transforms;

import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;

import org.apache.flink.types.Either;
import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;

import com.cdp.platform.shared.db.repositories.RecordingDatabase;
import com.cdp.platform.shared.models.Event;
import com.cdp.platform.shared.models.MetricSeries;
import com.cdp.platform.shared.models.SegmentCheck;
import com.cdp.platform.shared.models.VersionedTrigger;
import com.cdp.platform.shared.models.db.MetricConfig;
import com.cdp.platform.shared.models.db.UserMetric;
import com.cdp.platform.shared.models.db.UserProfile;
import com.cdp.platform.shared.models.node.And;
import com.cdp.platform.shared.models.node.Comparison;
import com.cdp.platform.shared.models.node.MetricFunction;
import com.cdp.platform.shared.models.node.Or;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * {@code segment_membership} conditions, run through the operators of customer
 * decision in job order by a {@link DecisionPipeline}. Each one evaluates the
 * segment's current row in {@code segments} at that moment (DEC-FR-30), and a
 * segment's behavior condition counts only the events that pass its filters
 * (DEC-FR-36).
 */
class SegmentMembershipConditionTest {

    private static final long HOUR = 3_600_000L;
    private static final long DAY = 24 * HOUR;
    private static final long T = 1_785_800_000_000L;
    private static final String HANOI_CART_BUILDERS = "SEG-3f9a0c1d7e2b4a65";
    private static final String BIG_CART = "SEG-00000000000000b1";
    private static final String CITY_IN_HANOI = """
        {"type":"profile_property","field":"city","op":"IN","value":["Hanoi"]}""";
    private static final String CITY_IN_DA_NANG = """
        {"type":"profile_property","field":"city","op":"IN","value":["Da Nang"]}""";
    private static final String ADD_TO_CART_3_TIMES_IN_7_DAYS = """
        {"type":"behavior","metric_id":"m_add_to_cart_count","event":"add_to_cart","measure":"COUNT","op":">=",
         "value":3,"window":{"value":7,"unit":"DAYS"}}""";
    private static final String ADD_TO_CART_OVER_500000_IN_7_DAYS = """
        {"type":"behavior","metric_id":"m_cart_over_500000","event":"add_to_cart","measure":"COUNT","op":">=",
         "value":1,"window":{"value":7,"unit":"DAYS"},"filters":{"groups":[{"conditions":[
         {"type":"event_property","field":"product.price","op":">","value":500000}]}]}}""";

    /** Each profile lookup, as the columns it read. */
    private final List<String> profileLookups = new CopyOnWriteArrayList<>();
    /** The person's rows in {@code user_metrics}. */
    private final List<UserMetric> storedRows = new CopyOnWriteArrayList<>();
    private String city = "Hanoi";
    private DecisionPipeline pipeline;

    @BeforeEach
    void start() throws Exception {
        pipeline = new DecisionPipeline(new RecordingDatabase(storedRows).userMetrics(), new CityProfiles());
        pipeline.definition(countOf("m_add_to_cart_count", null));
        pipeline
            .definition(new MetricConfig("m_purchase_count", "m_purchase_count", "", "purchase", null, null,
                "COUNT", null, "PRESENCE", 30 * DAY, true));
        pipeline
            .definition(countOf("m_cart_over_500000",
                new And(List.of(new Or(List.of(new Comparison("product.price", ">", "500000")))))));
        pipeline.rules(Either.Left(activeCampaign()));
        pipeline.segment(segment(HANOI_CART_BUILDERS, CITY_IN_HANOI, ADD_TO_CART_3_TIMES_IN_7_DAYS));
        pipeline.segment(segment(BIG_CART, ADD_TO_CART_OVER_500000_IN_7_DAYS));
    }

    @AfterEach
    void close() throws Exception {
        pipeline.close();
    }

    @Test
    void aPersonWhoMeetsTheSegmentTakesYesAndOneWhoDoesNotTakesNothing() throws Exception {
        pipeline.rules(Either.Right(checkOnViewProduct(membership(HANOI_CART_BUILDERS, "in"))));
        addToCart(3, 300000);

        assertEquals(List.of("node-2:yes"), process(viewProduct("view-1", T)));

        city = "Da Nang";
        assertEquals(List.of(), process(viewProduct("view-2", T + 1)));
    }

    @Test
    void notInPassesForAPersonOutsideTheSegmentAndFailsForAMember() throws Exception {
        pipeline.rules(Either.Right(checkOnViewProduct(membership(HANOI_CART_BUILDERS, "not_in"))));

        assertEquals(List.of("node-2:yes"), process(viewProduct("view-1", T)));

        addToCart(3, 300000);
        assertEquals(List.of(), process(viewProduct("view-2", T + 1)));

        city = "Da Nang";
        assertEquals(List.of("node-2:yes"), process(viewProduct("view-3", T + 2)));
    }

    @Test
    void aSegmentBehaviorConditionCountsOnlyTheEventsThatPassItsFilters() throws Exception {
        pipeline.rules(Either.Right(checkOnViewProduct(membership(BIG_CART, "in"))));
        process(addToCartEvent("cart-cheap", T - HOUR, 300000));

        assertEquals(List.of(), process(viewProduct("view-1", T)));

        process(addToCartEvent("cart-dear", T + 1, 600000));
        assertEquals(List.of("node-2:yes"), process(viewProduct("view-2", T + 2)));
    }

    @Test
    void anEditedSegmentChangesTheAnswerAtTheNextEventWithoutARestart() throws Exception {
        pipeline.rules(Either.Right(checkOnViewProduct(membership(HANOI_CART_BUILDERS, "in"))));
        addToCart(3, 300000);
        city = "Da Nang";
        assertEquals(List.of(), process(viewProduct("view-1", T)));

        pipeline.segment(updated(segment(HANOI_CART_BUILDERS, CITY_IN_DA_NANG, ADD_TO_CART_3_TIMES_IN_7_DAYS)));

        assertEquals(List.of("node-2:yes"), process(viewProduct("view-2", T + 1)));
    }

    @Test
    void aMemberWhoseEventsLeftTheWindowNoLongerPasses() throws Exception {
        pipeline.rules(Either.Right(checkOnViewProduct(membership(HANOI_CART_BUILDERS, "in"))));
        for (int index = 0; index < 3; index++) {
            process(addToCartEvent("cart-" + index, T - 8 * DAY + index, 300000));
        }

        assertEquals(List.of("node-2:yes"), process(viewProduct("view-1", T - 8 * DAY + 3)));
        assertEquals(List.of(), process(viewProduct("view-2", T)));
    }

    @Test
    void aSegmentThatFailsOnItsBehaviorLooksUpNoProfile() throws Exception {
        pipeline.rules(Either.Right(checkOnViewProduct(membership(HANOI_CART_BUILDERS, "in"))));
        addToCart(2, 300000);

        assertEquals(List.of(), process(viewProduct("view-1", T)));
        assertEquals(List.of(), profileLookups);
    }

    @Test
    void theLookupReadsOnlyTheProfileFieldsTheSegmentNames() throws Exception {
        pipeline.rules(Either.Right(checkOnViewProduct(membership(HANOI_CART_BUILDERS, "in"))));
        addToCart(3, 300000);

        process(viewProduct("view-1", T));

        assertEquals(List.of("[city]"), profileLookups);
    }

    @Test
    void aMembershipOfASegmentTheJobDoesNotHoldFailsForInAndNotIn() throws Exception {
        pipeline.rules(Either.Right(checkOnViewProduct(membership("SEG-ffffffffffffffff", "in"))));
        pipeline.rules(Either.Right(checkOnViewProduct("node-3", membership("SEG-ffffffffffffffff", "not_in"))));

        assertEquals(List.of(), process(viewProduct("view-1", T)));
    }

    @Test
    void aDeletedSegmentFailsTheMembershipFromTheNextEvent() throws Exception {
        pipeline.rules(Either.Right(checkOnViewProduct(membership(HANOI_CART_BUILDERS, "in"))));
        addToCart(3, 300000);
        assertEquals(List.of("node-2:yes"), process(viewProduct("view-1", T)));

        pipeline.segment(deleted(segment(HANOI_CART_BUILDERS, CITY_IN_HANOI, ADD_TO_CART_3_TIMES_IN_7_DAYS)));

        assertEquals(List.of(), process(viewProduct("view-2", T + 1)));
    }

    @Test
    void aSegmentRowThatDoesNotParseRemovesTheSegment() throws Exception {
        pipeline.rules(Either.Right(checkOnViewProduct(membership(HANOI_CART_BUILDERS, "in"))));
        addToCart(3, 300000);

        pipeline
            .segment(updated(segment(HANOI_CART_BUILDERS,
                "{\"type\":\"segment_membership\",\"segment_id\":\"" + BIG_CART + "\",\"op\":\"in\"}")));

        assertEquals(List.of(), process(viewProduct("view-1", T)));
    }

    @Test
    void aMembershipPassesItsGroupBesideAnotherCondition() throws Exception {
        pipeline
            .rules(Either
                .Right(checkOnViewProduct(membership(BIG_CART, "in") + "," + CITY_IN_DA_NANG)));

        assertEquals(List.of(), process(viewProduct("view-1", T)));

        process(addToCartEvent("cart-dear", T + 1, 600000));
        assertEquals(List.of("node-2:yes"), process(viewProduct("view-2", T + 2)));
        assertEquals(List.of("[city]"), profileLookups);
    }

    @Test
    void aSegmentCheckAtAConditionSplitThatTestsASegmentReadsTheSegmentsSeries() throws Exception {
        pipeline.rules(Either.Right(conditionSplitInHanoiCartBuilders()));
        addToCart(2, 300000);

        assertEquals(List.of(), process(segmentCheck("check-1")));

        process(addToCartEvent("cart-3", T - 1, 300000));
        assertEquals(List.of("node-3:yes"), process(segmentCheck("check-2")));
    }

    @Test
    void aSegmentCheckReadsTheSegmentsSeriesFromUserMetricsOnAStateMiss() throws Exception {
        storedRows.add(storedAddToCarts(T - 3 * HOUR, T - 2 * HOUR, T - HOUR));
        pipeline.rules(Either.Right(conditionSplitInHanoiCartBuilders()));

        assertEquals(List.of("node-3:yes"), process(segmentCheck("check-1")));
    }

    private List<String> process(SegmentCheck check) throws Exception {
        return pipeline
            .process(Either.Right(check), check.eventTimestamp())
            .stream()
            .map(SegmentMembershipConditionTest::fired)
            .sorted()
            .toList();
    }

    private static SegmentCheck segmentCheck(String eventId) {
        return new SegmentCheck(SegmentCheck.SCHEMA_VERSION, eventId, "customer-42", "d1", null, "0912345678",
            "CAMP-0001", "node-3", "view_product", T);
    }

    private static UserMetric storedAddToCarts(long... eventTimes) {
        MetricSeries series = MetricSeries.empty("m_add_to_cart_count", null);
        for (int index = 0; index < eventTimes.length; index++) {
            series = series
                .add("stored-" + index, eventTimes[index], null, MetricFunction.COUNT, 30 * DAY, 0L);
        }
        return new UserMetric("customer-42", "m_add_to_cart_count", series.seriesClock(), series.buckets(),
            eventTimes.length);
    }

    /**
     * A condition split, with no trigger, that tests "is in Hanoi cart builders".
     * A split needs a behavior condition of its own, so it also asks for no
     * purchase today, on a metric the segment does not read. The segment's
     * series is read only because the split tests the segment.
     */
    private static Row conditionSplitInHanoiCartBuilders() {
        Row row = checkOnViewProduct("node-3", membership(HANOI_CART_BUILDERS, "in"));
        row.setField("node_type", "segment");
        row.setField("trigger_json", null);
        row
            .setField("conditions_json", """
                {"groups":[{"conditions":[%s]},{"conditions":[{"type":"behavior","metric_id":"m_purchase_count",
                 "event":"purchase","measure":"INACTION","op":"=","value":0,"window":{"value":1,"unit":"DAYS"}}]}]}"""
                .formatted(membership(HANOI_CART_BUILDERS, "in")));
        return row;
    }

    private void addToCart(int count, int price) throws Exception {
        for (int index = 0; index < count; index++) {
            process(addToCartEvent("cart-" + index, T - (count - index) * HOUR, price));
        }
    }

    private List<String> process(Event event) throws Exception {
        return pipeline.process(event).stream().map(SegmentMembershipConditionTest::fired).sorted().toList();
    }

    private static String fired(VersionedTrigger trigger) {
        return trigger.trigger().nodeId() + ":" + trigger.trigger().branch();
    }

    private static MetricConfig countOf(String id, And filters) {
        return new MetricConfig(id, id, "", "add_to_cart", null, filters, "COUNT", null, "PRESENCE", 30 * DAY,
            true);
    }

    private static Event addToCartEvent(String eventId, long eventTime, int price) {
        return new Event("customer-42", "d1", null, "0912345678", "add_to_cart", eventTime, null, null, null, null,
            "web", "{\"product\":{\"price\":" + price + "}}", eventId);
    }

    private static Event viewProduct(String eventId, long eventTime) {
        return new Event("customer-42", "d1", null, "0912345678", "view_product", eventTime, null, null, null, null,
            "web", "{}", eventId);
    }

    private static String membership(String segmentId, String op) {
        return "{\"type\":\"segment_membership\",\"segment_id\":\"%s\",\"op\":\"%s\"}".formatted(segmentId, op);
    }

    /** A segments row whose groups each hold one of the conditions given. */
    private static Row segment(String id, String... groups) {
        Row row = Row.withNames(RowKind.INSERT);
        row.setField("id", id);
        StringBuilder conditions = new StringBuilder("{\"groups\":[");
        for (int index = 0; index < groups.length; index++) {
            if (index > 0) conditions.append(',');
            conditions.append("{\"conditions\":[").append(groups[index]).append("]}");
        }
        row.setField("conditions_json", conditions.append("]}").toString());
        return row;
    }

    private static Row updated(Row row) {
        row.setKind(RowKind.UPDATE_AFTER);
        return row;
    }

    private static Row deleted(Row row) {
        row.setKind(RowKind.DELETE);
        return row;
    }

    private static Row activeCampaign() {
        Row row = Row.withNames(RowKind.INSERT);
        row.setField("id", "CAMP-0001");
        row.setField("name", "CAMP-0001");
        row.setField("description", null);
        row.setField("status", "active");
        row.setField("root", null);
        row.setField("created_user", null);
        row.setField("created_at", null);
        row.setField("updated_at", null);
        return row;
    }

    private static Row checkOnViewProduct(String conditions) {
        return checkOnViewProduct("node-2", conditions);
    }

    /** A check on {@code view_product} with one group of the conditions given. */
    private static Row checkOnViewProduct(String nodeId, String conditions) {
        Row row = Row.withNames(RowKind.INSERT);
        row.setField("campaign_id", "CAMP-0001");
        row.setField("node_id", nodeId);
        row.setField("node_type", "check");
        row.setField("parent_node_id", "node-1");
        row.setField("parent_branch", "next");
        row.setField("trigger_json", "{\"kind\":\"event\",\"event\":\"view_product\"}");
        row.setField("conditions_json", "{\"groups\":[{\"conditions\":[" + conditions + "]}]}");
        row.setField("paths_json", null);
        row.setField("action_json", null);
        row.setField("goal_id", null);
        row.setField("graph_version", 1L);
        return row;
    }

    /**
     * Finds a profile in the test's city for every person, and records the lookup.
     */
    private final class CityProfiles implements ProfileLookupFunction.ProfileStore {

        @Override
        public CompletableFuture<UserProfile> find(String userId, String canonId, Set<String> columns) {
            profileLookups.add(new TreeSet<>(columns).toString());
            return CompletableFuture
                .completedFuture(new UserProfile(null, null, null, null, null, null, null, null, null, null,
                    columns.contains("city") ? city : null, null, null, null, null));
        }

        @Override
        public void close() {
        }
    }
}
