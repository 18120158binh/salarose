package com.cdp.platform.shared.models.node;

import java.io.Serializable;
import java.time.Duration;
import java.util.Arrays;
import java.util.Optional;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * A window as a rule row writes it. {@link MetricComparison} parses the unit.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record TimeWindow(
    @JsonProperty("value") long value,
    @JsonProperty("unit") String unit) implements Serializable {

    /** The units a window may use, written by name in upper case. */
    public enum Unit {
        SECONDS(Duration.ofSeconds(1)), MINUTES(Duration.ofMinutes(1)), HOURS(Duration.ofHours(1)), DAYS(
            Duration.ofDays(1)), WEEKS(Duration.ofDays(7)), MONTHS(Duration.ofDays(30));

        private final Duration length;

        Unit(Duration length) {
            this.length = length;
        }

        public static Optional<Unit> of(String name) {
            return Arrays.stream(values()).filter(unit -> unit.name().equals(name)).findFirst();
        }

        public long millis() {
            return length.toMillis();
        }
    }
}
