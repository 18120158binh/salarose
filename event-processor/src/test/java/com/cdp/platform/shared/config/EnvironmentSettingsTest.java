package com.cdp.platform.shared.config;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class EnvironmentSettingsTest {

    private static final String LIMIT = "STATE_MACHINE_MAX_PENDING_MATCHES_PER_JOURNEY";

    @Test
    void anUnsetOrBlankVariableTakesItsDefault() {
        assertEquals(1000, new EnvironmentSettings(Map.of()).positiveInt(LIMIT, 1000));
        assertEquals(1000, new EnvironmentSettings(Map.of(LIMIT, "  ")).positiveInt(LIMIT, 1000));
    }

    @Test
    void aValueAboveZeroIsRead() {
        assertEquals(5, new EnvironmentSettings(Map.of(LIMIT, " 5 ")).positiveInt(LIMIT, 1000));
        assertEquals(7_776_000_000L,
            new EnvironmentSettings(Map.of(LIMIT, "7776000000")).positiveLong(LIMIT, 1L));
    }

    @Test
    void zeroNegativeAndUnparseableValuesStopTheJobAndNameTheVariable() {
        for (String invalid : new String[] {"0", "-1", "ten", "1.5"}) {
            EnvironmentSettings settings = new EnvironmentSettings(Map.of(LIMIT, invalid));
            IllegalArgumentException error = assertThrows(IllegalArgumentException.class,
                () -> settings.positiveLong(LIMIT, 1000L), invalid);
            assertTrue(error.getMessage().contains(LIMIT), error.getMessage());
        }
    }

    @Test
    void anIntSettingAboveTheIntRangeStopsTheJob() {
        EnvironmentSettings settings = new EnvironmentSettings(Map.of(LIMIT, "2147483648"));

        assertThrows(IllegalArgumentException.class, () -> settings.positiveInt(LIMIT, 1000));
    }

    @Test
    void aJobsOwnBrokersWinOverTheSharedOnesAndTheDefault() {
        assertEquals("redpanda:29092", new EnvironmentSettings(Map.of()).kafkaBrokers("STATE_MACHINE_"));
        assertEquals("shared:9092",
            new EnvironmentSettings(Map.of("KAFKA_BROKERS", "shared:9092")).kafkaBrokers("STATE_MACHINE_"));
        assertEquals("own:9092", new EnvironmentSettings(
            Map.of("KAFKA_BROKERS", "shared:9092", "STATE_MACHINE_KAFKA_BROKERS", "own:9092"))
            .kafkaBrokers("STATE_MACHINE_"));
    }

    @Test
    void theTriggerTopicDefaultsToTheMatchedEventsTopic() {
        assertEquals("journey-engine-matched-events", new EnvironmentSettings(Map.of()).journeyTriggerTopic());
        assertEquals("triggers",
            new EnvironmentSettings(Map.of("KAFKA_CAMPAIGN_MATCHED_TOPIC", "triggers")).journeyTriggerTopic());
    }
}
