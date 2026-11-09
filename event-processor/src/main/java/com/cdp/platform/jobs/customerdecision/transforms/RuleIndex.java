package com.cdp.platform.jobs.customerdecision.transforms;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import com.cdp.platform.shared.models.Event;
import com.cdp.platform.shared.models.SegmentCheck;
import com.cdp.platform.shared.models.db.Campaign;
import com.cdp.platform.shared.models.db.CampaignNode;
import com.cdp.platform.shared.models.db.Segment;
import com.cdp.platform.shared.models.node.And;
import com.cdp.platform.shared.models.node.Comparison;
import com.cdp.platform.shared.models.node.MetricPredicate;
import com.cdp.platform.shared.models.node.Not;
import com.cdp.platform.shared.models.node.Or;
import com.cdp.platform.shared.models.node.PersonConditions;
import com.cdp.platform.shared.models.node.Predicate;
import com.cdp.platform.shared.utils.ParseResult;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The rules in node state, indexed so that candidate selection reads only the
 * rules that can fire on an event: by the event names that a rule's event
 * condition allows, and, for a rule without a trigger, by the metrics its
 * behavior conditions read. A rule whose event condition allows any event name
 * is
 * read on every event. It also holds the segments that rules test. Each subtask
 * builds its index from its own copy of the
 * broadcast state and keeps it in step with the updates, so the index is not
 * state of its own.
 */
final class RuleIndex {

    private static final Logger LOG = LoggerFactory.getLogger(RuleIndex.class);

    private static final String EVENT_NAME = "event.name";

    private final Map<String, CampaignNode> nodes = new HashMap<>();
    private final Set<String> activeCampaignIds = new HashSet<>();
    private final Map<String, Set<String>> byEventName = new HashMap<>();
    private final Map<String, Set<String>> byMetricId = new HashMap<>();
    private final Set<String> onEveryEvent = new HashSet<>();
    /**
     * The typed behavior conditions of each group, by rule and branch, for each
     * rule evaluated since its row last changed.
     */
    private final Map<String, Map<String, Optional<List<MetricPredicate>>>> behaviorGroups = new HashMap<>();
    private final Map<String, Segment> segments = new HashMap<>();
    /**
     * The typed behavior conditions of each group of a segment, for each segment
     * evaluated since its row last changed.
     */
    private final Map<String, Optional<List<MetricPredicate>>> segmentBehaviorGroups = new HashMap<>();

    static RuleIndex of(Iterable<Map.Entry<String, CampaignNode>> nodes,
        Iterable<Map.Entry<String, Campaign>> campaigns, Iterable<Map.Entry<String, Segment>> segments) {
        RuleIndex index = new RuleIndex();
        nodes.forEach(entry -> index.putNode(entry.getKey(), entry.getValue()));
        campaigns.forEach(entry -> index.putCampaign(entry.getKey(), entry.getValue()));
        segments.forEach(entry -> index.putSegment(entry.getKey(), entry.getValue()));
        return index;
    }

    /**
     * Holds the segment under its id, or removes it when {@code segment} is null.
     */
    void putSegment(String segmentId, Segment segment) {
        segmentBehaviorGroups.remove(segmentId);
        if (segment == null) {
            segments.remove(segmentId);
        } else {
            segments.put(segmentId, segment);
        }
    }

    /** The segment with the id, or empty when the job holds none. */
    Optional<Segment> segment(String segmentId) {
        return Optional.ofNullable(segments.get(segmentId));
    }

    /**
     * The behavior conditions of each group of the segment, parsed once per
     * segment version, or empty when one does not parse.
     */
    Optional<List<MetricPredicate>> segmentBehaviorGroups(Segment segment) {
        return segmentBehaviorGroups
            .computeIfAbsent(segment.id(), id -> parseBehaviorGroups(segment.conditions(), "segment " + id));
    }

    /**
     * The series that the rule's conditions read: those of its behavior
     * conditions, and those of the segments it tests that the job holds.
     */
    Set<String> metricIds(CampaignNode node) {
        Set<String> metricIds = new HashSet<>(node.metricIds());
        for (String segmentId : node.segmentIds()) {
            Segment segment = segments.get(segmentId);
            if (segment != null) metricIds.addAll(segment.conditions().metricIds());
        }
        return metricIds;
    }

    /** Indexes the rule under its key, or removes it when {@code node} is null. */
    void putNode(String ruleKey, CampaignNode node) {
        CampaignNode previous = nodes.remove(ruleKey);
        behaviorGroups.remove(ruleKey);
        if (previous != null) unfile(ruleKey, placement(previous));
        if (node == null) return;

        file(ruleKey, placement(node));
        nodes.put(ruleKey, node);
    }

    /**
     * Records whether the campaign is active, or removes it when {@code campaign}
     * is null.
     */
    void putCampaign(String campaignId, Campaign campaign) {
        if (campaign != null && campaign.isActive()) {
            activeCampaignIds.add(campaignId);
        } else {
            activeCampaignIds.remove(campaignId);
        }
    }

    /** The rule under its key, or null when there is none. */
    CampaignNode node(String ruleKey) {
        return nodes.get(ruleKey);
    }

