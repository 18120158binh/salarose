package com.cdp.platform.jobs.customerdecision.transforms;

import java.util.ArrayList;
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
import com.cdp.platform.shared.models.VersionedTrigger;
import com.cdp.platform.shared.models.db.MetricConfig;
import com.cdp.platform.shared.models.db.UserMetric;
import com.cdp.platform.shared.models.db.UserProfile;
import com.cdp.platform.shared.models.node.MetricFunction;
import com.cdp.platform.shared.utils.JacksonMapper;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Metric and profile conditions of journey rules, run through the operators of
 * customer decision in job order by a {@link DecisionPipeline}.
 */
class MetricConditionDecisionTest {

    private static final long HOUR = 3_600_000L;
    private static final long DAY = 24 * HOUR;
    private static final long T = 1_785_800_000_000L;
    private static final String ADD_TO_CART_3_TIMES_IN_7_DAYS = """
        {"type":"behavior","metric_id":"m_add_to_cart_count","event":"add_to_cart","measure":"COUNT","op":">=",
         "value":3,"window":{"value":7,"unit":"DAYS"}}""";
    private static final String NO_PURCHASE_IN_1_DAY = """
        {"type":"behavior","metric_id":"m_purchase_count","event":"purchase","measure":"INACTION","op":"=",
         "value":0,"window":{"value":1,"unit":"DAYS"}}""";
    private static final String HANOI = """
        {"type":"profile_property","field":"city","op":"=","value":"Hanoi"}""";
    private static final String SAIGON = """
        {"type":"profile_property","field":"city","op":"=","value":"Saigon"}""";
    private static final String PRICE_OVER_500000 = """
        {"kind":"event","event":"add_to_cart","filters":{"groups":[{"conditions":[
         {"type":"event_property","field":"product.price","op":">","value":500000}]}]}}""";
    private static final String ADDED_TO_CART = """
        {"type":"behavior","metric_id":"m_add_to_cart_count","event":"add_to_cart","measure":"COUNT","window":{"value":30,"unit":"DAYS"},"op":">=",
         "value":1}""";
    private static final String PURCHASED_ONCE = """
        {"type":"behavior","metric_id":"m_purchase_count","event":"purchase","measure":"COUNT","window":{"value":30,"unit":"DAYS"},"op":">=",
         "value":1}""";
    private static final String PURCHASED_TWICE = """
        {"type":"behavior","metric_id":"m_purchase_count","event":"purchase","measure":"COUNT","window":{"value":30,"unit":"DAYS"},"op":">=",
         "value":2}""";

    /** The person's rows in {@code user_metrics}. */
    private final List<UserMetric> storedRows = new CopyOnWriteArrayList<>();
    private final RecordingDatabase userMetrics = new RecordingDatabase(storedRows);
    /** Each profile lookup, as the profile id and the columns it read. */
    private final List<String> profileLookups = new CopyOnWriteArrayList<>();
    private DecisionPipeline pipeline;

    @BeforeEach
    void start() throws Exception {
        pipeline = new DecisionPipeline(userMetrics.userMetrics(), new HanoiProfiles());
        pipeline.definition(countOf("m_add_to_cart_count", "add_to_cart"));
        pipeline.definition(countOf("m_purchase_count", "purchase"));
        rules(Either.Left(activeCampaign("CAMP-0001")));
    }

    @AfterEach
    void close() throws Exception {
        pipeline.close();
    }

    @Test
    void aMetricConditionSeesTheSeriesOfAnEventThatCameBefore() throws Exception {
        rules(Either.Right(checkNode("node-2", on("view_page"), ADD_TO_CART_3_TIMES_IN_7_DAYS)));
        for (int index = 0; index < 3; index++) {
            process(event("cart-" + index, "add_to_cart", T - (3 - index) * HOUR));
        }

        List<String> fired = process(event("view-1", "view_page", T));

        assertEquals(List.of("node-2:yes"), fired);
    }

