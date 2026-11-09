package com.cdp.platform.jobs.customerdecision.transforms;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import com.cdp.platform.shared.models.Event;
import com.cdp.platform.shared.models.VersionedTrigger;
import com.cdp.platform.shared.models.db.UserProfile;
import com.cdp.platform.shared.utils.JacksonMapper;

/**
 * What one input of a person decided, numbered in the order the person's inputs
 * arrived. Every rule in it was evaluated against the rules the job held when
 * the input arrived. It passes between the operators of the job and is never
 * written to Kafka.
 *
 * <p>
 * {@code startsSequence} marks the first decision after the person's counter
 * started, or started again once its state expired. A counter starts at the
 * processing time, so its sequences are above those of any earlier counter.
 *
 * <p>
 * The profile holds the fields that the waiting rules compare, once they are
 * looked up. Until then, and when no rule waits, it is empty.
 */
public record Decision(Event event, long sequence, boolean startsSequence, List<RuleDecision> rules,
    UserProfile profile) {

    static Decision of(Event event, long sequence, boolean startsSequence, List<RuleDecision> rules) {
        return new Decision(event, sequence, startsSequence, List.copyOf(rules), UserProfile.empty());
    }

    /** Whether a rule waits for the profile. */
    boolean needsProfile() {
        return rules.stream().anyMatch(RuleDecision::needsProfile);
    }

    /** The profile fields that the waiting rules compare. */
    Set<String> profileFields() {
        Set<String> fields = new LinkedHashSet<>();
        rules.forEach(rule -> rule.collectProfileFields(fields));
        return fields;
    }

    Decision withProfile(UserProfile found) {
        return new Decision(event, sequence, startsSequence, rules, found);
    }

    /** One trigger for each branch of each rule that fires, in rule order. */
    List<VersionedTrigger> triggers() {
        List<VersionedTrigger> triggers = new ArrayList<>();
        String contextJson = null;
        for (RuleDecision rule : rules) {
            if (!rule.fires(profile)) continue;
            if (contextJson == null) contextJson = JacksonMapper.writeValueAsString(event.buildContext());
            for (String branch : rule.branches()) {
                triggers.add(rule.trigger(event, branch, contextJson));
            }
        }
        return triggers;
    }
}
