package com.cdp.platform.jobs.customerdecision;

import java.util.List;
import java.util.Map;

import com.cdp.platform.jobs.customerdecision.transforms.ProfileLookupFunction.LookupSettings;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class CustomerDecisionSettingsTest {

    @Test
    void anUnsetVariableTakesItsDefault() {
        CustomerDecisionSettings settings = CustomerDecisionSettings.from(Map.<String, String>of()::get);

        assertEquals(new CustomerDecisionSettings(30_000L, 31L, 600_000L, 128, 4096, 32768, 30_000L, 1000,
            new LookupSettings(10, 5000, 5)), settings);
    }

    @Test
    void theCheckpointIntervalTakesAnyDurationUnit() {
        Map<String, Long> millisByValue = Map
            .of("250ms", 250L, "45s", 45_000L, "2m", 120_000L, "1h", 3_600_000L, "1d", 86_400_000L, "60000",
                60_000L, " 30 s ", 30_000L);

        millisByValue
            .forEach((value, millis) -> assertEquals(millis,
                CustomerDecisionSettings.from(Map.of("CHECKPOINT_INTERVAL", value)::get).checkpointIntervalMs(),
                value));
    }

    @Test
    void theLookupThreadsCanBeSet() {
        CustomerDecisionSettings settings = CustomerDecisionSettings.from(Map.of("PROFILE_LOOKUP_THREADS", "20")::get);

        assertEquals(20, settings.profileLookup().threads());
    }

    @Test
    void anOutOfOrdernessOfZeroCountsNoLateEventBeyondTheRetentionPeriod() {
        assertEquals(0L, CustomerDecisionSettings
            .from(Map.of("USER_METRICS_MAX_OUT_OF_ORDERNESS_MS", "0")::get)
            .maxOutOfOrdernessMs());
    }

    @Test
    void aValueTheJobCannotUseFailsWithTheVariableName() {
        List<Map.Entry<String, String>> invalid = List
            .of(Map.entry("CAMPAIGN_LOOKUP_CAPACITY", "0"), Map.entry("CHECKPOINT_INTERVAL", "-5s"),
                Map.entry("CHECKPOINT_INTERVAL", "soon"), Map.entry("USER_METRICS_STATE_RETENTION_DAYS", "-1"),
                Map.entry("USER_METRICS_MAX_OUT_OF_ORDERNESS_MS", "-1"),
                Map.entry("USER_METRICS_MAX_METRICS_PER_CUSTOMER", "3000000000"),
                Map.entry("CAMPAIGN_LOOKUP_TIMEOUT_MS", "30s"), Map.entry("PROFILE_CACHE_MAX_ENTRIES", "0"),
                Map.entry("PROFILE_CACHE_TTL_MINUTES", "61"), Map.entry("PROFILE_LOOKUP_THREADS", "0"));

        invalid.forEach(entry -> {
            String name = entry.getKey();
            String value = entry.getValue();
            IllegalArgumentException failure = assertThrows(IllegalArgumentException.class,
                () -> CustomerDecisionSettings.from(Map.of(name, value)::get), name + "=" + value);
            assertTrue(failure.getMessage().contains(name), failure.getMessage());
        });
    }
}
