package com.cdp.platform.jobs.businessfanout;

import java.time.Duration;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.streaming.api.operators.KeyedProcessOperator;
import org.apache.flink.streaming.runtime.streamrecord.StreamRecord;
import org.apache.flink.streaming.util.KeyedOneInputStreamOperatorTestHarness;

import com.cdp.platform.shared.models.Event;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** The acceptance criteria of the business event fan-out contract. */
class BusinessEventFanoutTest {

    private static final long T = 1_785_800_000_000L;
    private static final long DAY = Duration.ofDays(1).toMillis();

    private static final String PRICE_DROP_INTEREST = """
        {"kind":"business_event","event":"price_drop",
         "filters":{"groups":[{"conditions":[{"type":"event_property","field":"drop_percent","op":">=","value":10}]}]},
         "audience":{"type":"interest","event":"view_product","match":"product.id","min_count":2,
                     "window":{"value":7,"unit":"DAYS"},"exclude":{"event":"purchase","match":"product.id"}}}
        """;

    private KeyedOneInputStreamOperatorTestHarness<String, IndexInput, Match> index;
    private KeyedOneInputStreamOperatorTestHarness<String, BusinessEvent, BusinessEvent> seen;
    private final List<BusinessTrigger> triggers = new ArrayList<>();
    private final Set<String> active = new HashSet<>();

    @BeforeEach
    void setUp() throws Exception {
        index = new KeyedOneInputStreamOperatorTestHarness<>(new KeyedProcessOperator<>(new IndexFunction()),
            IndexInput::indexKey, Types.STRING);
        index.open();
        seen = new KeyedOneInputStreamOperatorTestHarness<>(new KeyedProcessOperator<>(new SeenEventFilter()),
            BusinessEvent::key, Types.STRING);
        seen.open();
    }

    @AfterEach
    void tearDown() throws Exception {
        index.close();
        seen.close();
    }

    @Test
    void thePriceDropReachesOnlyTheShopperWhoViewedTwiceAndDidNotBuy() throws Exception {
        activeCampaign("CAMP-0042", PRICE_DROP_INTEREST);
        view("A", "SKU-123", T - 3 * DAY);
        view("A", "SKU-123", T - 2 * DAY);
        view("A", "SKU-123", T - DAY);
        view("B", "SKU-123", T - 3 * DAY);
        view("B", "SKU-123", T - 2 * DAY);
        personEvent("B", "purchase", "SKU-123", T - DAY);
        view("C", "SKU-123", T - DAY);

        assertEquals(List.of("A"), canonIds(post(priceDrop("bev-1", "SKU-123", 15))));
    }

    @Test
    void aPriceDropBelowTheFilterReachesNoOne() throws Exception {
        activeCampaign("CAMP-0042", PRICE_DROP_INTEREST);
        view("A", "SKU-123", T - 2 * DAY);
        view("A", "SKU-123", T - DAY);

        assertEquals(List.of(), post(priceDrop("bev-1", "SKU-123", 5)));
    }

    @Test
    void theSamePriceDropPostedTwiceReachesTheShopperOnce() throws Exception {
        activeCampaign("CAMP-0042", PRICE_DROP_INTEREST);
        view("A", "SKU-123", T - 2 * DAY);
        view("A", "SKU-123", T - DAY);

        List<Match> first = post(priceDrop("bev-1", "SKU-123", 15));
        List<Match> second = post(priceDrop("bev-1", "SKU-123", 15));

        assertEquals(List.of("A"), canonIds(first));
        assertEquals(List.of(), second);
    }

    @Test
    void viewsOfAnotherItemDoNotCount() throws Exception {
        activeCampaign("CAMP-0042", PRICE_DROP_INTEREST);
        view("A", "SKU-999", T - 2 * DAY);
        view("A", "SKU-999", T - DAY);

        assertEquals(List.of(), post(priceDrop("bev-1", "SKU-123", 15)));
    }

    @Test
    void viewsOfAnItemInTheSameCategoryDoNotCount() throws Exception {
        activeCampaign("CAMP-0042", PRICE_DROP_INTEREST);
        personEvent("A", "view_product", "{\"product\":{\"id\":\"SKU-124\",\"category\":\"shoes\"}}", T - 2 * DAY);
        personEvent("A", "view_product", "{\"product\":{\"id\":\"SKU-124\",\"category\":\"shoes\"}}", T - DAY);

        assertEquals(List.of(), post(priceDrop("bev-1", "SKU-123", 15)));
    }

