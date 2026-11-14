package com.cdp.platform.shared.batch;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;
import java.util.Optional;
import java.util.OptionalDouble;

import com.cdp.platform.shared.batch.WalGovernor.ClusterRate;
import com.cdp.platform.shared.batch.WalGovernor.Reading;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

/** The WAL governor's rules (IMP-FR-13, IMP-FR-20, SMP-FR-10). */
class WalGovernorTest {

    private static final double MB = 1024 * 1024;
    private static final WalGovernor.Thresholds DEFAULTS = new WalGovernor.Thresholds(0.5, 2.0 / 3, 0.20, 0.25,
        Optional.of(new ClusterRate(2 * MB, 1.5 * MB)), Duration.ofSeconds(30));
    private static final Instant START = Instant.parse("2026-11-07T20:05:00Z");

    private Instant now = START;
    private int checks;

    @Test
    void writesAtOnceWhenEveryReadingIsClear() throws Exception {
        WalGovernor governor = governor(DEFAULTS, List.of(reading(0.9, 0.5, MB)));

        governor.awaitClear();

        assertEquals(List.of(), governor.pauses());
    }

    @Test
    void pausesUnderHalfTheSlotCapAndResumesOnlyAboveTwoThirds() throws Exception {
        WalGovernor governor = governor(DEFAULTS,
            List.of(reading(0.4, 0.5, MB), reading(0.6, 0.5, MB), reading(0.7, 0.5, MB)));

        governor.awaitClear();

        assertEquals(List.of(new WalGovernor.Pause(START, START.plusSeconds(60), "slot_headroom")),
            governor.pauses());
        assertEquals(60.0, governor.pausedSeconds(), 1e-9);
    }

    @Test
    void pausesForDiskWhenTheWorseShareIsUnderTwentyPercent() throws Exception {
        WalGovernor governor = governor(DEFAULTS,
            List.of(reading(0.9, 0.15, MB), reading(0.9, 0.22, MB), reading(0.9, 0.3, MB)));

        governor.awaitClear();

        assertEquals("disk_free", governor.pauses().getFirst().reason());
        assertEquals(60, governor.pausedSeconds(), 1e-9);
    }

    @Test
    void writesNothingWhileTheClusterRateIsAboveTwoMegabytesUntilItIsUnderOneAndAHalf() throws Exception {
        WalGovernor governor = governor(DEFAULTS,
            List.of(reading(0.9, 0.9, 3 * MB), reading(0.9, 0.9, 1.8 * MB), reading(0.9, 0.9, 1.4 * MB)));

        governor.awaitClear();

        assertEquals("cluster_wal_rate_high", governor.pauses().getFirst().reason());
        assertEquals(60, governor.pausedSeconds(), 1e-9);
    }

    @Test
    void anUnsetSlotCapPausesWithItsReason() throws Exception {
        WalGovernor governor = governor(DEFAULTS,
            List
                .of(new Reading(OptionalDouble.empty(), OptionalDouble.of(0.9), OptionalDouble.of(MB)),
                    reading(0.9, 0.9, MB)));

        governor.awaitClear();

        assertEquals("slot_cap_unset", governor.pauses().getFirst().reason());
    }

    @Test
    void aMissingDiskReadingPausesWithItsReason() throws Exception {
        WalGovernor governor = governor(DEFAULTS,
            List
                .of(new Reading(OptionalDouble.of(0.9), OptionalDouble.empty(), OptionalDouble.of(MB)),
                    reading(0.9, 0.9, MB)));

        governor.awaitClear();

        assertEquals("disk_reading", governor.pauses().getFirst().reason());
    }

    @Test
    void aMissingClusterRatePausesOnlyWhenTheRuleIsOn() throws Exception {
        WalGovernor withRule = governor(DEFAULTS,
            List.of(new Reading(OptionalDouble.of(0.9), OptionalDouble.of(0.9)), reading(0.9, 0.9, MB)));
        withRule.awaitClear();
        assertEquals("cluster_wal_rate", withRule.pauses().getFirst().reason());

        WalGovernor withoutRule = governor(new WalGovernor.Thresholds(0.5, 2.0 / 3, 0.2, 0.25, Duration.ofSeconds(30)),
            List.of(new Reading(OptionalDouble.of(0.9), OptionalDouble.of(0.9))));
        withoutRule.awaitClear();
        assertEquals(List.of(), withoutRule.pauses());
    }

    @Test
    void aFailedReadingPauses() throws Exception {
        Deque<Reading> queue = new ArrayDeque<>(List.of(reading(0.9, 0.9, MB)));
        boolean[] failed = {false};
        WalGovernor governor = new WalGovernor(() -> {
            if (!failed[0]) {
                failed[0] = true;
                throw new IllegalStateException("connection refused");
            }
            return queue.removeFirst();
        }, DEFAULTS, duration -> now = now.plus(duration), () -> now);

        governor.awaitClear();

        assertEquals("readings_unavailable", governor.pauses().getFirst().reason());
    }

    @Test
    void aPauseThatOutlastsTheDeadlineStopsWithItsReason() {
        Deque<Reading> missing = new ArrayDeque<>();
        WalGovernor governor = new WalGovernor(
            () -> missing.isEmpty()
                ? new Reading(OptionalDouble.of(0.9), OptionalDouble.empty(), OptionalDouble.of(MB))
                : missing.removeFirst(),
            DEFAULTS, duration -> now = now.plus(duration), () -> now);
        Instant deadline = START.plus(Duration.ofHours(23).plusMinutes(40));

        WalGovernor.DeadlineReached reached = assertThrows(WalGovernor.DeadlineReached.class,
            () -> governor.awaitClear(deadline, () -> checks++));

        assertEquals("disk_reading", reached.lastReason());
        assertEquals(deadline, now);
        assertEquals(1, governor.pauses().size());
        assertEquals(1 + Duration.ofHours(23).plusMinutes(40).toSeconds() / 30, checks);
    }

    @Test
    void aBatchAfterTheDeadlineDoesNotStart() {
        WalGovernor governor = governor(DEFAULTS, List.of());

        assertThrows(WalGovernor.DeadlineReached.class, () -> governor.awaitClear(START, () -> checks++));
        assertEquals(0, checks);
    }

    @Test
    void theCheckStopsAPause() {
        WalGovernor governor = governor(DEFAULTS, List.of(reading(0.1, 0.9, MB), reading(0.1, 0.9, MB)));

        assertThrows(IllegalStateException.class, () -> governor.awaitClear(Instant.MAX, () -> {
            if (++checks == 2) throw new IllegalStateException("lock lost");
        }));
    }

    private WalGovernor governor(WalGovernor.Thresholds thresholds, List<Reading> readings) {
        Deque<Reading> queue = new ArrayDeque<>(readings);
        return new WalGovernor(queue::removeFirst, thresholds, duration -> now = now.plus(duration), () -> now);
    }

    private static Reading reading(double slot, double disk, double clusterRate) {
        return new Reading(OptionalDouble.of(slot), OptionalDouble.of(disk), OptionalDouble.of(clusterRate));
    }
}
