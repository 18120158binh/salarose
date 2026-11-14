package com.cdp.platform.jobs.importapplier;

import java.math.BigDecimal;
import java.time.DateTimeException;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.Locale;
import java.util.Optional;
import java.util.regex.Pattern;

import com.cdp.platform.shared.models.imports.DatasetColumn.ColumnType;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.BooleanNode;
import com.fasterxml.jackson.databind.node.DecimalNode;
import com.fasterxml.jackson.databind.node.TextNode;

/**
 * Parses one value into a column's type, by Validate each row. The result is
 * the stored form: a string, a number, a boolean, an ISO-8601 instant with
 * its offset kept, or any JSON value.
 */
final class Values {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Pattern DECIMAL = Pattern.compile("-?[0-9]+(\\.[0-9]+)?");
    // A date and a time joined by a space, which ISO-8601 joins by T.
    private static final Pattern SPACE_JOINED = Pattern.compile("\\d{4}-\\d{2}-\\d{2} \\d{2}:.*");

    private Values() {
    }

    /** The value in the column's type, or empty when it holds another type. */
    static Optional<JsonNode> parse(ColumnType type, JsonNode value, boolean csv, ZoneId zone) {
        return switch (type) {
            case STRING -> value.isTextual() ? Optional.of(value) : Optional.empty();
            case NUMBER -> number(value, csv);
            case BOOLEAN -> bool(value, csv);
            case DATETIME -> value.isTextual()
                ? instant(value.asText(), zone).map(time -> TextNode.valueOf(format(time)))
                : Optional.empty();
            case JSON -> csv ? json(value.asText()) : Optional.of(value);
        };
    }

    private static Optional<JsonNode> number(JsonNode value, boolean csv) {
        if (!csv) return value.isNumber() ? Optional.of(value) : Optional.empty();
        String text = value.asText();
        return DECIMAL.matcher(text).matches()
            ? Optional.of(DecimalNode.valueOf(new BigDecimal(text)))
            : Optional.empty();
    }

    private static Optional<JsonNode> bool(JsonNode value, boolean csv) {
        if (value.isBoolean()) return Optional.of(value);
        if (!value.isTextual()) return Optional.empty();
        String text = value.asText().toLowerCase(Locale.ROOT);
        if (text.equals("true") || csv && text.equals("1")) return Optional.of(BooleanNode.TRUE);
        if (text.equals("false") || csv && text.equals("0")) return Optional.of(BooleanNode.FALSE);
        return Optional.empty();
    }

    private static Optional<JsonNode> json(String text) {
        try {
            return Optional.of(JSON.readTree(text));
        } catch (JsonProcessingException e) {
            return Optional.empty();
        }
    }

    /**
     * The stored form of a datetime: ISO-8601 with seconds and the offset it was
     * read with.
     */
    static String format(OffsetDateTime time) {
        return DateTimeFormatter.ISO_OFFSET_DATE_TIME.format(time);
    }

    /**
     * An ISO-8601 date-time, with T or a space between date and time. A value
     * with an offset keeps it. A value without one, or a bare date at the start
     * of its day, is read in the zone.
     */
    static Optional<OffsetDateTime> instant(String text, ZoneId zone) {
        String iso = SPACE_JOINED.matcher(text).matches() ? text.replaceFirst(" ", "T") : text;
        try {
            return Optional.of(OffsetDateTime.parse(iso, DateTimeFormatter.ISO_OFFSET_DATE_TIME));
        } catch (DateTimeException ignored) {
            // Try the forms without an offset.
        }
        try {
            return Optional
                .of(LocalDateTime
                    .parse(iso, DateTimeFormatter.ISO_LOCAL_DATE_TIME)
                    .atZone(zone)
                    .toOffsetDateTime());
        } catch (DateTimeException ignored) {
            // Try a bare date.
        }
        try {
            return Optional
                .of(LocalDate
                    .parse(iso, DateTimeFormatter.ISO_LOCAL_DATE)
                    .atStartOfDay(zone)
                    .toOffsetDateTime());
        } catch (DateTimeException e) {
            return Optional.empty();
        }
    }
}
