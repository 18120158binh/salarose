package com.cdp.platform.jobs.segmentpass;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.OptionalDouble;
import java.util.Set;
import java.util.UUID;

import com.cdp.platform.jobs.segmentpass.MetricPassWait.MetricPass;
import com.cdp.platform.jobs.segmentpass.PassStore.Member;
import com.cdp.platform.shared.batch.WalGovernor;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * The nightly pass against the acceptance criteria of the segment membership
 * pass contract.
 */
class SegmentMembershipPassTest {

    private static final String BIG_SPENDERS = "SEG-8c2e51a09b7d3f46";
    private static final String HANOI_CARTS = "SEG-3f9a0c1d7e2b4a65";
    private static final String NO_CARTS = "SEG-00000000000000b1";
    private static final String KEY = "0912345678";

    private static final String SPEND = """
        {"groups":[{"conditions":[{"type":"profile_property","field":"orders.spend_90d","op":">=","value":5000000}]}]}""";
    private static final String HANOI = """
        {"type":"profile_property","field":"customers.city","op":"IN","value":["Hanoi"]}""";
    private static final String CART_AT_LEAST_ONE = """
        {"groups":[{"conditions":[%s]},{"conditions":[{"type":"behavior","metric_id":"m_cart","event":"add_to_cart",
         "measure":"COUNT","op":">=","value":1,"window":{"value":7,"unit":"DAYS"}}]}]}""".formatted(HANOI);
    private static final String CART_NONE = """
        {"groups":[{"conditions":[%s]},{"conditions":[{"type":"behavior","metric_id":"m_cart","event":"add_to_cart",
         "measure":"COUNT","op":"<=","value":0,"window":{"value":7,"unit":"DAYS"}}]}]}""".formatted(HANOI);

    private static final Instant SCHEDULED = Instant.parse("2026-11-13T20:00:00Z");
    private static final Instant NOW = Instant.parse("2026-11-13T20:21:00Z");

    private final FakePassStore store = new FakePassStore();
    private final List<WalGovernor.Reading> readings = new ArrayList<>();
    private int governorSleeps;

    @Test
    void anImportedOnlyKeyWithTheSpendRowIsAMemberWithSinceAsOf() throws Exception {
        store.segments.put(BIG_SPENDERS, SPEND);
        store.attribute(KEY, "orders", "{\"spend_90d\":7200000}");
        store.attribute("0900000000", "customers", "{\"city\":\"Hanoi\"}");

        run(NOW);

        assertEquals(Map.of(new Member(BIG_SPENDERS, KEY), NOW), store.members);
        assertEquals(1, store.runs.getFirst().totals.rowsInserted());
    }

    @Test
    void withoutTheSpendValueTheKeyIsNotAMember() throws Exception {
        store.segments.put(BIG_SPENDERS, SPEND);
        store.attribute(KEY, "orders", "{\"orders_90d\":3}");

        run(NOW);

        assertTrue(store.members.isEmpty());
    }

    @Test
    void behaviorConditionsReadAnEmptySnapshot() throws Exception {
        store.segments.put(HANOI_CARTS, CART_AT_LEAST_ONE);
        store.segments.put(NO_CARTS, CART_NONE);
        store.attribute(KEY, "customers", "{\"city\":\"Hanoi\"}");

        run(NOW);

        assertEquals(Set.of(new Member(NO_CARTS, KEY)), store.members.keySet());
    }

    @Test
    void aSecondPassWithNoChangeWritesNothingAndKeepsSince() throws Exception {
        store.segments.put(BIG_SPENDERS, SPEND);
        store.attribute(KEY, "orders", "{\"spend_90d\":7200000}");
        run(NOW);
        int writes = store.writes;

        run(NOW.plus(Duration.ofDays(1)));

        assertEquals(writes, store.writes);
        assertEquals(Map.of(new Member(BIG_SPENDERS, KEY), NOW), store.members);
        assertEquals(0, store.runs.getLast().totals.rowsInserted());
        assertEquals(0, store.runs.getLast().totals.rowsDeleted());
    }

    @Test
    void aKeyThatATrackedPersonNowHoldsLosesItsRows() throws Exception {
        store.segments.put(BIG_SPENDERS, SPEND);
        store.segments.put(NO_CARTS, CART_NONE);
        store.attribute(KEY, "orders", "{\"spend_90d\":7200000}");
        store.attribute(KEY, "customers", "{\"city\":\"Hanoi\"}");
        run(NOW);
        assertEquals(2, store.members.size());

        store.trackedUserIds.add(KEY);
        run(NOW.plus(Duration.ofDays(1)));

        assertTrue(store.members.isEmpty());
        assertEquals(2, store.runs.getLast().totals.rowsDeleted());
    }

    @Test
    void aMemberWhoLeavesAndADeletedSegmentAreDeleted() throws Exception {
        store.segments.put(BIG_SPENDERS, SPEND);
        store.segments.put(NO_CARTS, CART_NONE);
        store.attribute(KEY, "orders", "{\"spend_90d\":7200000}");
        store.attribute(KEY, "customers", "{\"city\":\"Hanoi\"}");
        run(NOW);

        store.attribute(KEY, "orders", "{\"spend_90d\":100}");
        store.segments.remove(NO_CARTS);
        run(NOW.plus(Duration.ofDays(1)));

        assertTrue(store.members.isEmpty());
    }