    @Test
    void inactionFiresForAPersonWhoNeverDidIt() throws Exception {
        rules(Either.Right(checkNode("node-2", on("view_page"), NO_PURCHASE_IN_1_DAY)));

        List<String> fired = process(event("view-1", "view_page", T));

        assertEquals(List.of("node-2:yes"), fired);
    }

    @Test
    void inactionDoesNotFireForAPersonWhoDidItInTheWindow() throws Exception {
        rules(Either.Right(checkNode("node-2", on("view_page"), NO_PURCHASE_IN_1_DAY)));
        process(event("purchase-1", "purchase", T - HOUR));

        List<String> fired = process(event("view-1", "view_page", T));

        assertEquals(List.of(), fired);
    }

    @Test
    void inactionDoesNotFireForAPersonWhosePurchaseIsStoredOnlyInUserMetrics() throws Exception {
        rules(Either.Right(checkNode("node-2", on("view_page"), NO_PURCHASE_IN_1_DAY)));
        storedRows.add(storedRow("m_purchase_count", T - HOUR));

        List<String> fired = process(event("view-1", "view_page", T));

        assertEquals(List.of(), fired);
    }

    @Test
    void aMetricConditionSeesAStoredSeriesThatIsMissingFromState() throws Exception {
        rules(Either.Right(checkNode("node-2", on("view_page"), ADD_TO_CART_3_TIMES_IN_7_DAYS)));
        storedRows.add(storedRow("m_add_to_cart_count", T - 3 * HOUR, T - 2 * HOUR, T - HOUR));

        List<String> fired = process(event("view-1", "view_page", T));

        assertEquals(List.of("node-2:yes"), fired);
    }

    @Test
    void aFailedLoadOfASeriesMissingFromStateFailsTheEvent() throws Exception {
        rules(Either.Right(checkNode("node-2", on("view_page"), NO_PURCHASE_IN_1_DAY)));
        userMetrics.goDown();

        assertThrows(IllegalStateException.class, () -> process(event("view-1", "view_page", T)));
        assertEquals(List.of(), pipeline.mutations());
    }

    @Test
    void aRuleWithoutATriggerRunsOnlyWhenOneOfItsMetricsChanges() throws Exception {
        rules(Either.Right(segmentNode("node-2", ADDED_TO_CART)));
        rules(Either.Right(checkNode("node-3", on("view_page"), null)));

        List<String> onAddToCart = process(event("cart-1", "add_to_cart", T - DAY));
        List<String> onViewPage = process(event("view-1", "view_page", T));

        assertEquals(List.of("node-2:yes"), onAddToCart);
        assertEquals(List.of("node-3:yes"), onViewPage);
    }

    @Test
    void aRuleWithAProfileConditionSeesTheSnapshotAfterTheProfileLookup() throws Exception {
        rules(Either.Right(checkNode("node-2", on("view_page"), HANOI, ADD_TO_CART_3_TIMES_IN_7_DAYS)));
        for (int index = 0; index < 3; index++) {
            process(event("cart-" + index, "add_to_cart", T - (3 - index) * HOUR));
        }

        List<String> fired = process(event("view-1", "view_page", T));

        assertEquals(List.of("node-2:yes"), fired);
    }

    @Test
    void aFailedMetricConditionLooksUpNoProfile() throws Exception {
        rules(Either.Right(checkNode("node-2", on("view_page"), HANOI, ADD_TO_CART_3_TIMES_IN_7_DAYS)));
        for (int index = 0; index < 2; index++) {
            process(event("cart-" + index, "add_to_cart", T - (3 - index) * HOUR));
        }

        List<String> fired = process(event("view-1", "view_page", T));

        assertEquals(List.of(), fired);
        assertEquals(List.of(), profileLookups);
    }

