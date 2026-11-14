package com.cdp.platform.jobs.customerdecision.transforms;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;

import org.apache.flink.types.Either;
import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;

import com.cdp.platform.shared.db.repositories.RecordingDatabase;
import com.cdp.platform.shared.models.Event;
import com.cdp.platform.shared.models.SegmentCheck;
import com.cdp.platform.shared.models.VersionedTrigger;
import com.cdp.platform.shared.models.db.MetricConfig;
import com.cdp.platform.shared.models.db.UserMetric;
import com.cdp.platform.shared.models.db.UserProfile;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Imported fields and relative-date operators in journey rules, run through the
 * operators of customer decision in job order (DEC-FR-40 to DEC-FR-43).
 */
class ImportedFieldDecisionTest {

    private static final String USER_ID = "0912345678";
    private static final long NOV_8 = Instant.parse("2026-11-08T10:00:00+07:00").toEpochMilli();
    private static final String SPEND_OVER_5M = """
        {"type":"profile_property","field":"orders.spend_90d","op":">=","value":5000000}""";
    private static final String HANOI = """
        {"type":"profile_property","field":"city","op":"=","value":"Hanoi"}""";
    private static final String NO_ORDER_FOR_60_DAYS = """
        {"type":"profile_property","field":"orders.last_order_at","op":"more_than_days_ago","value":60}""";
    private static final String ORDERED_IN_LAST_7_DAYS = """
        {"type":"profile_property","field":"orders.last_order_at","op":"within_last_days","value":7}""";
    private static final String NO_PURCHASE_IN_1_DAY = """
        {"type":"behavior","metric_id":"m_purchase_count","event":"purchase","measure":"INACTION","op":"=",
         "value":0,"window":{"value":1,"unit":"DAYS"}}""";

    /** The person's {@code customer_attributes} rows, by source. */
    private final Map<String, Map<String, String>> attributes = new HashMap<>();
    /** Each lookup, as the columns and the sources it read. */
    private final List<String> lookups = new CopyOnWriteArrayList<>();
    private final List<UserMetric> storedRows = new CopyOnWriteArrayList<>();
    private DecisionPipeline pipeline;

    @BeforeEach
    void start() throws Exception {
        pipeline = new DecisionPipeline(new RecordingDatabase(storedRows).userMetrics(), new SeededProfiles());
        pipeline
            .definition(new MetricConfig("m_purchase_count", "m_purchase_count", "", "purchase", null, null,
                "COUNT", null, "PRESENCE", 30L * 86_400_000, true));
        pipeline.rules(Either.Left(activeCampaign()));
    }

    @AfterEach
    void close() throws Exception {
        pipeline.close();
    }

    @Test
    void anImportedFieldPassesWithASeededRowAndFailsWithoutIt() throws Exception {
        pipeline.rules(Either.Right(checkNode("node-2", SPEND_OVER_5M)));

        assertEquals(List.of(), process(view("view-1", NOV_8)));

        attributes.put("orders", Map.of("spend_90d", "12990000"));
        assertEquals(List.of("node-2:yes"), process(view("view-2", NOV_8)));
    }

    @Test
    void aRowWithoutTheKeyFails() throws Exception {
        pipeline.rules(Either.Right(checkNode("node-2", SPEND_OVER_5M)));
        attributes.put("orders", Map.of("order_count", "4"));

        assertEquals(List.of(), process(view("view-1", NOV_8)));
    }

    @Test
    void aBuiltInAndAnImportedFieldAreReadInOneLookup() throws Exception {
        pipeline.rules(Either.Right(checkNodeWithGroups("node-2", "[" + HANOI + "]", "[" + SPEND_OVER_5M + "]")));
        attributes.put("orders", Map.of("spend_90d", "12990000"));

        assertEquals(List.of("node-2:yes"), process(view("view-1", NOV_8)));
        assertEquals(List.of("columns=[city] sources=[orders]"), lookups);
    }

    @Test
    void aRuleWithoutAnImportedFieldReadsNoSource() throws Exception {
        pipeline.rules(Either.Right(checkNode("node-2", HANOI)));

        assertEquals(List.of("node-2:yes"), process(view("view-1", NOV_8)));
        assertEquals(List.of("columns=[city] sources=[]"), lookups);
    }

    @Test
    void moreThanDaysAgoIsJudgedAgainstTheEventsTimeOnReplayToo() throws Exception {
        pipeline.rules(Either.Right(checkNode("node-2", NO_ORDER_FOR_60_DAYS)));
        attributes.put("orders", Map.of("last_order_at", "2026-09-01T10:00:00+07:00"));

        assertEquals(List.of("node-2:yes"), process(view("view-1", NOV_8)));
        // A replay a week later carries the same event time, so it passes again.
        assertEquals(List.of("node-2:yes"), process(view("view-1-replay", NOV_8)));
        long october20 = Instant.parse("2026-10-20T10:00:00+07:00").toEpochMilli();
        assertEquals(List.of(), process(view("view-2", october20)));
    }

