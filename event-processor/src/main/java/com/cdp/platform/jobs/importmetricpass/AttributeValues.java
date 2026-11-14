package com.cdp.platform.jobs.importmetricpass;

import java.time.DateTimeException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.Collection;
import java.util.Optional;
import java.util.TreeSet;
import java.util.regex.Pattern;

import com.cdp.platform.shared.models.imports.DatasetColumn.ColumnType;
import com.cdp.platform.shared.utils.PlaceholderIds;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.DoubleNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.TextNode;

/**
 * The values of an attribute object, by Build each row: a number is a double,
 * a datetime is ISO 8601 with the reporting time zone's offset to the second,
 * and {@code emails} and {@code phones} are sorted by code point without
 * duplicates. A value with no value is empty, and stays out of the object.
 */
final class AttributeValues {

    private static final DateTimeFormatter SECONDS = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ssXXX");
    // A country code of up to three digits, then one digit repeated, such as
    // +84000000000.
    private static final Pattern ONE_DIGIT_REPEATED = Pattern.compile("\\+?\\d{0,3}(\\d)\\1{7,}");

    private AttributeValues() {
    }

    static Optional<JsonNode> number(double value) {
        return Double.isFinite(value) ? Optional.of(DoubleNode.valueOf(value)) : Optional.empty();
    }

    static JsonNode datetime(Instant value, ZoneId zone) {
        return TextNode.valueOf(SECONDS.format(value.atZone(zone).truncatedTo(ChronoUnit.SECONDS)));
    }

    /**
     * A stored value of a column, as an attribute value. A datetime that does not
     * parse, or a number that is not finite, has no value.
     */
    static Optional<JsonNode> ofColumn(JsonNode value, ColumnType type, ZoneId zone) {
        if (value == null || value.isNull() || value.isMissingNode()) return Optional.empty();
        return switch (type) {
            case NUMBER -> value.isNumber() ? number(value.doubleValue()) : Optional.empty();
            case DATETIME -> {
                if (!value.isTextual()) yield Optional.empty();
                try {
                    yield Optional.of(datetime(OffsetDateTime.parse(value.textValue()).toInstant(), zone));
                } catch (DateTimeException e) {
                    yield Optional.empty();
                }
            }
            default -> Optional.of(value);
        };
    }

    /** Sorted by code point, without duplicates. Empty for no values. */
    static Optional<JsonNode> identifiers(Collection<String> values) {
        TreeSet<String> sorted = new TreeSet<>(AttributeValues::byCodePoint);
        sorted.addAll(values);
        if (sorted.isEmpty()) return Optional.empty();
        ArrayNode array = JsonNodeFactory.instance.arrayNode();
        sorted.forEach(array::add);
        return Optional.of(array);
    }

    /**
     * A value that counts as shared without a second holder: a placeholder id of
     * event ingestion, or one digit repeated (IMP-FR-08).
     */
    static boolean sharedAlone(String value, PlaceholderIds placeholders) {
        return placeholders.normalize(value) == null || ONE_DIGIT_REPEATED.matcher(value).matches();
    }

    private static int byCodePoint(String a, String b) {
        int i = 0;
        int j = 0;
        while (i < a.length() && j < b.length()) {
            int x = a.codePointAt(i);
            int y = b.codePointAt(j);
            if (x != y) return Integer.compare(x, y);
            i += Character.charCount(x);
            j += Character.charCount(y);
        }
        return Integer.compare(a.length() - i, b.length() - j);
    }
}
