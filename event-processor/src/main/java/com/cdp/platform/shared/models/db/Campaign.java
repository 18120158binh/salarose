package com.cdp.platform.shared.models.db;

import java.time.Instant;
import java.util.Optional;

import org.apache.flink.types.Row;

import com.cdp.platform.shared.db.repositories.CampaignsTable;

import com.fasterxml.jackson.annotation.JsonProperty;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Represents one row from the {@code campaigns} table. */
public record Campaign(
    @JsonProperty("id") String id,
    @JsonProperty("name") String name,
    @JsonProperty("description") String description,
    @JsonProperty("status") String status,
    @JsonProperty("rootJson") String rootJson,
    @JsonProperty("createdUser") String createdUser,
    @JsonProperty("createdAt") Instant createdAt,
    @JsonProperty("updatedAt") Instant updatedAt) {

    private static final Logger LOG = LoggerFactory.getLogger(Campaign.class);

    public Campaign {
        if (id == null || id.isBlank()) throw new IllegalArgumentException("Campaign id is required");
        if (name == null || name.isBlank()) throw new IllegalArgumentException("Campaign name is required");
        if (status == null || status.isBlank()) throw new IllegalArgumentException("Campaign status is required");
    }

    public static Campaign fromRow(Row row) {
        return new Campaign(
            row.getFieldAs(CampaignsTable.ID),
            row.getFieldAs(CampaignsTable.NAME),
            row.getFieldAs(CampaignsTable.DESCRIPTION),
            row.getFieldAs(CampaignsTable.STATUS),
            row.getFieldAs(CampaignsTable.ROOT),
            row.getFieldAs(CampaignsTable.CREATED_USER),
            row.getFieldAs(CampaignsTable.CREATED_AT),
            row.getFieldAs(CampaignsTable.UPDATED_AT));
    }

    public static Optional<Campaign> load(Row row) {
        try {
            return Optional.of(fromRow(row));
        } catch (IllegalArgumentException exception) {
            LOG.warn("Ignoring invalid campaign {}: {}", row.getField(CampaignsTable.ID), exception.getMessage());
            return Optional.empty();
        }
    }

    public boolean isActive() {
        return "active".equals(status);
    }
}