    @Test
    void withinLastDaysIsJudgedAgainstASegmentChecksEventTime() throws Exception {
        pipeline.rules(Either.Right(conditionSplit("node-3", ORDERED_IN_LAST_7_DAYS)));
        attributes.put("orders", Map.of("last_order_at", "2026-11-05T10:00:00+07:00"));

        assertEquals(List.of("node-3:yes"), process(segmentCheck("check-1", NOV_8)));
        long november20 = Instant.parse("2026-11-20T10:00:00+07:00").toEpochMilli();
        assertEquals(List.of(), process(segmentCheck("check-2", november20)));
    }

    @Test
    void aRelativeDateOnAValueThatIsNotADatetimeFails() throws Exception {
        pipeline.rules(Either.Right(checkNode("node-2", NO_ORDER_FOR_60_DAYS)));
        attributes.put("orders", Map.of("last_order_at", "60"));

        assertEquals(List.of(), process(view("view-1", NOV_8)));
    }

    @Test
    void aRuleWithARelativeDateOfZeroDaysIsSkippedWhenItLoads() throws Exception {
        pipeline
            .rules(Either
                .Right(checkNode("node-2", ORDERED_IN_LAST_7_DAYS.replace("\"value\":7", "\"value\":0"))));
        attributes.put("orders", Map.of("last_order_at", "2026-11-08T09:00:00+07:00"));

        assertEquals(List.of(), process(view("view-1", NOV_8)));
        assertEquals(List.of(), lookups);
    }

    private List<String> process(Event event) throws Exception {
        return pipeline.process(event).stream().map(ImportedFieldDecisionTest::fired).sorted().toList();
    }

    private List<String> process(SegmentCheck check) throws Exception {
        return pipeline
            .process(Either.Right(check), check.eventTimestamp())
            .stream()
            .map(ImportedFieldDecisionTest::fired)
            .sorted()
            .toList();
    }

    private static String fired(VersionedTrigger trigger) {
        return trigger.trigger().nodeId() + ":" + trigger.trigger().branch();
    }

    private static Event view(String eventId, long eventTime) {
        return new Event("customer-42", "d1", null, USER_ID, "view_page", eventTime, null, null, null, null, "web",
            "{}", eventId);
    }

    private static SegmentCheck segmentCheck(String eventId, long eventTime) {
        return new SegmentCheck(SegmentCheck.SCHEMA_VERSION, eventId, "customer-42", "d1", null, USER_ID,
            "CAMP-0001", "node-3", "view_page", eventTime);
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

    private static Row checkNode(String nodeId, String condition) {
        return checkNodeWithGroups(nodeId, "[" + condition + "]");
    }

    /**
     * A check node on {@code view_page} whose conditions are the groups given,
     * each a JSON array of conditions.
     */
    private static Row checkNodeWithGroups(String nodeId, String... groups) {
        Row row = Row.withNames(RowKind.INSERT);
        row.setField("campaign_id", "CAMP-0001");
        row.setField("node_id", nodeId);
        row.setField("node_type", "check");
        row.setField("parent_node_id", "node-1");
        row.setField("parent_branch", "next");
        row.setField("trigger_json", "{\"kind\":\"event\",\"event\":\"view_page\"}");
        List<String> parsed = new ArrayList<>();
        for (String group : groups)
            parsed.add("{\"conditions\":" + group + "}");
        row.setField("conditions_json", "{\"groups\":[" + String.join(",", parsed) + "]}");
        row.setField("paths_json", null);
        row.setField("action_json", null);
        row.setField("goal_id", null);
        row.setField("graph_version", 1L);
        return row;
    }

    /**
     * A condition split that a segment check evaluates, with no trigger. It holds
     * a behavior condition too, since a condition split needs a metric.
     */
    private static Row conditionSplit(String nodeId, String condition) {
        Row row = checkNodeWithGroups(nodeId, "[" + condition + "]", "[" + NO_PURCHASE_IN_1_DAY + "]");
        row.setField("node_type", "segment");
        row.setField("trigger_json", null);
        return row;
    }

    /**
     * Finds a profile in Hanoi for {@link #USER_ID}, with the seeded
     * {@code customer_attributes} rows of the sources asked for, and records the
     * lookup.
     */
    private final class SeededProfiles implements ProfileLookupFunction.ProfileStore {

        @Override
        public CompletableFuture<UserProfile> find(String userId, String canonId, Set<String> columns,
            Set<String> sources) {
            lookups.add("columns=" + new TreeSet<>(columns) + " sources=" + new TreeSet<>(sources));
            Map<String, String> imported = new HashMap<>();
            if (USER_ID.equals(userId)) {
                sources
                    .forEach(source -> attributes
                        .getOrDefault(source, Map.of())
                        .forEach((name, value) -> imported.put(source + "." + name, value)));
            }
            UserProfile profile = new UserProfile(null, null, null, null, null, null, null, null, null, null,
                columns.contains("city") ? "Hanoi" : null, null, null, null, null);
            return CompletableFuture.completedFuture(profile.withImported(imported));
        }

        @Override
        public void close() {
        }
    }
}
