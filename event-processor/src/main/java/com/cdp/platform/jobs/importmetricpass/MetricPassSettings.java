package com.cdp.platform.jobs.importmetricpass;

import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeParseException;
import java.util.Map;
import java.util.Optional;

import com.cdp.platform.shared.batch.WalGovernor;
import com.cdp.platform.shared.utils.PlaceholderIds;

/**
 * The pass's settings, read from the environment once at start (IMP-NFR-03).
 * A value that does not parse stops the job before it takes the lock. The
 * variables are listed in {@code docs/internal/operations/configuration.md}.
 */
record MetricPassSettings(LocalTime schedule, ZoneId zone, int batchSize, double ownWalBytesPerSecond,
    WalGovernor.Thresholds thresholds, Optional<URI> freeDiskQuery, long claimBytes, String tombstoneKey,
    PlaceholderIds placeholders) {

    static final double MB = 1024 * 1024;
    static final Duration DEADLINE_MARGIN = Duration.ofMinutes(15);
    static final int MIN_TOMBSTONE_KEY_LENGTH = 32;

    static MetricPassSettings fromVariables(Map<String, String> variables) {
        String tombstoneKey = variables.get("IMPORT_TOMBSTONE_KEY");
        if (tombstoneKey == null || tombstoneKey.length() < MIN_TOMBSTONE_KEY_LENGTH) {
            throw new IllegalStateException("IMPORT_TOMBSTONE_KEY must hold at least 32 characters");
        }
        double clusterPause = positive(variables, "WAL_GOVERNOR_CLUSTER_PAUSE_BYTES_PER_SECOND", (long) (2 * MB));
        double clusterResume = positive(variables, "WAL_GOVERNOR_CLUSTER_RESUME_BYTES_PER_SECOND",
            (long) (1.5 * MB));
        return new MetricPassSettings(
            time(variables, "METRIC_PASS_SCHEDULE", LocalTime.of(3, 0)),
            ZoneId.of(variables.getOrDefault("REPORTING_TIME_ZONE", "Asia/Ho_Chi_Minh")),
            (int) positive(variables, "METRIC_PASS_BATCH_SIZE", 500),
            positive(variables, "METRIC_PASS_OWN_WAL_BYTES_PER_SECOND", (long) (0.25 * MB)),
            new WalGovernor.Thresholds(
                share(variables, "WAL_GOVERNOR_SLOT_PAUSE", 1.0 / 2),
                share(variables, "WAL_GOVERNOR_SLOT_RESUME", 2.0 / 3),
                share(variables, "WAL_GOVERNOR_DISK_PAUSE", 0.20),
                share(variables, "WAL_GOVERNOR_DISK_RESUME", 0.25),
                Optional.of(new WalGovernor.ClusterRate(clusterPause, clusterResume)),
                Duration.ofSeconds(positive(variables, "WAL_GOVERNOR_POLL_SECONDS", 30))),
            Optional
                .ofNullable(variables.get("WAL_GOVERNOR_FREE_DISK_QUERY"))
                .filter(value -> !value.isBlank())
                .map(URI::create),
            positive(variables, "WAL_GOVERNOR_CLAIM_BYTES", 8L * 1024 * 1024 * 1024),
            tombstoneKey,
            PlaceholderIds.parse(variables.get(PlaceholderIds.VARIABLE)));
    }

    /**
     * The latest scheduled time at or before {@code now}: tonight's {@code as_of}
     * once the schedule has passed, else last night's (IMP-FR-01).
     */
    Instant scheduledTime(Instant now) {
        ZonedDateTime local = now.atZone(zone);
        ZonedDateTime today = local.toLocalDate().atTime(schedule).atZone(zone);
        return (today.isAfter(local) ? today.minusDays(1) : today).toInstant();
    }

    /**
     * 15 minutes before the next scheduled time after an attempt begins
     * (IMP-FR-20).
     */
    Instant deadline(Instant attemptStart) {
        return scheduledTime(attemptStart).atZone(zone).plusDays(1).toInstant().minus(DEADLINE_MARGIN);
    }

    private static LocalTime time(Map<String, String> variables, String name, LocalTime fallback) {
        String value = variables.get(name);
        if (value == null || value.isBlank()) return fallback;
        try {
            return LocalTime.parse(value.trim());
        } catch (DateTimeParseException invalid) {
            throw new IllegalStateException(name + " must be a local time such as 03:00, got " + value, invalid);
        }
    }

    private static long positive(Map<String, String> variables, String name, long fallback) {
        String value = variables.get(name);
        if (value == null || value.isBlank()) return fallback;
        try {
            long parsed = Long.parseLong(value.trim());
            if (parsed > 0) return parsed;
        } catch (NumberFormatException ignored) {
            // Reported below.
        }
        throw new IllegalStateException(name + " must be a whole number above 0, got " + value);
    }

    private static double share(Map<String, String> variables, String name, double fallback) {
        String value = variables.get(name);
        if (value == null || value.isBlank()) return fallback;
        try {
            double parsed = Double.parseDouble(value.trim());
            if (parsed > 0 && parsed <= 1) return parsed;
        } catch (NumberFormatException ignored) {
            // Reported below.
        }
        throw new IllegalStateException(name + " must be a share above 0 and at most 1, got " + value);
    }

    @Override
    public String toString() {
        return "MetricPassSettings[schedule=%s, zone=%s, batchSize=%d, ownWalBytesPerSecond=%.0f, thresholds=%s]"
            .formatted(schedule, zone, batchSize, ownWalBytesPerSecond, thresholds);
    }
}
