package com.cdp.platform.jobs.customerdecision;

import java.time.Duration;
import java.util.function.Function;

import org.apache.flink.util.TimeUtils;

import com.cdp.platform.jobs.customerdecision.transforms.ProfileLookupFunction.LookupSettings;

/**
 * The customer decision job's settings, read from its environment variables. An
 * unset or blank variable takes its default. A value the job cannot use fails
 * the job when it is built, with the variable's name in the message.
 */
record CustomerDecisionSettings(
    long checkpointIntervalMs,
    long stateRetentionDays,
    long maxOutOfOrdernessMs,
    int maxMetricsPerCustomer,
    int maxStringValueBytes,
    int maxEventContextBytes,
    long lookupTimeoutMs,
    int lookupCapacity,
    LookupSettings profileLookup) {

    private static final int MAX_CACHE_ENTRIES = 20_000;
    private static final int MAX_CACHE_TTL_MINUTES = 60;

    static CustomerDecisionSettings from(Function<String, String> environment) {
        Settings settings = new Settings(environment);
        return new CustomerDecisionSettings(
            settings.duration("CHECKPOINT_INTERVAL", Duration.ofSeconds(30)).toMillis(),
            settings.number("USER_METRICS_STATE_RETENTION_DAYS", 31, 1, Long.MAX_VALUE),
            settings.number("USER_METRICS_MAX_OUT_OF_ORDERNESS_MS", 600_000, 0, Long.MAX_VALUE),
            settings.count("USER_METRICS_MAX_METRICS_PER_CUSTOMER", 128, Integer.MAX_VALUE),
            settings.count("USER_METRICS_MAX_STRING_VALUE_BYTES", 4096, Integer.MAX_VALUE),
            settings.count("USER_METRICS_MAX_EVENT_CONTEXT_BYTES", 32768, Integer.MAX_VALUE),
            settings.number("CAMPAIGN_LOOKUP_TIMEOUT_MS", 30_000, 1, Long.MAX_VALUE),
            settings.count("CAMPAIGN_LOOKUP_CAPACITY", 1000, Integer.MAX_VALUE),
            new LookupSettings(settings.count("PROFILE_LOOKUP_THREADS", 10, Integer.MAX_VALUE),
                settings.count("PROFILE_CACHE_MAX_ENTRIES", 5000, MAX_CACHE_ENTRIES),
                settings.count("PROFILE_CACHE_TTL_MINUTES", 5, MAX_CACHE_TTL_MINUTES)));
    }

    /** Reads each variable by name, so a failure can name it. */
    private record Settings(Function<String, String> environment) {

        /**
         * A duration above 0 with a unit such as {@code ms}, {@code s}, {@code m},
         * {@code h}, or {@code d}. A bare number is milliseconds.
         */
        Duration duration(String name, Duration fallback) {
            String value = environment.apply(name);
            if (value == null || value.isBlank()) return fallback;
            Duration parsed;
            try {
                parsed = TimeUtils.parseDuration(value);
            } catch (IllegalArgumentException invalid) {
                throw new IllegalArgumentException(name + " is not a duration: " + value, invalid);
            }
            if (parsed.isZero() || parsed.isNegative()) {
                throw new IllegalArgumentException(name + " must be above 0: " + value);
            }
            return parsed;
        }

        /** A whole number from {@code minimum} to {@code maximum}. */
        long number(String name, long fallback, long minimum, long maximum) {
            String value = environment.apply(name);
            if (value == null || value.isBlank()) return fallback;
            long parsed;
            try {
                parsed = Long.parseLong(value.trim());
            } catch (NumberFormatException invalid) {
                throw new IllegalArgumentException(name + " is not a whole number: " + value, invalid);
            }
            if (parsed < minimum || parsed > maximum)
                throw new IllegalArgumentException(
                    "%s must be from %d to %d: %s".formatted(name, minimum, maximum, value));
            return parsed;
        }

        /** A whole number from 1 to {@code maximum}. */
        int count(String name, int fallback, int maximum) {
            return (int) number(name, fallback, 1, maximum);
        }
    }
}