    /**
     * The example rule of the contract: a trigger event with a price filter, and
     * the conditions Hanoi and 3 adds to cart in 7 days.
     */
    @Test
    void aTriggerEventThatFailsItsFilterLooksUpNoProfile() throws Exception {
        rules(Either.Right(checkNode("node-2", PRICE_OVER_500000, HANOI, ADD_TO_CART_3_TIMES_IN_7_DAYS)));
        for (int index = 0; index < 2; index++) {
            process(event("cart-" + index, "add_to_cart", T - (3 - index) * HOUR));
        }

        List<String> fired = process(addToCart("cart-2", T, "100"));

        assertEquals(List.of(), fired);
        assertEquals(List.of(), profileLookups);
    }

    @Test
    void aProfileLookupReadsOnlyTheFieldsThatTheWaitingConditionsCompare() throws Exception {
        rules(Either.Right(checkNode("node-2", PRICE_OVER_500000, HANOI, ADD_TO_CART_3_TIMES_IN_7_DAYS)));
        for (int index = 0; index < 2; index++) {
            process(event("cart-" + index, "add_to_cart", T - (3 - index) * HOUR));
        }

        List<String> fired = process(addToCart("cart-2", T, "12990000"));

        assertEquals(List.of("node-2:yes"), fired);
        assertEquals(List.of("null customer-42 [city]"), profileLookups);
    }

    @Test
    void aRuleWithoutAProfileConditionFiresWithoutALookup() throws Exception {
        rules(Either.Right(checkNode("node-2", on("view_page"), ADD_TO_CART_3_TIMES_IN_7_DAYS)));
        for (int index = 0; index < 3; index++) {
            process(event("cart-" + index, "add_to_cart", T - (3 - index) * HOUR));
        }

        List<String> fired = process(event("view-1", "view_page", T));

        assertEquals(List.of("node-2:yes"), fired);
        assertEquals(List.of(), profileLookups);
    }

    /**
     * DEC-FR-27. The rule changes while the event waits for its profile. The event
     * finishes with the conditions of the version it started with.
     */
    @Test
    void aRuleChangedWhileItsEventWaitsForTheProfileDecidesWithTheVersionItStartedWith() throws Exception {
        rules(Either.Right(checkNode("node-2", on("view_page"), HANOI, PURCHASED_ONCE)));
        process(event("purchase-1", "purchase", T - HOUR));

        pipeline.holdLookups();
        List<VersionedTrigger> beforeTheLookup = pipeline.process(event("view-1", "view_page", T));
        Row changed = checkNode("node-2", on("view_page"), SAIGON, PURCHASED_ONCE);
        changed.setField("graph_version", 2L);
        rules(Either.Right(changed));
        List<VersionedTrigger> afterTheLookup = pipeline.releaseLookups();

        assertEquals(List.of(), beforeTheLookup);
        assertEquals(List.of("node-2:yes@1"), afterTheLookup
            .stream()
            .map(trigger -> trigger.trigger().nodeId() + ":" + trigger.trigger().branch() + "@"
                + trigger.graphVersion())
            .toList());
    }

    /**
     * DEC-FR-28. The first event waits for a profile lookup, and the second fires a
     * rule without a profile condition before the lookup returns.
     */
    @Test
    void aPersonsTriggersLeaveInTheOrderTheirEventsArrived() throws Exception {
        rules(Either.Right(checkNode("node-2", on("view_page"), HANOI, null)));
        rules(Either.Right(checkNode("node-3", on("add_to_cart"), null)));

        pipeline.holdLookups();
        List<String> whileTheFirstWaits = new ArrayList<>(firedBy(pipeline.process(event("view-1", "view_page", T))));
        whileTheFirstWaits.addAll(firedBy(pipeline.process(event("cart-1", "add_to_cart", T + 1))));
        List<String> afterTheLookup = firedBy(pipeline.releaseLookups());

        assertEquals(List.of(), whileTheFirstWaits);
        assertEquals(List.of("node-2:yes", "node-3:yes"), afterTheLookup);
    }

