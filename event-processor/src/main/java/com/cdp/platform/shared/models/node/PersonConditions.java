package com.cdp.platform.shared.models.node;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.function.Function;
import java.util.function.IntPredicate;
import java.util.stream.Stream;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * A rule's conditions on the person, in groups. Every group must pass, and a
 * group passes when any of its conditions passes, so no groups pass. Each
 * group keeps its profile and its behavior conditions apart, because the
 * profile is looked up only after the behavior conditions are evaluated. A
 * behavior comparison names the metric id on its left and the measure as its
 * function. A segment membership is answered from the segment's own conditions
 * when the rule is evaluated.
 */
public record PersonConditions(@JsonProperty("groups") List<Group> groups) {

    public static final PersonConditions NONE = new PersonConditions(List.of());

    public PersonConditions {
        groups = groups == null ? List.of() : List.copyOf(groups);
    }

    public record Group(
        @JsonProperty("profile") List<Comparison> profile,
        @JsonProperty("behavior") List<Comparison> behavior,
        @JsonProperty("segments") List<SegmentMembership> segments) {

        public Group {
            profile = profile == null ? List.of() : List.copyOf(profile);
            behavior = behavior == null ? List.of() : List.copyOf(behavior);
            segments = segments == null ? List.of() : List.copyOf(segments);
        }

        /** The group's behavior conditions, any of which passes the group. */
        public Or behaviorPredicate() {
            return new Or(List.<Predicate>copyOf(behavior));
        }
    }

    /** Both lists of groups, so that each of them must pass. */
    public PersonConditions and(PersonConditions other) {
        if (other == null || other.groups.isEmpty()) return this;
        return new PersonConditions(Stream.concat(groups.stream(), other.groups.stream()).toList());
    }

    /** The ids of the metrics that the behavior conditions read. */
    public Set<String> metricIds() {
        Set<String> metricIds = new LinkedHashSet<>();
        groups.forEach(group -> group.behavior().forEach(comparison -> metricIds.add(comparison.left())));
        return metricIds;
    }

    /** The ids of the segments that the segment memberships name. */
    public Set<String> segmentIds() {
        Set<String> segmentIds = new LinkedHashSet<>();
        groups.forEach(group -> group.segments().forEach(segment -> segmentIds.add(segment.segmentId())));
        return segmentIds;
    }

    /**
     * The profile conditions left to check once the behavior conditions of each
     * group, and the segment memberships, are known: one {@code or} for each
     * group that has not passed. {@code segmentLeft} answers a membership in
     * the same shape as this method. Empty when the conditions fail without the
     * profile, because such a group has nothing left that could pass. An empty
     * list passes.
     */
    public Optional<List<Predicate>> profileLeft(IntPredicate behaviorPasses,
        Function<SegmentMembership, Optional<List<Predicate>>> segmentLeft) {
        List<Predicate> left = new ArrayList<>();
        for (int index = 0; index < groups.size(); index++) {
            if (behaviorPasses.test(index)) continue;
            Group group = groups.get(index);
            List<Predicate> pending = new ArrayList<>(group.profile());
            boolean passes = false;
            for (SegmentMembership segment : group.segments()) {
                Optional<List<Predicate>> segmentPending = segmentLeft.apply(segment);
                if (segmentPending.isEmpty()) continue;
                if (segmentPending.get().isEmpty()) {
                    passes = true;
                    break;
                }
                pending.add(new And(segmentPending.get()));
            }
            if (passes) continue;
            if (pending.isEmpty()) return Optional.empty();
            left.add(new Or(List.copyOf(pending)));
        }
        return Optional.of(List.copyOf(left));
    }
}
