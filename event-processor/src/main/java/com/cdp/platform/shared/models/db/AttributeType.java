package com.cdp.platform.shared.models.db;

import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.Locale;
import java.util.Optional;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * The type of an event catalog attribute, from
 * {@code user_event_fields.data_type}.
 */
public enum AttributeType {
    STRING, NUMBER, BOOLEAN, DATETIME, JSON;

    /**
     * The type a {@code data_type} value names, or empty for a value the catalog
     * does not define.
     */
    public static Optional<AttributeType> parse(String dataType) {
        if (dataType == null) return Optional.empty();
        try {
            return Optional.of(valueOf(dataType.trim().toUpperCase(Locale.ROOT)));
        } catch (IllegalArgumentException unknown) {
            return Optional.empty();
        }
    }

    /** Whether a non-null JSON value has this type. */
    public boolean matches(JsonNode value) {
        return switch (this) {
            case STRING -> value.isTextual();
            case NUMBER -> value.isNumber();
            case BOOLEAN -> value.isBoolean();
            case DATETIME -> value.isTextual() && isDateTime(value.textValue());
            case JSON -> value.isObject() || value.isArray();
        };
    }

    /** The name the catalog stores, such as {@code number}. */
    public String label() {
        return name().toLowerCase(Locale.ROOT);
    }

    /**
     * An RFC 3339 date-time with an offset, as JSON Schema's {@code date-time}
     * format.
     */
    private static boolean isDateTime(String text) {
        try {
            OffsetDateTime.parse(text);
            return true;
        } catch (DateTimeParseException invalid) {
            return false;
        }
    }
}