    @Test
    void anotherPersonsTriggersDoNotWaitForALookup() throws Exception {
        rules(Either.Right(checkNode("node-2", on("view_page"), HANOI, null)));
        rules(Either.Right(checkNode("node-3", on("add_to_cart"), null)));

        pipeline.holdLookups();
        List<String> waiting = firedBy(pipeline.process(event("view-1", "view_page", T)));
        List<String> someoneElse = firedBy(pipeline
            .process(new Event("customer-7", "d7", null, null, "add_to_cart", T + 1, null, null, null, null, "web",
                "{}", "cart-7")));

        assertEquals(List.of(), waiting);
        assertEquals(List.of("node-3:yes"), someoneElse);
        assertEquals(List.of("node-2:yes"), firedBy(pipeline.releaseLookups()));
    }

    @Test
    void anEventWhoseRulesHaveNoMetricConditionReadsNoneOfThePersonsSeries() throws Exception {
        rules(Either.Right(checkNode("node-2", on("view_page"), null)));
        storedRows.add(storedRow("m_add_to_cart_count", T - 2 * HOUR));
        storedRows.add(storedRow("m_purchase_count", T - HOUR));

        List<String> fired = process(event("view-1", "view_page", T));

        assertEquals(List.of("node-2:yes"), fired);
        assertEquals(List.of(), userMetrics.seriesRead());
    }

    @Test
    void anEventReadsOnlyTheSeriesThatItsCandidateRulesReference() throws Exception {
        rules(Either.Right(checkNode("node-2", on("view_page"), ADDED_TO_CART)));
        storedRows.add(storedRow("m_add_to_cart_count", T - 2 * HOUR));
        storedRows.add(storedRow("m_purchase_count", T - HOUR));

        List<String> fired = process(event("view-1", "view_page", T));

        assertEquals(List.of("node-2:yes"), fired);
        assertEquals(List.of("m_add_to_cart_count"), userMetrics.seriesRead());
    }

    /**
     * A series read for a condition stays in state, so the person's next event
     * reads nothing.
     */
    @Test
    void aSeriesReadForAConditionIsReadOnce() throws Exception {
        rules(Either.Right(checkNode("node-2", on("view_page"), ADDED_TO_CART)));
        storedRows.add(storedRow("m_add_to_cart_count", T - 2 * HOUR));

        List<String> first = process(event("view-1", "view_page", T));
        List<String> second = process(event("view-2", "view_page", T + 1));

        assertEquals(List.of("node-2:yes"), first);
        assertEquals(List.of("node-2:yes"), second);
        assertEquals(List.of("m_add_to_cart_count"), userMetrics.seriesRead());
    }

    @Test
    void aSeriesThePersonDoesNotHaveIsReadOnce() throws Exception {
        rules(Either.Right(checkNode("node-2", on("view_page"), NO_PURCHASE_IN_1_DAY)));

        List<String> first = process(event("view-1", "view_page", T));
        List<String> second = process(event("view-2", "view_page", T + 1));

        assertEquals(List.of("node-2:yes"), first);
        assertEquals(List.of("node-2:yes"), second);
        assertEquals(List.of("m_purchase_count"), userMetrics.seriesRead());
    }

    /**
     * A rule added after the person's events were counted reads them from state,
     * not from the older copy in {@code user_metrics}.
     */
    @Test
    void aRuleAddedAfterTheEventsWereCountedReadsTheirSeriesFromState() throws Exception {
        storedRows.add(storedRow("m_add_to_cart_count", T - 3 * HOUR));
        for (int index = 0; index < 3; index++) {
            process(event("cart-" + index, "add_to_cart", T - (3 - index) * HOUR));
        }
        rules(Either.Right(checkNode("node-2", on("view_page"), ADD_TO_CART_3_TIMES_IN_7_DAYS)));
        int readsBefore = userMetrics.reads();

        List<String> fired = process(event("view-1", "view_page", T));

        assertEquals(List.of("node-2:yes"), fired);
        assertEquals(readsBefore, userMetrics.reads());
    }

