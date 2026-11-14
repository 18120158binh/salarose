package com.cdp.platform.jobs.segmentpass;

import java.net.URI;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;

import com.cdp.platform.shared.utils.JacksonMapper;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

/**
 * The pass's settings and the governor's free disk reading (SMP-NFR-02,
 * SMP-NFR-04).
 */
class SegmentPassSettingsTest {

    @Test
    void defaultsAreThreeAmWithAFiveAmFallbackInHoChiMinhCity() {
        SegmentPassSettings settings = SegmentPassSettings.fromVariables(Map.of());

        // 03:05 local on 14 November is 20:05 UTC on 13 November.
        Instant scheduled = settings.scheduledTime(Instant.parse("2026-11-13T20:05:00Z"));

        assertEquals(Instant.parse("2026-11-13T20:00:00Z"), scheduled);
        assertEquals(Instant.parse("2026-11-13T22:00:00Z"), settings.fallbackTime(scheduled));
        assertEquals(500, settings.batchSize());
        assertEquals(Optional.empty(), settings.freeDiskQuery());
    }

    @Test
    void aPodThatStartsBeforeTheScheduleRunsForTheNightBefore() {
        SegmentPassSettings settings = SegmentPassSettings.fromVariables(Map.of("REPORTING_TIME_ZONE", "UTC"));

        assertEquals(Instant.parse("2026-11-12T03:00:00Z"),
            settings.scheduledTime(Instant.parse("2026-11-13T02:59:00Z")));
    }

    @Test
    void readsEverySetting() {
        SegmentPassSettings settings = SegmentPassSettings
            .fromVariables(Map
                .of("SEGMENT_PASS_SCHEDULE", "04:00",
                    "SEGMENT_PASS_FALLBACK", "06:30", "SEGMENT_PASS_BATCH_SIZE", "100", "WAL_GOVERNOR_DISK_PAUSE",
                    "0.1",
                    "WAL_GOVERNOR_FREE_DISK_QUERY", "http://prometheus:9090/api/v1/query?query=up"));

        assertEquals("04:00", settings.schedule().toString());
        assertEquals("06:30", settings.fallback().toString());
        assertEquals(100, settings.batchSize());
        assertEquals(0.1, settings.thresholds().diskPause());
        assertEquals(Optional.of(URI.create("http://prometheus:9090/api/v1/query?query=up")),
            settings.freeDiskQuery());
    }

    @Test
    void aBadValueStopsTheJob() {
        assertThrows(IllegalStateException.class,
            () -> SegmentPassSettings.fromVariables(Map.of("SEGMENT_PASS_FALLBACK", "5am")));
        assertThrows(IllegalStateException.class,
            () -> SegmentPassSettings.fromVariables(Map.of("WAL_GOVERNOR_SLOT_PAUSE", "2")));
        assertThrows(IllegalArgumentException.class, () -> SegmentPassSettings
            .fromVariables(Map.of("WAL_GOVERNOR_SLOT_PAUSE", "0.9", "WAL_GOVERNOR_SLOT_RESUME", "0.5")));
    }

    @Test
    void theFreeDiskShareIsTheFirstSampleOfAPrometheusVector() {
        // The response shape of the Prometheus HTTP API's instant query, from its
        // documentation.
        String body = """
            {"status":"success","data":{"resultType":"vector","result":[{"metric":{},"value":[1731542400.0,"0.42"]}]}}""";

        assertEquals(0.42, PostgresReadings.freeShare(JacksonMapper.readTree(body)).getAsDouble());
        assertEquals(false, PostgresReadings
            .freeShare(JacksonMapper.readTree("{\"status\":\"success\",\"data\":{\"result\":[]}}"))
            .isPresent());
    }
}
