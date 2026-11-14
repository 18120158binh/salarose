package com.cdp.platform.jobs.segmentpass;

import java.time.Duration;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;
import java.util.OptionalDouble;

import com.cdp.platform.jobs.segmentpass.WalGovernor.Reading;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

/** Pausing under the metric pass's WAL and disk thresholds (SMP-FR-10). */
class WalGovernorTest {

    private static final WalGovernor.Thresholds DEFAULTS = new WalGovernor.Thresholds(0.5, 2.0 / 3, 0.20, 0.25,
        Duration.ofSeconds(30));

    private long nanos;

    @Test
    void writesAtOnceWhenBothLimitsAreClear() throws Exception {
        WalGovernor governor = governor(List.of(reading(0.9, 0.5)));

        governor.awaitClear();

        assertEquals(0, governor.pauses());
    }

    @Test
    void pausesUnderHalfTheSlotCapAndResumesOnlyAboveTwoThirds() throws Exception {
        WalGovernor governor = governor(List.of(reading(0.4, 0.5), reading(0.6, 0.5), reading(0.7, 0.5)));

        governor.awaitClear();

        assertEquals(1, governor.pauses());
        assertEquals(60.0, governor.pausedSeconds(), 1e-9);
    }

    @Test
    void pausesUnderTwentyPercentFreeDiskAndResumesAboveTwentyFive() throws Exception {
        WalGovernor governor = governor(List.of(reading(0.9, 0.1), reading(0.9, 0.22), reading(0.9, 0.3)));

        governor.awaitClear();

        assertEquals(1, governor.pauses());
    }

    @Test
    void aMissingReadingPauses() throws Exception {
        WalGovernor governor = governor(List
            .of(new Reading(OptionalDouble.of(0.9), OptionalDouble.empty()),
                reading(0.9, 0.9)));

        governor.awaitClear();

        assertEquals(1, governor.pauses());
    }

    private WalGovernor governor(List<Reading> readings) {
        Deque<Reading> queue = new ArrayDeque<>(readings);
        return new WalGovernor(queue::removeFirst, DEFAULTS, duration -> nanos += duration.toNanos(), () -> nanos);
    }

    private static Reading reading(double slot, double disk) {
        return new Reading(OptionalDouble.of(slot), OptionalDouble.of(disk));
    }
}