    @Test
    void aSegmentFiresYesWhenAnEventMakesItsMetricConditionHold() throws Exception {
        rules(Either.Right(segmentNode("node-2", PURCHASED_TWICE)));

        List<String> onFirstPurchase = process(event("purchase-1", "purchase", T - HOUR));
        List<String> onSecondPurchase = process(event("purchase-2", "purchase", T));

        assertEquals(List.of(), onFirstPurchase);
        assertEquals(List.of("node-2:yes"), onSecondPurchase);
    }

    @Test
    void aSegmentDoesNotRunOnAnEventThatChangesNoneOfItsMetrics() throws Exception {
        rules(Either.Right(segmentNode("node-2", PURCHASED_TWICE)));
        process(event("purchase-1", "purchase", T - 2 * HOUR));
        process(event("purchase-2", "purchase", T - HOUR));

        List<String> onViewPage = process(event("view-1", "view_page", T));

        assertEquals(List.of(), onViewPage);
    }

    @Test
    void aTriggerCarriesTheEventNameOfTheEventItFiredOn() throws Exception {
        rules(Either
            .Right(checkNode("node-2", """
                {"kind":"event","event":"view_cart","filters":{"groups":[{"conditions":[
                 {"type":"event_property","field":"page.url","op":"=","value":"https://shop.example/cart"}]}]}}""",
                null)));
        Event viewCart = new Event("customer-42", "d1", null, null, "view_cart", T, null, null,
            "https://shop.example/cart", null, "web", "{}", "view-1");

        List<VersionedTrigger> fired = pipeline.process(viewCart);

        assertEquals(List.of("view_cart"), fired.stream().map(trigger -> trigger.trigger().eventName()).toList());
    }

    @Test
    void aTriggerContextNamesAnEventAttributeAsTheConditionNamesIt() throws Exception {
        rules(Either.Right(checkNode("node-2", """
            {"kind":"event","event":"view_product","filters":{"groups":[{"conditions":[
             {"type":"event_property","field":"product.price","op":"=","value":10}]}]}}""", null)));
        Event priced = new Event("customer-42", "d1", null, null, "view_product", T, null, null, null, null, "web",
            "{\"product\":{\"price\":10}}", "view-1");

        List<VersionedTrigger> fired = pipeline.process(priced);

        assertEquals(List.of("node-2:yes"), firedBy(fired));
        assertEquals(List.of(JacksonMapper.readTree("{\"event.name\":\"view_product\",\"product.price\":\"10\"}")),
            fired
                .stream()
                .map(trigger -> JacksonMapper.readTree(trigger.trigger().contextJson()))
                .toList());
    }

    @Test
    void aThresholdThatIsNotANumberSkipsTheRule() throws Exception {
        rules(Either
            .Right(checkNode("node-2", on("view_page"),
                addToCartCount(">=", "\"three\"", "{\"value\":7,\"unit\":\"DAYS\"}"))));
        rules(Either
            .Right(
                checkNode("node-3", on("view_page"),
                    addToCartCount(">=", "\"3,5\"", "{\"value\":7,\"unit\":\"DAYS\"}"))));
        rules(Either
            .Right(
                checkNode("node-4", on("view_page"), addToCartCount(">=", "null", "{\"value\":7,\"unit\":\"DAYS\"}"))));

        List<String> fired = process(event("view-1", "view_page", T));

        assertEquals(List.of(), fired);
    }

    @Test
    void anOperatorThatIsNotAMetricOperatorSkipsTheRule() throws Exception {
        rules(Either
            .Right(checkNode("node-2", on("view_page"),
                addToCartCount("CONTAINS", "1", "{\"value\":30,\"unit\":\"DAYS\"}"))));
        rules(Either
            .Right(
                checkNode("node-3", on("view_page"), addToCartCount("LIKE", "1", "{\"value\":30,\"unit\":\"DAYS\"}"))));
        process(event("cart-1", "add_to_cart", T - HOUR));

        List<String> fired = process(event("view-1", "view_page", T));

        assertEquals(List.of(), fired);
    }

