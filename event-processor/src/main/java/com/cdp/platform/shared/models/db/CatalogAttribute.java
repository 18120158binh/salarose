package com.cdp.platform.shared.models.db;

import java.util.Arrays;
import java.util.Optional;
import java.util.stream.Collectors;

import org.apache.flink.types.Row;

import com.cdp.platform.shared.db.repositories.UserEventFieldsTable;

import com.fasterxml.jackson.annotation.JsonProperty;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * One row of the event catalog table {@code user_event_fields}: an attribute of
 * an event, by its dotted path into {@code event_json}. The type is null when
 * {@code data_type} names no catalog type, and then only {@code required} is
 * checked.
 */
public record CatalogAttribute(
    @JsonProperty("eventId") String eventId,
    @JsonProperty("path") String path,
    @JsonProperty("type") AttributeType type,
    @JsonProperty("required") boolean required) {

    private static final Logger LOG = LoggerFactory.getLogger(CatalogAttribute.class);

    public CatalogAttribute {
        if (eventId == null || eventId.isBlank()) {
            throw new IllegalArgumentException("Catalog attribute event id is required");
        }
        if (path == null || path.isEmpty()) throw new IllegalArgumentException("Catalog attribute path is required");
    }

    public static Optional<CatalogAttribute> load(Row row) {
        try {
            String dataType = row.getFieldAs(UserEventFieldsTable.DATA_TYPE);
            return Optional
                .of(new CatalogAttribute(row.getFieldAs(UserEventFieldsTable.USER_EVENT_ID),
                    normalize(row.getFieldAs(UserEventFieldsTable.FIELD_PATH)),
                    AttributeType.parse(dataType).orElse(null),
                    Boolean.TRUE.equals(row.getField(UserEventFieldsTable.REQUIRED))));
        } catch (IllegalArgumentException exception) {
            LOG
                .warn("Ignoring invalid catalog attribute {}: {}", row.getField(UserEventFieldsTable.ID),
                    exception.getMessage());
            return Optional.empty();
        }
    }

    /** The key of a {@code user_event_fields} row, which a delete also carries. */
    public static String stateKey(Row row) {
        return String.valueOf(row.getField(UserEventFieldsTable.ID));
    }

    /** Trims each segment and drops empty ones, as the catalog editor does. */
    private static String normalize(String path) {
        if (path == null) return null;
        return Arrays
            .stream(path.split("\\."))
            .map(String::trim)
            .filter(segment -> !segment.isEmpty())
            .collect(Collectors.joining("."));
    }
}
