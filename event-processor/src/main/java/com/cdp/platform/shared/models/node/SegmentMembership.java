package com.cdp.platform.shared.models.node;

import java.util.List;
import java.util.Optional;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * A {@code segment_membership} condition: with {@code in}, every group of the
 * segment's conditions passes for the person now; with {@code not_in}, at least
 * one fails.
 */
public record SegmentMembership(@JsonProperty("segmentId") String segmentId, @JsonProperty("in") boolean in) {

    /**
     * The condition left on the profile, from what is left of the segment's
     * conditions, in the shape of {@link PersonConditions#profileLeft}: empty
     * when it fails, an empty list when it passes. {@code not_in} is the
     * negation.
     */
    public Optional<List<Predicate>> left(Optional<List<Predicate>> segmentLeft) {
        if (in) return segmentLeft;
        if (segmentLeft.isEmpty()) return Optional.of(List.of());
        if (segmentLeft.get().isEmpty()) return Optional.empty();
        return Optional.of(List.of(new Not(new And(segmentLeft.get()))));
    }
}
