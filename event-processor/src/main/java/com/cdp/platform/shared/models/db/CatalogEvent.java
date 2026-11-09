package com.cdp.platform.shared.models.db;

import java.util.Optional;

import org.apache.flink.types.Row;

import com.cdp.platform.shared.db.repositories.UserEventsTable;

import com.fasterxml.jackson.annotation.JsonProperty;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * One row of the event catalog table {@code user_events}, with the columns
 * ingestion reads.
 */
public record CatalogEvent(
    @JsonProperty("id") String id,
    @JsonProperty("eventName") String eventName,
    @JsonProperty("enforceSchema") boolean enforceSchema) {

    private static final Logger LOG = LoggerFactory.getLogger(CatalogEvent.class);

    public CatalogEvent {
        if (id == null || id.isBlank()) throw new IllegalArgumentException("Catalog event id is required");
        if (eventName == null || eventName.isBlank()) {
            throw new IllegalArgumentException("Catalog event name is required");
        }
    }

    public static Optional<CatalogEvent> load(Row row) {
        try {
            return Optional
                .of(new CatalogEvent(row.getFieldAs(UserEventsTable.ID), row.getFieldAs(UserEventsTable.EVENT_NAME),
                    Boolean.TRUE.equals(row.getField(UserEventsTable.ENFORCE_SCHEMA))));
        } catch (IllegalArgumentException exception) {
            LOG.warn("Ignoring invalid catalog event {}: {}", row.getField(UserEventsTable.ID), exception.getMessage());
            return Optional.empty();
        }
    }
}
