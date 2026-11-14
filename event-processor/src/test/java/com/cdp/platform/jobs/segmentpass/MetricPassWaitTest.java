package com.cdp.platform.jobs.segmentpass;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import com.cdp.platform.jobs.segmentpass.MetricPassWait.MetricPass;
import com.cdp.platform.jobs.segmentpass.MetricPassWait.Start;
import com.cdp.platform.jobs.segmentpass.MetricPassWait.Wait;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

/** Choosing tonight's metric pass and the fallback (SMP-FR-01, SMP-FR-11). */
class MetricPassWaitTest {

    private static final Instant SCHEDULED = Instant.parse("2026-11-13T20:00:00Z");
    private static final Instant FALLBACK = Instant.parse("2026-11-13T22:00:00Z");
    private static final UUID YESTERDAY = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID TODAY = UUID.fromString("00000000-0000-0000-0000-000000000002");

    @Test
    void waitsForTonightsPassThenStartsOnIt() {
        MetricPass yesterday = new MetricPass(YESTERDAY, Instant.parse("2026-11-12T20:00:00Z"), "done");

        assertEquals(new Wait(), MetricPassWait
            .decide(
                List.of(yesterday, new MetricPass(TODAY, SCHEDULED, "running")), SCHEDULED, FALLBACK,
                Instant.parse("2026-11-13T20:10:00Z")));
        assertEquals(new Start(Optional.of(TODAY), false), MetricPassWait
            .decide(
                List.of(yesterday, new MetricPass(TODAY, SCHEDULED, "done")), SCHEDULED, FALLBACK,
                Instant.parse("2026-11-13T20:20:00Z")));
    }

    @Test
    void aFailedPassFallsBackToTheLastFinishedOneAtTheFallbackTime() {
        List<MetricPass> passes = List
            .of(new MetricPass(YESTERDAY, Instant.parse("2026-11-12T20:00:00Z"), "done"),
                new MetricPass(TODAY, SCHEDULED, "failed"));

        assertEquals(new Wait(), MetricPassWait.decide(passes, SCHEDULED, FALLBACK, FALLBACK.minusSeconds(1)));
        assertEquals(new Start(Optional.of(YESTERDAY), true),
            MetricPassWait.decide(passes, SCHEDULED, FALLBACK, FALLBACK));
    }

    @Test
    void noMetricPassAtAllStartsAtTheFallbackOnNone() {
        assertEquals(new Start(Optional.empty(), true),
            MetricPassWait.decide(List.of(), SCHEDULED, FALLBACK, FALLBACK));
    }

    @Test
    void yesterdaysDonePassIsNotTonights() {
        List<MetricPass> passes = List.of(new MetricPass(YESTERDAY, SCHEDULED.minus(MetricPassWait.TONIGHT), "done"));

        assertEquals(new Wait(), MetricPassWait.decide(passes, SCHEDULED, FALLBACK, SCHEDULED));
    }
}
