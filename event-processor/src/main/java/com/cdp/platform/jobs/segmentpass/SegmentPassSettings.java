package com.cdp.platform.jobs.segmentpass;

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

/**
 * The pass's settings, read from the environment once at start
 * (SMP-NFR-02, SMP-NFR-04). A value that does not parse stops the job.
 */
record SegmentPassSettings(LocalTime schedule, LocalTime fallback, ZoneId zone, int batchSize,
    Duration metricPassPoll, WalGovernor.Thresholds thresholds, Optional<URI> freeDiskQuery, long claimBytes) {

    static final LocalTime DEFAULT_SCHEDULE = LocalTime.of(3, 0);
    static final LocalTime DEFAULT_FALLBACK = LocalTime.of(5, 0);
    static final String DEFAULT_ZONE = "Asia/Ho_Chi_Minh";
    static final long DEFAULT_CLAIM_BYTES = 8L * 1024 * 1024 * 1024;

    static SegmentPassSettings fromVariables(Map<String, String> variables) {
        return new SegmentPassSettings(
            time(variables, "SEGMENT_PASS_SCHEDULE", DEFAULT_SCHEDULE),
            time(variables, "SEGMENT_PASS_FALLBACK", DEFAULT_FALLBACK),
            ZoneId.of(variables.getOrDefault("REPORTING_TIME_ZONE", DEFAULT_ZONE)),
            (int) positive(variables, "SEGMENT_PASS_BATCH_SIZE", 500),
            Duration.ofSeconds(positive(variables, "SEGMENT_PASS_METRIC_POLL_SECONDS", 30)),
            new WalGovernor.Thresholds(
                share(variables, "WAL_GOVERNOR_SLOT_PAUSE", 1.0 / 2),
                share(variables, "WAL_GOVERNOR_SLOT_RESUME", 2.0 / 3),
                share(variables, "WAL_GOVERNOR_DISK_PAUSE", 0.20),
                share(variables, "WAL_GOVERNOR_DISK_RESUME", 0.25),
                Duration.ofSeconds(positive(variables, "WAL_GOVERNOR_POLL_SECONDS", 30))),
            Optional
                .ofNullable(variables.get("WAL_GOVERNOR_FREE_DISK_QUERY"))
                .filter(value -> !value.isBlank())
                .map(URI::create),
            positive(variables, "WAL_GOVERNOR_CLAIM_BYTES", DEFAULT_CLAIM_BYTES));
    }

    /**
     * The scheduled time of the night the pass runs for: the latest
     * {@link #schedule} at or before {@code now}, so a pod that starts late still
     * waits for the same night's metric pass.
     */
    Instant scheduledTime(Instant now) {
        ZonedDateTime local = now.atZone(zone);
        ZonedDateTime today = local.toLocalDate().atTime(schedule).atZone(zone);
        return (today.isAfter(local) ? today.minusDays(1) : today).toInstant();
    }

    /** The first {@link #fallback} after the scheduled time. */
    Instant fallbackTime(Instant scheduledTime) {
        ZonedDateTime scheduled = scheduledTime.atZone(zone);
        ZonedDateTime sameDay = scheduled.toLocalDate().atTime(fallback).atZone(zone);
        return (sameDay.isAfter(scheduled) ? sameDay : sameDay.plusDays(1)).toInstant();
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
}