    @Test
    void aSegmentAudienceReachesEveryIndexedMemberAcrossShards() throws Exception {
        activeCampaign("CAMP-7", segmentTrigger("back_in_stock", null));
        List<String> people = peopleOnShards(3, 2);
        for (String person : people) {
            enter(person, "SEG-1");
        }

        List<Match> matches = post(new BusinessEvent("bev-2", "back_in_stock", T, "SKU-123", "{}"));

        assertEquals(Set.copyOf(people), Set.copyOf(canonIds(matches)));
        assertEquals(3, matches.size());
    }

    @Test
    void aMemberWhoExitedIsNotReached() throws Exception {
        activeCampaign("CAMP-7", segmentTrigger("back_in_stock", null));
        enter("A", "SEG-1");
        enter("B", "SEG-1");
        index.processElement(new StreamRecord<>(FanoutRules.segmentChange("B", "SEG-1", false, T)));

        assertEquals(List.of("A"), canonIds(post(new BusinessEvent("bev-2", "back_in_stock", T, "SKU-1", "{}"))));
    }

    @Test
    void overTheCapTheMostRecentlyInterestedAreReachedAndTheRestCounted() throws Exception {
        activeCampaign("CAMP-0042", PRICE_DROP_INTEREST.replace("\"min_count\":2", "\"min_count\":1"));
        for (int person = 0; person < 12_000; person++) {
            view("P" + person, "SKU-123", T - DAY + person);
        }

        List<Match> matches = post(priceDrop("bev-1", "SKU-123", 15));

        assertEquals(IndexFunction.CAP, matches.size());
        Set<String> newest = new HashSet<>();
        for (int person = 2_000; person < 12_000; person++) {
            newest.add("P" + person);
        }
        assertEquals(newest, Set.copyOf(canonIds(matches)));
        assertEquals(2_000L, leftOut());
    }

    @Test
    void viewsBeforeAnyActiveCampaignUsedTheInterestDoNotCount() throws Exception {
        triggers.add(trigger("CAMP-0042", PRICE_DROP_INTEREST));
        view("A", "SKU-123", T - 2 * DAY);
        view("A", "SKU-123", T - DAY);
        active.add("CAMP-0042");

        assertEquals(List.of(), post(priceDrop("bev-1", "SKU-123", 15)));
    }

    @Test
    void twoCampaignsWithOneInterestCountEachViewOnceAndEachGetAMatch() throws Exception {
        activeCampaign("CAMP-1", PRICE_DROP_INTEREST);
        activeCampaign("CAMP-2", PRICE_DROP_INTEREST);

        assertEquals(1, rules().observations(event("A", "view_product", "SKU-123", T - DAY)).size());
        view("A", "SKU-123", T - 2 * DAY);
        view("A", "SKU-123", T - DAY);

        List<Match> matches = post(priceDrop("bev-1", "SKU-123", 15));
        assertEquals(Set.of("CAMP-1", "CAMP-2"), Set.copyOf(matches.stream().map(Match::campaignId).toList()));
        assertEquals(List.of("A", "A"), canonIds(matches));
    }

    @Test
    void aSegmentOfFiftyThousandMembersGetsEveryMatchAtOnce() throws Exception {
        activeCampaign("CAMP-7", segmentTrigger("back_in_stock", null));
        for (int person = 0; person < 50_000; person++) {
            enter("M" + person, "SEG-1");
        }

        List<Match> matches = post(new BusinessEvent("bev-2", "back_in_stock", T, "SKU-123", "{}"));

        assertEquals(50_000, matches.size());
        assertEquals(0L, leftOut());
    }

    @Test
    void aStockBelowTheThresholdReachesNoOneAndLeavesNothingToCheckLater() throws Exception {
        activeCampaign("CAMP-7", segmentTrigger("back_in_stock",
            "{\"groups\":[{\"conditions\":[{\"type\":\"event_property\",\"field\":\"quantity\",\"op\":\">=\",\"value\":5}]}]}"));
        enter("A", "SEG-1");

        List<Match> matches = post(new BusinessEvent("bev-3", "back_in_stock", T, "SKU-1", "{\"quantity\":2}"));

        assertEquals(List.of(), matches);
        assertEquals(0, index.numProcessingTimeTimers());
        assertEquals(List.of("A"), canonIds(post(new BusinessEvent("bev-4", "back_in_stock", T, "SKU-1",
            "{\"quantity\":7}"))));
    }

