package com.cdp.platform.jobs.customerdecision.transforms;

import java.time.Instant;
import java.util.List;
import java.util.Set;

import com.cdp.platform.shared.models.Event;
import com.cdp.platform.shared.models.JourneyTriggerEvent;
import com.cdp.platform.shared.models.VersionedTrigger;
import com.cdp.platform.shared.models.db.CampaignNode;
import com.cdp.platform.shared.models.db.UserProfile;
import com.cdp.platform.shared.models.node.And;
import com.cdp.platform.shared.models.node.Comparison;
import com.cdp.platform.shared.models.node.Not;
import com.cdp.platform.shared.models.node.Or;
import com.cdp.platform.shared.models.node.Predicate;

/**
 * One rule's decision on one event: the branches it fires on, and the profile
 * condition it still waits for, or null when it fires without the profile. It
 * carries the condition itself, not the rule, so the operator that finishes it
 * holds no copy of the rules.
 */
record RuleDecision(String campaignId, String nodeId, long graphVersion, List<String> branches,
    Predicate profileCondition) {

    /**
     * The decision to fire on {@code branch} once every group in
     * {@code profileLeft} passes on the profile. With no group left, it fires
     * without the profile.
     */
    static RuleDecision of(CampaignNode node, String branch, List<Predicate> profileLeft) {
        return new RuleDecision(node.campaignId(), node.nodeId(), node.graphVersion(), List.of(branch),
            profileLeft.isEmpty() ? null : new And(List.copyOf(profileLeft)));
    }

    boolean needsProfile() {
        return profileCondition != null;
    }

    /**
     * Whether the rule fires on the profile, measuring relative dates from the
     * check time.
     */
    boolean fires(UserProfile profile, Instant checkTime) {
        return profileCondition == null || profile.evalPredicate(profileCondition, checkTime);
    }

    VersionedTrigger trigger(Event event, String branch, String contextJson) {
        return new VersionedTrigger(new JourneyTriggerEvent(JourneyTriggerEvent.SCHEMA_VERSION, event.eventId(),
            event.canonId(), event.domainUserId(), event.networkUserId(), event.userId(), campaignId, nodeId, branch,
            event.eventName(), event.eventTimestamp(), contextJson), graphVersion);
    }

    /** Adds the fields that the profile condition compares. */
    void collectProfileFields(Set<String> fields) {
        collectFields(profileCondition, fields);
    }

    private static void collectFields(Predicate predicate, Set<String> fields) {
        if (predicate == null) return;
        switch (predicate) {
            case And(var expressions) -> collectFields(expressions, fields);
            case Or(var expressions) -> collectFields(expressions, fields);
            case Not(var expression) -> collectFields(expression, fields);
            case Comparison comparison -> {
                if (comparison.left() != null) fields.add(comparison.left());
            }
        }
    }

    private static void collectFields(List<Predicate> expressions, Set<String> fields) {
        if (expressions == null) return;
        expressions.forEach(expression -> collectFields(expression, fields));
    }
}
