package com.cdp.platform.shared.models.node;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Locale;
import java.util.Map;

import com.cdp.platform.shared.utils.JacksonMapper;
import com.cdp.platform.shared.utils.ParseResult;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * How long a watch node waits for its event, read from the {@code limit} of
 * its paths JSON, {@code { "value": V, "unit": U }}. The value is a number
 * above zero, and the unit is seconds, minutes, hours, or days, in any case. A
 * missing limit or value is 15, and a missing unit is minutes.
 */
public record WatchLimit(long millis) {

    public static final WatchLimit DEFAULT = new WatchLimit(15 * 60_000L);

    private static final BigDecimal DEFAULT_VALUE = BigDecimal.valueOf(15);
    private static final String DEFAULT_UNIT = "minutes";
    private static final Map<String, Long> UNIT_MILLIS = Map
        .of("seconds", 1_000L, "minutes", 60_000L, "hours", 3_600_000L, "days", 86_400_000L);

    public WatchLimit {
        if (millis <= 0) throw new IllegalArgumentException("Watch limit must be above zero");
    }

    public static ParseResult<WatchLimit> fromPaths(String pathsJson) {
        if (pathsJson == null || pathsJson.isBlank()) return ParseResult.success(DEFAULT);
        JsonNode paths;
        try {
            paths = JacksonMapper.readTree(pathsJson);
        } catch (IllegalArgumentException exception) {
            return invalid("the paths are not JSON");
        }
        if (!paths.isObject()) return invalid("the paths are not a JSON object");
        JsonNode limit = paths.get("limit");
        if (limit == null || limit.isNull()) return ParseResult.success(DEFAULT);
        return fromLimit(limit);
    }

    private static ParseResult<WatchLimit> fromLimit(JsonNode limit) {
        if (limit.isMissingNode()) return ParseResult.success(DEFAULT);
        if (!limit.isObject()) return invalid("the limit is not a JSON object");

        JsonNode value = limit.get("value");
        if (value != null && !value.isNumber()) return invalid("value is not a number: " + value);
        BigDecimal amount = value == null ? DEFAULT_VALUE : value.decimalValue();
        if (amount.signum() <= 0) return invalid("value is not above zero: " + value);

        JsonNode unit = limit.get("unit");
        if (unit != null && !unit.isTextual()) return invalid("unit is not text: " + unit);
        Long unitMillis = UNIT_MILLIS.get(unit == null ? DEFAULT_UNIT : unit.asText().toLowerCase(Locale.ROOT));
        if (unitMillis == null) return invalid("unsupported unit: " + unit);

        try {
            long millis = amount
                .multiply(BigDecimal.valueOf(unitMillis))
                .setScale(0, RoundingMode.CEILING)
                .longValueExact();
            return ParseResult.success(new WatchLimit(millis));
        } catch (ArithmeticException tooLarge) {
            return invalid("the limit does not fit in a long of milliseconds: " + value + " " + unit);
        }
    }

    /**
     * The deadline of a watch whose parent completed at {@code eventTime}. A sum
     * past the largest long is a deadline that never comes.
     */
    public long deadlineAfter(long eventTime) {
        long deadline = eventTime + millis;
        return deadline < eventTime ? Long.MAX_VALUE : deadline;
    }

    private static ParseResult<WatchLimit> invalid(String reason) {
        return ParseResult.failure(new IllegalArgumentException("Invalid watch limit: " + reason));
    }
}