    @Test
    void aWindowThatIsNotPositiveSkipsTheRule() throws Exception {
        rules(Either
            .Right(checkNode("node-2", on("view_page"), addToCartCount(">=", "1", "{\"value\":0,\"unit\":\"DAYS\"}"))));
        rules(Either
            .Right(
                checkNode("node-3", on("view_page"), addToCartCount(">=", "1", "{\"value\":-7,\"unit\":\"DAYS\"}"))));
        process(event("cart-1", "add_to_cart", T - 20 * DAY));

        List<String> fired = process(event("view-1", "view_page", T));

        assertEquals(List.of(), fired);
    }

    @Test
    void aDoubleEqualsSignComparesForEquality() throws Exception {
        rules(Either
            .Right(
                checkNode("node-2", on("view_page"), addToCartCount("==", "1", "{\"value\":30,\"unit\":\"DAYS\"}"))));
        rules(Either
            .Right(
                checkNode("node-3", on("view_page"), addToCartCount("==", "0", "{\"value\":30,\"unit\":\"DAYS\"}"))));
        process(event("cart-1", "add_to_cart", T - HOUR));

        List<String> fired = process(event("view-1", "view_page", T));

        assertEquals(List.of("node-2:yes"), fired);
    }

    @Test
    void aChangedThresholdAppliesToTheNextEvent() throws Exception {
        rules(Either
            .Right(
                checkNode("node-2", on("view_page"), addToCartCount(">=", "2", "{\"value\":30,\"unit\":\"DAYS\"}"))));
        process(event("cart-1", "add_to_cart", T - HOUR));
        List<String> before = process(event("view-1", "view_page", T));

        rules(Either
            .Right(
                checkNode("node-2", on("view_page"), addToCartCount(">=", "1", "{\"value\":30,\"unit\":\"DAYS\"}"))));
        List<String> after = process(event("view-2", "view_page", T + 1));

        assertEquals(List.of(), before);
        assertEquals(List.of("node-2:yes"), after);
    }

    /**
     * DEC-FR-13. A profile and a behavior condition in one group: the behavior
     * passes the group, so no profile is looked up.
     */
    @Test
    void aGroupWhoseBehaviorConditionPassesFiresWithoutAProfileLookup() throws Exception {
        rules(Either.Right(checkNodeWithGroups("node-2", on("view_page"), "[" + SAIGON + "," + ADDED_TO_CART + "]")));
        process(event("cart-1", "add_to_cart", T - HOUR));

        List<String> fired = process(event("view-1", "view_page", T));

        assertEquals(List.of("node-2:yes"), fired);
        assertEquals(List.of(), profileLookups);
    }

    /**
     * DEC-FR-13. When the behavior condition of the group fails, the rule waits
     * for the profile and fires only when the profile condition passes.
     */
    @Test
    void aGroupWhoseBehaviorConditionFailsWaitsForTheProfile() throws Exception {
        rules(Either.Right(checkNodeWithGroups("node-2", on("view_page"), "[" + HANOI + "," + ADDED_TO_CART + "]")));
        rules(Either.Right(checkNodeWithGroups("node-3", on("view_page"), "[" + SAIGON + "," + ADDED_TO_CART + "]")));

        pipeline.holdLookups();
        List<String> beforeTheLookup = firedBy(pipeline.process(event("view-1", "view_page", T)));
        List<String> afterTheLookup = firedBy(pipeline.releaseLookups());

        assertEquals(List.of(), beforeTheLookup);
        assertEquals(List.of("node-2:yes"), afterTheLookup);
        assertEquals(List.of("null customer-42 [city]"), profileLookups);
    }

