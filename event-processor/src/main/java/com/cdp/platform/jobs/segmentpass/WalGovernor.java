package com.cdp.platform.jobs.segmentpass;

import java.time.Duration;
import java.util.Optional;
import java.util.OptionalDouble;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Pauses the pass's writes while free replication-slot WAL or free disk is low
 * (SMP-FR-10), with the thresholds of the data-import metric pass's governor:
 * pause while any slot's {@code safe_wal_size} is under the pause share of
 * {@code max_slot_wal_keep_size}, or while the worse free disk share is under
 * its pause share. Resume once both are above their resume shares. A missing
 * reading, an unset slot cap included, pauses.
 */
final class WalGovernor {

    private static final Logger LOG = LoggerFactory.getLogger(WalGovernor.class);

    /** One reading of both limits. A missing share is empty. */
    record Reading(OptionalDouble slotShare, OptionalDouble diskFreeShare) {
    }

    /** Takes a reading. */
    interface Readings {
        Reading read() throws Exception;
    }

    /** Sleeps between readings, so tests can count instead of wait. */
    interface Sleeper {
        void sleep(Duration duration) throws InterruptedException;
    }

    /** The thresholds, as shares of the slot cap and of the disk. */
    record Thresholds(double slotPause, double slotResume, double diskPause, double diskResume, Duration poll) {

        Thresholds {
            if (!(slotPause > 0 && slotPause <= slotResume && slotResume <= 1)
                || !(diskPause > 0 && diskPause <= diskResume && diskResume <= 1)) {
                throw new IllegalArgumentException("Governor thresholds must satisfy 0 < pause <= resume <= 1");
            }
            if (poll.isNegative() || poll.isZero()) throw new IllegalArgumentException("Poll must be positive");
        }
    }

    private final Readings readings;
    private final Thresholds thresholds;
    private final Sleeper sleeper;
    private final PassClock clock;
    private int pauses;
    private double pausedSeconds;

    WalGovernor(Readings readings, Thresholds thresholds, Sleeper sleeper, PassClock clock) {
        this.readings = readings;
        this.thresholds = thresholds;
        this.sleeper = sleeper;
        this.clock = clock;
    }

    /**
     * Returns once writing may go on: at once when neither limit is under its
     * pause threshold, else after both are above their resume thresholds.
     */
    void awaitClear() throws InterruptedException {
        Optional<String> reason = pauseReason(read(), thresholds.slotPause(), thresholds.diskPause(), false);
        if (reason.isEmpty()) return;
        long start = clock.nanoTime();
        pauses++;
        LOG.info("Pausing segment membership writes: {}", reason.get());
        while (reason.isPresent()) {
            sleeper.sleep(thresholds.poll());
            reason = pauseReason(read(), thresholds.slotResume(), thresholds.diskResume(), true);
        }
        double seconds = (clock.nanoTime() - start) / 1e9;
        pausedSeconds += seconds;
        LOG.info("Resuming segment membership writes after {} s", seconds);
    }

    int pauses() {
        return pauses;
    }

    double pausedSeconds() {
        return pausedSeconds;
    }

    private Reading read() {
        try {
            return readings.read();
        } catch (Exception failure) {
            LOG.warn("Cannot read the governor's limits, so they count as missing", failure);
            return new Reading(OptionalDouble.empty(), OptionalDouble.empty());
        }
    }

    // A pause starts under the pause threshold. While paused, it lasts until the
    // share is above the resume threshold.
    private static Optional<String> pauseReason(Reading reading, double slotLimit, double diskLimit, boolean paused) {
        if (reading.slotShare().isEmpty()) return Optional.of("slot_reading_missing");
        if (reading.diskFreeShare().isEmpty()) return Optional.of("disk_reading_missing");
        if (low(reading.slotShare().getAsDouble(), slotLimit, paused)) return Optional.of("slot_headroom_low");
        if (low(reading.diskFreeShare().getAsDouble(), diskLimit, paused)) return Optional.of("disk_free_low");
        return Optional.empty();
    }

    private static boolean low(double share, double limit, boolean paused) {
        return paused ? !(share > limit) : !(share >= limit);
    }

    /** Monotonic time, so tests can move it. */
    interface PassClock {
        long nanoTime();
    }
}