    @Test
    void aPausedCampaignGetsNoMatch() throws Exception {
        triggers.add(trigger("CAMP-7", segmentTrigger("back_in_stock", null)));
        enter("A", "SEG-1");

        assertEquals(List.of(), post(new BusinessEvent("bev-2", "back_in_stock", T, "SKU-1", "{}")));
    }

    @Test
    void anEntryExpiresOnceItsNewestEventIsOlderThanTheLongestWindow() throws Exception {
        activeCampaign("CAMP-0042", PRICE_DROP_INTEREST);
        index.setProcessingTime(T - DAY);
        view("A", "SKU-123", T - 2 * DAY);
        view("A", "SKU-123", T - DAY);

        index.setProcessingTime(T + 10 * DAY);

        assertEquals(List.of(), post(priceDrop("bev-1", "SKU-123", 15)));
    }

    private void activeCampaign(String campaignId, String triggerJson) {
        triggers.add(trigger(campaignId, triggerJson));
        active.add(campaignId);
    }

    private static BusinessTrigger trigger(String campaignId, String triggerJson) {
        return BusinessTrigger
            .fromRow(BusinessTriggerTest.nodeRow(campaignId, "setup_1", "setup", triggerJson))
            .orElseThrow();
    }

    private static String segmentTrigger(String event, String filters) {
        return "{\"kind\":\"business_event\",\"event\":\"" + event + "\""
            + (filters == null ? "" : ",\"filters\":" + filters)
            + ",\"audience\":{\"type\":\"segment\",\"segment_id\":\"SEG-1\"}}";
    }

    private FanoutRules rules() {
        return new FanoutRules(triggers, active);
    }

    private void view(String canonId, String item, long time) throws Exception {
        personEvent(canonId, "view_product", item, time);
    }

    private void personEvent(String canonId, String name, String itemOrJson, long time) throws Exception {
        for (IndexInput input : rules().observations(event(canonId, name, itemOrJson, time))) {
            index.processElement(new StreamRecord<>(input));
        }
    }

    private static Event event(String canonId, String name, String itemOrJson, long time) {
        String json = itemOrJson.startsWith("{") ? itemOrJson : "{\"product\":{\"id\":\"" + itemOrJson + "\"}}";
        return new Event(canonId, null, null, null, name, time, null, null, null, null, null, json, null, time);
    }

    private void enter(String canonId, String segmentId) throws Exception {
        index.processElement(new StreamRecord<>(FanoutRules.segmentChange(canonId, segmentId, true, T)));
    }

    private static BusinessEvent priceDrop(String eventId, String item, int dropPercent) {
        return new BusinessEvent(eventId, "price_drop", T, item,
            "{\"product\":{\"id\":\"" + item + "\"},\"drop_percent\":" + dropPercent + "}");
    }

    /** The matches one posted business event produces, after the seen-id check. */
    private List<Match> post(BusinessEvent event) throws Exception {
        int seenBefore = seen.extractOutputValues().size();
        seen.processElement(new StreamRecord<>(event));
        if (seen.extractOutputValues().size() == seenBefore) return List.of();
        int before = index.extractOutputValues().size();
        for (IndexInput probe : rules().probes(event)) {
            index.processElement(new StreamRecord<>(probe));
        }
        List<Match> all = index.extractOutputValues();
        return List.copyOf(all.subList(before, all.size()));
    }

    private long leftOut() {
        var side = index.getSideOutput(IndexFunction.LEFT_OUT);
        return side == null ? 0 : side.stream().mapToLong(record -> record.getValue().count()).sum();
    }

    private static List<String> canonIds(List<Match> matches) {
        return matches.stream().map(Match::canonId).toList();
    }

    /** Canon ids on exactly the given number of shards. */
    private static List<String> peopleOnShards(int people, int shards) {
        List<String> found = new ArrayList<>();
        Set<Integer> used = new HashSet<>();
        for (int candidate = 0; found.size() < people; candidate++) {
            String canonId = "person-" + candidate;
            int shard = Math.floorMod(canonId.hashCode(), FanoutRules.SEGMENT_SHARDS);
            if (used.size() < shards || used.contains(shard)) {
                used.add(shard);
                found.add(canonId);
            }
        }
        assertEquals(shards, used.size());
        return found;
    }
}
