package com.cdp.platform.shared.models.db;

import java.util.Optional;

import org.apache.flink.types.Row;

import com.cdp.platform.shared.db.repositories.SegmentsTable;
import com.cdp.platform.shared.models.node.PersonConditions;
import com.cdp.platform.shared.models.node.RuleDocuments;
import com.cdp.platform.shared.utils.ParseResult;

import com.fasterxml.jackson.annotation.JsonProperty;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Validated representation of one {@code segments} row: its id and its
 * conditions, groups of profile and behavior conditions that must all pass.
 */
public record Segment(@JsonProperty("id") String id, @JsonProperty("conditions") PersonConditions conditions) {

    private static final Logger LOG = LoggerFactory.getLogger(Segment.class);

    public static ParseResult<Segment> fromRow(Row row) {
        String id = row.getFieldAs(SegmentsTable.ID);
        if (id == null || id.isBlank()) {
            return ParseResult.failure(new IllegalArgumentException("Segment id is required"));
        }
        ParseResult<PersonConditions> conditions = RuleDocuments
            .segmentConditions(row.getFieldAs(SegmentsTable.CONDITIONS_JSON));
        if (!conditions.isValid()) {
            return ParseResult.failure(new IllegalArgumentException(conditions.failureMessage()));
        }
        if (conditions.valueOrThrow() == null) {
            return ParseResult.failure(new IllegalArgumentException("Segment has no conditions"));
        }
        return ParseResult.success(new Segment(id, conditions.valueOrThrow()));
    }

    /** The segment, or empty when the row does not parse, which is logged. */
    public static Optional<Segment> load(Row row) {
        ParseResult<Segment> parsed = fromRow(row);
        if (!parsed.isValid()) {
            LOG.warn("Ignoring invalid segment {}: {}", row.getField(SegmentsTable.ID), parsed.failureMessage());
            return Optional.empty();
        }
        return Optional.of(parsed.valueOrThrow());
    }
}
