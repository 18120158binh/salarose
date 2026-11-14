package com.cdp.platform.shared.batch;

import java.time.Duration;
import java.time.Instant;
import java.time.InstantSource;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.OptionalDouble;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Pauses a batch job's writes to the main Postgres while its WAL or disk is
 * under pressure, by the rules of the import metric pass's WAL governor
 * (IMP-FR-13), which the segment membership pass shares (SMP-FR-10). A pause
 * starts when a reading crosses its pause threshold, and lasts until every
 * reading is past its resume threshold. A missing reading pauses, with the
 * reading's name as the reason.
 */
public final class WalGovernor {

    private static final Logger LOG = LoggerFactory.getLogger(WalGovernor.class);

    /**
     * One reading. A missing value is empty. {@code slotShare} is the smallest
     * slot's {@code safe_wal_size} over {@code max_slot_wal_keep_size}, empty
     * when no cap is set.
     */
    public record Reading(OptionalDouble slotShare, OptionalDouble diskFreeShare,
        OptionalDouble clusterBytesPerSecond) {

        public Reading(OptionalDouble slotShare, OptionalDouble diskFreeShare) {
            this(slotShare, diskFreeShare, OptionalDouble.empty());
        }
    }

    /** Takes a reading. */
    public interface Readings {
        Reading read() throws Exception;
    }

    /** Sleeps between readings, so tests can count instead of wait. */
    public interface Sleeper {
        void sleep(Duration duration) throws InterruptedException;
    }

    /** Pause above {@code pause} bytes per second, resume under {@code resume}. */
    public record ClusterRate(double pause, double resume) {

        public ClusterRate {
            if (!(resume > 0 && resume <= pause)) {
                throw new IllegalArgumentException("Cluster WAL rates must satisfy 0 < resume <= pause");
            }
        }
    }

    /**
     * The thresholds, as shares of the slot cap and of the disk, and an optional
     * cluster WAL rate rule. {@code poll} must be at most a minute, so a pause
     * checks its deadline once a minute.
     */
    public record Thresholds(double slotPause, double slotResume, double diskPause, double diskResume,
        Optional<ClusterRate> clusterRate, Duration poll) {

        public Thresholds {
            if (!(slotPause > 0 && slotPause <= slotResume && slotResume <= 1)
                || !(diskPause > 0 && diskPause <= diskResume && diskResume <= 1)) {
                throw new IllegalArgumentException("Governor thresholds must satisfy 0 < pause <= resume <= 1");
            }
            if (poll.isNegative() || poll.isZero() || poll.compareTo(Duration.ofMinutes(1)) > 0) {
                throw new IllegalArgumentException("Poll must be above 0 and at most a minute");
            }
        }

        public Thresholds(double slotPause, double slotResume, double diskPause, double diskResume, Duration poll) {
            this(slotPause, slotResume, diskPause, diskResume, Optional.empty(), poll);
        }
    }

    /** One pause, as the pass's row records it. */
    public record Pause(Instant start, Instant end, String reason) {
    }

    /** The deadline passed during a pause, or before a batch. */
    public static final class DeadlineReached extends Exception {

        private final String lastReason;

        DeadlineReached(String lastReason) {
            super("the deadline passed while " + lastReason);
            this.lastReason = lastReason;
        }

        public String lastReason() {
            return lastReason;
        }
    }

    private final Readings readings;
    private final Thresholds thresholds;
    private final Sleeper sleeper;
    private final InstantSource clock;
    private final List<Pause> pauses = new ArrayList<>();
    private String lastReason = "writing";

    public WalGovernor(Readings readings, Thresholds thresholds, Sleeper sleeper, InstantSource clock) {
        this.readings = readings;
        this.thresholds = thresholds;
        this.sleeper = sleeper;
        this.clock = clock;
    }

    /** {@link #awaitClear(Instant, Runnable)} with no deadline and no check. */
    public void awaitClear() throws InterruptedException {
        try {
            awaitClear(Instant.MAX, () -> {
            });
        } catch (DeadlineReached impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    /**
     * Returns once writing may go on: at once when no reading is past its pause
     * threshold, else after every reading is past its resume threshold. Runs
     * {@code check} before each reading, so a lost lock stops the wait.
     *
     * @throws DeadlineReached
     *             when {@code deadline} passes first
     */
    public void awaitClear(Instant deadline, Runnable check) throws InterruptedException, DeadlineReached {
        if (!clock.instant().isBefore(deadline)) throw new DeadlineReached(lastReason);
        check.run();
        Optional<String> reason = pauseReason(read(), false);
        if (reason.isEmpty()) return;
        Instant start = clock.instant();
        lastReason = reason.get();
        LOG.info("Pausing writes: {}", lastReason);
        while (reason.isPresent()) {
            lastReason = reason.get();
            if (!clock.instant().isBefore(deadline)) {
                pauses.add(new Pause(start, clock.instant(), lastReason));
                throw new DeadlineReached(lastReason);
            }
            sleeper.sleep(thresholds.poll());
            check.run();
            reason = pauseReason(read(), true);
        }
        Pause pause = new Pause(start, clock.instant(), lastReason);
        pauses.add(pause);
        LOG
            .info("Resuming writes after {} s ({})", Duration.between(pause.start(), pause.end()).toSeconds(),
                pause.reason());
    }

    public List<Pause> pauses() {
        return List.copyOf(pauses);
    }

    public double pausedSeconds() {
        return pauses.stream().mapToLong(pause -> Duration.between(pause.start(), pause.end()).toMillis()).sum()
            / 1e3;
    }

    /** The reading, or null when it failed. */
    private Reading read() {
        try {
            return readings.read();
        } catch (Exception failure) {
            LOG.warn("Cannot read the governor's limits, so they count as missing", failure);
            return null;
        }
    }

    // While paused, a reading must pass the resume threshold, not the pause one.
    private Optional<String> pauseReason(Reading reading, boolean paused) {
        if (reading == null) return Optional.of("readings_unavailable");
        if (reading.slotShare().isEmpty()) return Optional.of("slot_cap_unset");
        if (reading.diskFreeShare().isEmpty()) return Optional.of("disk_reading");
        Optional<ClusterRate> cluster = thresholds.clusterRate();
        if (cluster.isPresent() && reading.clusterBytesPerSecond().isEmpty()) return Optional.of("cluster_wal_rate");
        double slotLimit = paused ? thresholds.slotResume() : thresholds.slotPause();
        if (paused ? !(reading.slotShare().getAsDouble() > slotLimit) : reading.slotShare().getAsDouble() < slotLimit) {
            return Optional.of("slot_headroom");
        }
        double diskLimit = paused ? thresholds.diskResume() : thresholds.diskPause();
        double disk = reading.diskFreeShare().getAsDouble();
        if (paused ? !(disk > diskLimit) : disk < diskLimit) return Optional.of("disk_free");
        if (cluster.isPresent()) {
            double rate = reading.clusterBytesPerSecond().getAsDouble();
            if (paused ? !(rate < cluster.get().resume()) : rate > cluster.get().pause()) {
                return Optional.of("cluster_wal_rate_high");
            }
        }
        return Optional.empty();
    }
}