    /**
     * The behavior conditions of each group that the rule must pass on
     * {@code branch}, as {@link CampaignNode#conditionsOn} lists the groups,
     * parsed once per rule, branch, and row version. A rule restored from state
     * can predate the parse-time checks on metric comparisons. If one does not
     * parse, the rule does not fire on the branch until its row changes.
     */
    Optional<List<MetricPredicate>> behaviorGroups(String ruleKey, String branch) {
        return behaviorGroups
            .computeIfAbsent(ruleKey, key -> new HashMap<>())
            .computeIfAbsent(branch, key -> parseBehaviorGroups(nodes.get(ruleKey).conditionsOn(branch),
                "rule %s on %s".formatted(ruleKey, branch)));
    }

    private static Optional<List<MetricPredicate>> parseBehaviorGroups(PersonConditions conditions, String owner) {
        List<MetricPredicate> groups = new ArrayList<>();
        for (PersonConditions.Group group : conditions.groups()) {
            ParseResult<MetricPredicate> parsed = MetricPredicate.parse(group.behaviorPredicate());
            if (!parsed.isValid()) {
                LOG.warn("Not passing {}, whose behavior condition does not parse: {}", owner, parsed.failureMessage());
                return Optional.empty();
            }
            groups.add(parsed.valueOrThrow());
        }
        return Optional.of(List.copyOf(groups));
    }

    CandidateSelection select(Event event, Set<String> changedMetricIds) {
        List<Map.Entry<String, CampaignNode>> rules = rulesFor(event, changedMetricIds)
            .stream()
            .map(ruleKey -> Map.entry(ruleKey, nodes.get(ruleKey)))
            .toList();
        return CandidateSelection.select(event, rules, activeCampaignIds, changedMetricIds, this::metricIds);
    }

    /** The segment that a person reached. */
    CandidateSelection selectArrival(SegmentCheck check) {
        String ruleKey = CampaignNode.stateKey(check.campaignId(), check.nodeId());
        return CandidateSelection.arrivalAt(ruleKey, nodes.get(ruleKey), activeCampaignIds, this::metricIds);
    }

    /** The keys of the rules that can fire on the event. */
    Set<String> rulesFor(Event event, Set<String> changedMetricIds) {
        Set<String> ruleKeys = new HashSet<>(onEveryEvent);
        String eventName = event.propertyValue(EVENT_NAME);
        if (eventName != null) {
            ruleKeys.addAll(byEventName.getOrDefault(eventName, Set.of()));
        }
        for (String metricId : changedMetricIds) {
            ruleKeys.addAll(byMetricId.getOrDefault(metricId, Set.of()));
        }
        return ruleKeys;
    }

    /** The number of event names and metric ids that rules are filed under. */
    int keyCount() {
        return byEventName.size() + byMetricId.size();
    }

    private Placement placement(CampaignNode node) {
        if (node.condition() == null && !node.metricIds().isEmpty()) {
            return new Placement(byMetricId, node.metricIds());
        }
        return eventNames(node.condition())
            .map(names -> new Placement(byEventName, names))
            .orElse(Placement.ON_EVERY_EVENT);
    }

    private void file(String ruleKey, Placement placement) {
        if (placement.index() == null) {
            onEveryEvent.add(ruleKey);
            return;
        }
        for (String key : placement.keys()) {
            placement.index().computeIfAbsent(key, ignored -> new HashSet<>()).add(ruleKey);
        }
    }

    private void unfile(String ruleKey, Placement placement) {
        if (placement.index() == null) {
            onEveryEvent.remove(ruleKey);
            return;
        }
        for (String key : placement.keys()) {
            Set<String> ruleKeys = placement.index().get(key);
            if (ruleKeys == null) continue;
            ruleKeys.remove(ruleKey);
            if (ruleKeys.isEmpty()) placement.index().remove(key);
        }
    }

    /**
     * The event names that a condition can match, or empty when it can match any
     * name. Only a comparison of {@code event.name} with {@code =} limits the
     * name, and a trigger's {@code IN} on it is one {@code =} per value.
     */
    private static Optional<Set<String>> eventNames(Predicate predicate) {
        if (predicate == null) return Optional.empty();
        return switch (predicate) {
            case And(var expressions) -> expressions == null
                ? Optional.empty()
                : expressions.stream().map(RuleIndex::eventNames).flatMap(Optional::stream).findFirst();
            case Or(var expressions) -> eventNamesOfAny(expressions);
            case Not ignored -> Optional.empty();
            case Comparison comparison -> eventNamesCompared(comparison);
        };
    }

    private static Optional<Set<String>> eventNamesOfAny(List<Predicate> expressions) {
        Set<String> names = new HashSet<>();
        for (Predicate expression : expressions == null ? List.<Predicate>of() : expressions) {
            Optional<Set<String>> allowed = eventNames(expression);
            if (allowed.isEmpty()) return Optional.empty();
            names.addAll(allowed.get());
        }
        return Optional.of(names);
    }

    private static Optional<Set<String>> eventNamesCompared(Comparison comparison) {
        if (!EVENT_NAME.equals(comparison.left()) || comparison.op() == null || comparison.right() == null) {
            return Optional.empty();
        }
        return "=".equals(comparison.op()) ? Optional.of(Set.of(comparison.right())) : Optional.empty();
    }

    /**
     * Where a rule is filed: under each of {@code keys} in {@code index}, or, with
     * no index, on every event.
     */
    private record Placement(Map<String, Set<String>> index, Set<String> keys) {

        static final Placement ON_EVERY_EVENT = new Placement(null, Set.of());
    }
}
