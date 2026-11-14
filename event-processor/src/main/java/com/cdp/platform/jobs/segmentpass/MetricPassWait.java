package com.cdp.platform.jobs.segmentpass;

import java.time.Duration;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * When the pass starts, and on which metric pass (SMP-FR-01, SMP-FR-11).
 * Tonight's metric pass is the {@code import_metric_passes} row with the latest
 * {@code as_of} in the 24 hours up to and including the scheduled time.
 */
final class MetricPassWait {

    static final Duration TONIGHT = Duration.ofHours(24);

    /** One {@code import_metric_passes} row, as the pass reads it. */
    record MetricPass(UUID id, Instant asOf, String state) {

        boolean isDone() {
            return "done".equals(state);
        }
    }

    /** The decision: wait, or start on a metric pass, or on none. */
    sealed interface Decision {
    }

    record Wait() implements Decision {
    }

    /**
     * Start now. {@code metricPassId} is tonight's metric pass when it reached
     * {@code done}, else the last finished one, else empty.
     */
    record Start(Optional<UUID> metricPassId, boolean fallback) implements Decision {
    }

    private MetricPassWait() {
    }

    static Decision decide(List<MetricPass> passes, Instant scheduledTime, Instant fallbackTime, Instant now) {
        Optional<MetricPass> tonight = passes
            .stream()
            .filter(pass -> !pass.asOf().isAfter(scheduledTime) && pass.asOf().isAfter(scheduledTime.minus(TONIGHT)))
            .max(Comparator.comparing(MetricPass::asOf));
        if (tonight.isPresent() && tonight.get().isDone()) return new Start(tonight.map(MetricPass::id), false);
        if (now.isBefore(fallbackTime)) return new Wait();
        Optional<UUID> lastFinished = passes
            .stream()
            .filter(MetricPass::isDone)
            .max(Comparator.comparing(MetricPass::asOf))
            .map(MetricPass::id);
        return new Start(lastFinished, true);
    }
}
