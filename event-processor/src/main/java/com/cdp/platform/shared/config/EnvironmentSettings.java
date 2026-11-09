package com.cdp.platform.shared.config;

import java.util.Map;

import com.cdp.platform.shared.models.source.KafkaSourceConfig;

/**
 * Reads job settings from environment variables. A blank variable counts as
 * unset. A number that is not above zero stops the job at startup, with the
 * variable's name, instead of falling back to its default.
 */
public final class EnvironmentSettings {

    public static final String JOURNEY_TRIGGER_TOPIC = "journey-engine-matched-events";

    private final Map<String, String> variables;

    public EnvironmentSettings(Map<String, String> variables) {
        this.variables = Map.copyOf(variables);
    }

    public static EnvironmentSettings system() {
        return new EnvironmentSettings(System.getenv());
    }

    public String string(String name, String fallback) {
        String value = variables.get(name);
        return value == null || value.isBlank() ? fallback : value.trim();
    }

    /** The job's own {@code <prefix>KAFKA_BROKERS}, else {@code KAFKA_BROKERS}. */
    public String kafkaBrokers(String prefix) {
        return string(prefix + "KAFKA_BROKERS", string("KAFKA_BROKERS", KafkaSourceConfig.DEFAULT_BROKERS));
    }

    /** The topic that customer decision and the watch timers send triggers to. */
    public String journeyTriggerTopic() {
        return string("KAFKA_CAMPAIGN_MATCHED_TOPIC", JOURNEY_TRIGGER_TOPIC);
    }

    public long positiveLong(String name, long fallback) {
        String value = string(name, null);
        if (value == null) return fallback;
        long parsed;
        try {
            parsed = Long.parseLong(value);
        } catch (NumberFormatException notANumber) {
            throw new IllegalArgumentException(name + " must be a whole number above 0, but is '" + value + "'");
        }
        if (parsed <= 0) throw new IllegalArgumentException(name + " must be above 0, but is " + parsed);
        return parsed;
    }

    public int positiveInt(String name, int fallback) {
        long value = positiveLong(name, fallback);
        if (value > Integer.MAX_VALUE)
            throw new IllegalArgumentException(name + " must be at most " + Integer.MAX_VALUE + ", but is " + value);
        return (int) value;
    }
}