    @Test
    void aSegmentThatDoesNotParseKeepsItsRowsAndIsRecorded() throws Exception {
        store.segments.put(BIG_SPENDERS, SPEND);
        store.segments.put(NO_CARTS, CART_NONE);
        store.attribute(KEY, "orders", "{\"spend_90d\":7200000}");
        store.attribute(KEY, "customers", "{\"city\":\"Hanoi\"}");
        run(NOW);

        store.segments.put(NO_CARTS, "{\"groups\":[");
        store.attribute(KEY, "orders", "{\"spend_90d\":100}");
        store.attribute(KEY, "customers", "{\"city\":\"Hue\"}");
        run(NOW.plus(Duration.ofDays(1)));

        assertEquals(Map.of(new Member(NO_CARTS, KEY), NOW), store.members);
        assertEquals(List.of(NO_CARTS), store.runs.getLast().totals.skippedSegments());
    }

    @Test
    void theRunRecordCountsRowsAndPausesAndFailsACrashedRecord() throws Exception {
        store.segments.put(BIG_SPENDERS, SPEND);
        store.attribute(KEY, "orders", "{\"spend_90d\":7200000}");
        store.openRun(NOW.minus(Duration.ofDays(1)), false, Optional.empty());
        readings.add(reading(0.1, 0.9));
        readings.add(reading(0.9, 0.9));

        run(NOW);

        assertEquals("failed", store.runs.getFirst().state);
        FakePassStore.Run run = store.runs.getLast();
        assertEquals("done", run.state);
        assertEquals(1, run.totals.pauses());
        assertEquals(1, governorSleeps);
        assertEquals(1, run.totals.rowsInserted());
    }

    @Test
    void aPassThatCrashesHalfwayConvergesOnTheNextRun() throws Exception {
        store.segments.put(BIG_SPENDERS, SPEND);
        for (int index = 0; index < 5; index++) {
            store.attribute("09000000" + index, "orders", "{\"spend_90d\":7200000}");
        }
        store.failApplyAt = 2;

        assertThrows(IllegalStateException.class, () -> run(NOW, 2));
        assertEquals("failed", store.runs.getLast().state);
        assertEquals(2, store.members.size());

        store.failApplyAt = 0;
        run(NOW.plus(Duration.ofHours(1)), 2);

        assertEquals(5, store.members.size());
    }

    @Test
    void aFallbackRunNamesTheLastFinishedMetricPass() throws Exception {
        UUID yesterday = UUID.randomUUID();
        store.metricPasses.add(new MetricPass(yesterday, SCHEDULED.minus(Duration.ofDays(1)), "done"));
        store.metricPasses.add(new MetricPass(UUID.randomUUID(), SCHEDULED, "failed"));
        Instant fallback = Instant.parse("2026-11-13T22:00:00Z");

        run(fallback);

        FakePassStore.Run run = store.runs.getLast();
        assertTrue(run.fallback);
        assertEquals(Optional.of(yesterday), run.metricPassId);
    }

    @Test
    void anotherPassHoldingTheLockEndsThisOne() throws Exception {
        store.locked = true;
        assertFalse(pass(NOW, 500).run(SCHEDULED));
        assertTrue(store.runs.isEmpty());
    }

    private void run(Instant now) throws Exception {
        run(now, 500);
    }

    private void run(Instant now, int batchSize) throws Exception {
        store.locked = false;
        if (store.metricPasses.isEmpty()) {
            store.metricPasses.add(new MetricPass(UUID.randomUUID(), SCHEDULED, "done"));
        }
        pass(now, batchSize).run(SCHEDULED);
    }

    private SegmentMembershipPass pass(Instant now, int batchSize) {
        SegmentPassSettings defaults = SegmentPassSettings
            .fromVariables(Map
                .of("REPORTING_TIME_ZONE", "UTC",
                    "SEGMENT_PASS_SCHEDULE", "20:00", "SEGMENT_PASS_FALLBACK", "22:00"));
        SegmentPassSettings settings = new SegmentPassSettings(defaults.schedule(), defaults.fallback(),
            defaults.zone(), batchSize, defaults.metricPassPoll(), defaults.thresholds(), Optional.empty(),
            defaults.claimBytes());
        WalGovernor governor = new WalGovernor(
            () -> readings.isEmpty() ? reading(0.9, 0.9) : readings.removeFirst(), settings.thresholds(),
            duration -> governorSleeps++, Instant::now);
        return new SegmentMembershipPass(store, governor, settings, Clock.fixed(now, ZoneOffset.UTC), duration -> {
            throw new AssertionError("The pass must not wait here");
        });
    }

    private static WalGovernor.Reading reading(double slot, double disk) {
        return new WalGovernor.Reading(OptionalDouble.of(slot), OptionalDouble.of(disk));
    }
}