    /** Every group must pass, so a failing behavior-only group needs no profile. */
    @Test
    void aFailingBehaviorOnlyGroupDropsTheRuleWithoutAProfileLookup() throws Exception {
        rules(Either
            .Right(checkNodeWithGroups("node-2", on("view_page"), "[" + HANOI + "]", "[" + PURCHASED_ONCE + "]",
                "[" + ADDED_TO_CART + "]")));
        process(event("purchase-1", "purchase", T - HOUR));

        List<String> fired = process(event("view-1", "view_page", T));

        assertEquals(List.of(), fired);
        assertEquals(List.of(), profileLookups);
    }

    /** A multi-branch check fires every branch whose own conditions pass. */
    @Test
    void aMultiBranchCheckFiresOnlyTheBranchesWhoseConditionsPass() throws Exception {
        Row row = checkNode("node-2", on("view_page"), null);
        row.setField("paths_json", """
            {"path_type":"MultiBranchPath","branches":[
             {"key":"vip","conditions":{"groups":[{"conditions":[%s]}]}},
             {"key":"buyer","conditions":{"groups":[{"conditions":[%s]}]}},
             {"key":"in_saigon","conditions":{"groups":[{"conditions":[%s]}]}},
             {"key":"in_hanoi","conditions":{"groups":[{"conditions":[%s]}]}},
             {"key":"regular"}]}""".formatted(PURCHASED_TWICE, PURCHASED_ONCE, SAIGON, HANOI));
        rules(Either.Right(row));
        process(event("purchase-1", "purchase", T - HOUR));

        List<String> fired = process(event("view-1", "view_page", T));

        assertEquals(List.of("node-2:buyer", "node-2:in_hanoi", "node-2:regular"), fired);
    }

    /** IN takes a JSON array, so a value may hold a comma. */
    @Test
    void anInFilterMatchesAnyItemOfItsArrayIncludingOneWithAComma() throws Exception {
        rules(Either
            .Right(checkNode("node-2", """
                {"kind":"event","event":"view_product","filters":{"groups":[{"conditions":[
                 {"type":"event_property","field":"product.category","op":"IN","value":["Ao, dai","Non la"]}]}]}}""",
                null)));

        List<String> withComma = process(viewProduct("view-1", "Ao, dai"));
        List<String> otherItem = process(viewProduct("view-2", "Non la"));
        List<String> halfOfTheComma = process(viewProduct("view-3", "Ao"));

        assertEquals(List.of("node-2:yes"), withComma);
        assertEquals(List.of("node-2:yes"), otherItem);
        assertEquals(List.of(), halfOfTheComma);
    }

    private static Event viewProduct(String eventId, String category) {
        return new Event("customer-42", "d1", null, null, "view_product", T, null, null, null, null, "web",
            "{\"product\":{\"category\":\"" + category + "\"}}", eventId);
    }

    /**
     * Runs one event through the job and returns the fired node and branch pairs.
     */
    private List<String> process(Event event) throws Exception {
        return firedBy(pipeline.process(event)).stream().sorted().toList();
    }

    private static List<String> firedBy(List<VersionedTrigger> triggers) {
        return triggers.stream().map(trigger -> trigger.trigger().nodeId() + ":" + trigger.trigger().branch()).toList();
    }

    private void rules(Either<Row, Row> update) throws Exception {
        pipeline.rules(update);
    }

    private static MetricConfig countOf(String id, String eventName) {
        return new MetricConfig(id, id, "", eventName, null, null, "COUNT", null, "PRESENCE", 30 * DAY, true);
    }

    private static String addToCartCount(String op, String threshold, String window) {
        return """
            {"type":"behavior","metric_id":"m_add_to_cart_count","event":"add_to_cart","measure":"COUNT",
             "op":"%s","value":%s,"window":%s}""".formatted(op, threshold, window);
    }

