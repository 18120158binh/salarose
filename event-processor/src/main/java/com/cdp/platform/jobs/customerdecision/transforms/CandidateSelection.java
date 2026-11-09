package com.cdp.platform.jobs.customerdecision.transforms;

import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;

import com.cdp.platform.shared.models.Event;
import com.cdp.platform.shared.models.db.CampaignNode;
import com.cdp.platform.shared.models.node.NodeType;

/**
 * The candidate rules of an event, by key, with the branches each one's event
 * condition matched, and the series their conditions read, through the segments
 * they test as well.
 */
record CandidateSelection(Map<String, List<String>> branches, Set<String> metricIds) {

    static CandidateSelection select(Event event, Iterable<Map.Entry<String, CampaignNode>> nodes,
        Set<String> activeCampaignIds, Set<String> changedMetricIds, Function<CampaignNode, Set<String>> metricIdsOf) {
        Map<String, List<String>> branches = new LinkedHashMap<>();
        Set<String> metricIds = new LinkedHashSet<>();

        for (Map.Entry<String, CampaignNode> entry : nodes) {
            CampaignNode node = entry.getValue();
            if (!activeCampaignIds.contains(node.campaignId())) continue;
            if (node.condition() == null && node.metricIds().stream().noneMatch(changedMetricIds::contains)) continue;
            List<String> matched = event.matchAll(node);
            if (matched.isEmpty()) continue;

            branches.put(entry.getKey(), matched);
            metricIds.addAll(metricIdsOf.apply(node));
        }

        return new CandidateSelection(branches, Set.copyOf(metricIds));
    }

    /**
     * The segment a person reached, as the one candidate, on the branch a segment
     * fires. There is none when the rule is gone, is no longer a segment, or its
     * campaign is not active.
     */
    static CandidateSelection arrivalAt(String ruleKey, CampaignNode node, Set<String> activeCampaignIds,
        Function<CampaignNode, Set<String>> metricIdsOf) {
        if (node == null || node.nodeType() != NodeType.segment || !activeCampaignIds.contains(node.campaignId())) {
            return new CandidateSelection(Map.of(), Set.of());
        }
        List<String> branches = node.nodeType().triggerBranch().map(Enum::name).stream().toList();
        return new CandidateSelection(Map.of(ruleKey, branches), Set.copyOf(metricIdsOf.apply(node)));
    }

    List<String> ruleKeys() {
        return List.copyOf(branches.keySet());
    }

    boolean hasCandidates() {
        return !branches.isEmpty();
    }
}
