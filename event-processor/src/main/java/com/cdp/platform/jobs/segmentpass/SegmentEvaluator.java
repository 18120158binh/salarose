package com.cdp.platform.jobs.segmentpass;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import com.cdp.platform.jobs.customerdecision.transforms.MetricsConditionEvaluator;
import com.cdp.platform.shared.models.db.Segment;
import com.cdp.platform.shared.models.node.FieldPredicates;
import com.cdp.platform.shared.models.node.MetricPredicate;
import com.cdp.platform.shared.models.node.PersonConditions;
import com.cdp.platform.shared.models.node.Predicate;
import com.cdp.platform.shared.utils.ParseResult;

/**
 * A segment parsed for the pass, which evaluates it for an imported-only
 * customer as customer decision evaluates it for a person (SMP-FR-03): behavior
 * conditions read an empty snapshot at {@code as_of}, and a segment membership
 * nested in a segment's conditions fails, as it does in customer decision.
 */
final class SegmentEvaluator {

    private static final MetricsConditionEvaluator METRICS = new MetricsConditionEvaluator();

    private final String segmentId;
    private final PersonConditions conditions;
    private final boolean[] behaviorPassesEmpty;

    private SegmentEvaluator(String segmentId, PersonConditions conditions, boolean[] behaviorPassesEmpty) {
        this.segmentId = segmentId;
        this.conditions = conditions;
        this.behaviorPassesEmpty = behaviorPassesEmpty;
    }

    /**
     * The segment ready to evaluate at {@code asOf}, or a failure when a group's
     * behavior conditions do not parse. Every behavior condition sees the same
     * empty snapshot, so each group's behavior result is fixed here.
     */
    static ParseResult<SegmentEvaluator> of(Segment segment, Instant asOf) {
        List<PersonConditions.Group> groups = segment.conditions().groups();
        boolean[] passes = new boolean[groups.size()];
        for (int index = 0; index < groups.size(); index++) {
            ParseResult<MetricPredicate> behavior = MetricPredicate.parse(groups.get(index).behaviorPredicate());
            if (!behavior.isValid()) {
                return ParseResult.failure(new IllegalArgumentException(behavior.failureMessage()));
            }
            passes[index] = METRICS.evaluate(behavior.valueOrThrow(), Map.of(), asOf.toEpochMilli());
        }
        return ParseResult.success(new SegmentEvaluator(segment.id(), segment.conditions(), passes));
    }

    String segmentId() {
        return segmentId;
    }

    /** Whether every group of the segment passes for the customer. */
    boolean isMember(ImportedCustomer customer) {
        Optional<List<Predicate>> left = conditions
            .profileLeft(group -> behaviorPassesEmpty[group], nested -> Optional.empty());
        return left.isPresent()
            && left.get().stream().allMatch(predicate -> FieldPredicates.evaluate(predicate, customer::field));
    }

    /** The ids of the segments the customer is a member of. */
    static Set<String> memberships(List<SegmentEvaluator> segments, ImportedCustomer customer) {
        List<String> ids = new ArrayList<>();
        for (SegmentEvaluator segment : segments) {
            if (segment.isMember(customer)) ids.add(segment.segmentId);
        }
        return Set.copyOf(ids);
    }
}