    private static UserMetric storedRow(String metricId, long... eventTimes) {
        MetricSeries series = MetricSeries.empty(metricId, null);
        for (int index = 0; index < eventTimes.length; index++) {
            series = series.add(metricId + "-" + index, eventTimes[index], null, MetricFunction.COUNT, 30 * DAY, 0L);
        }
        return new UserMetric("customer-42", metricId, series.seriesClock(), series.buckets(), eventTimes.length);
    }

    private static Event addToCart(String eventId, long eventTime, String price) {
        return new Event("customer-42", "d1", null, null, "add_to_cart", eventTime, null, null, null, null, "web",
            "{\"product\":{\"price\":" + price + "}}", eventId);
    }

    private static Event event(String eventId, String eventName, long eventTime) {
        return new Event("customer-42", "d1", null, null, eventName, eventTime, null, null, null, null, "web", "{}",
            eventId);
    }

    private static Row activeCampaign(String id) {
        Row row = Row.withNames(RowKind.INSERT);
        row.setField("id", id);
        row.setField("name", id);
        row.setField("description", null);
        row.setField("status", "active");
        row.setField("root", null);
        row.setField("created_user", null);
        row.setField("created_at", null);
        row.setField("updated_at", null);
        return row;
    }

    private static String on(String eventName) {
        return "{\"kind\":\"event\",\"event\":\"%s\"}".formatted(eventName);
    }

    private static Row checkNode(String nodeId, String trigger, String behaviorCondition) {
        return checkNode(nodeId, trigger, null, behaviorCondition);
    }

    /**
     * A check node row with a trigger and two groups of conditions, both of
     * which must pass: the profile condition and the behavior condition. A null
     * condition leaves its group out.
     */
    private static Row checkNode(String nodeId, String trigger, String profileCondition,
        String behaviorCondition) {
        List<String> groups = new ArrayList<>();
        for (String condition : new String[] {profileCondition, behaviorCondition}) {
            if (condition != null) groups.add("[" + condition + "]");
        }
        return checkNodeWithGroups(nodeId, trigger, groups.toArray(String[]::new));
    }

    /**
     * A check node row whose conditions are the groups given, each a JSON array
     * of conditions.
     */
    private static Row checkNodeWithGroups(String nodeId, String trigger, String... groups) {
        Row row = Row.withNames(RowKind.INSERT);
        row.setField("campaign_id", "CAMP-0001");
        row.setField("node_id", nodeId);
        row.setField("node_type", "check");
        row.setField("parent_node_id", "node-1");
        row.setField("parent_branch", "next");
        row.setField("trigger_json", trigger);
        row.setField("conditions_json", conditions(groups));
        row.setField("paths_json", null);
        row.setField("action_json", null);
        row.setField("goal_id", null);
        row.setField("graph_version", 1L);
        return row;
    }

    private static String conditions(String... groups) {
        if (groups.length == 0) return null;
        List<String> parsed = new ArrayList<>();
        for (String group : groups)
            parsed.add("{\"conditions\":" + group + "}");
        return "{\"groups\":[" + String.join(",", parsed) + "]}";
    }

    /**
     * A segment node row as the journey builder saves it: a behavior condition and
     * no trigger.
     */
    private static Row segmentNode(String nodeId, String behaviorCondition) {
        Row row = checkNode(nodeId, null, behaviorCondition);
        row.setField("node_type", "segment");
        return row;
    }

    /**
     * Finds a profile in Hanoi for every person, without Postgres, and records the
     * lookup.
     */
    private final class HanoiProfiles implements ProfileLookupFunction.ProfileStore {

        @Override
        public CompletableFuture<UserProfile> find(String userId, String canonId, Set<String> columns) {
            profileLookups.add(userId + " " + canonId + " " + new TreeSet<>(columns));
            return CompletableFuture
                .completedFuture(new UserProfile(null, null, null, null, null, null, null, null, null, null,
                    columns.contains("city") ? "Hanoi" : null, null, null, null, null));
        }

        @Override
        public void close() {
        }
    }
}
