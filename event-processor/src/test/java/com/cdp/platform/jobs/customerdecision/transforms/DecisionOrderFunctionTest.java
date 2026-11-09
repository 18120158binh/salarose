package com.cdp.platform.jobs.customerdecision.transforms;

import java.time.Duration;
import java.util.List;

import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.runtime.checkpoint.OperatorSubtaskState;
import org.apache.flink.streaming.api.operators.KeyedProcessOperator;
import org.apache.flink.streaming.util.KeyedOneInputStreamOperatorTestHarness;

import com.cdp.platform.shared.models.Event;
import com.cdp.platform.shared.models.VersionedTrigger;
import com.cdp.platform.shared.models.db.UserProfile;
import com.cdp.platform.shared.models.node.Comparison;
import com.cdp.platform.shared.models.node.Predicate;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * The operator that releases each person's triggers in the order the person's
 * inputs arrived, keyed by canon id.
 */
class DecisionOrderFunctionTest {

    private static final Predicate IN_HANOI = new Comparison("profile.city", "=", "Hanoi");

    private KeyedOneInputStreamOperatorTestHarness<String, Decision, VersionedTrigger> order;

    @BeforeEach
    void open() throws Exception {
        order = harness();
        order.open();
    }

    @AfterEach
    void close() throws Exception {
        order.close();
    }

    @Test
    void aPersonsDecisionsThatArriveOutOfOrderAreReleasedInOrder() throws Exception {
        List<String> onTheSecond = process(settled("customer-42", 2));
        List<String> onTheFirst = process(settled("customer-42", 1));

        assertEquals(List.of(), onTheSecond);
        assertEquals(List.of("customer-42/event-1", "customer-42/event-2"), onTheFirst);
    }

    @Test
    void anotherPersonsDecisionIsNotHeldBehindAGap() throws Exception {
        List<String> held = process(settled("customer-42", 2));
        List<String> someoneElse = process(settled("customer-7", 1));

        assertEquals(List.of(), held);
        assertEquals(List.of("customer-7/event-1"), someoneElse);
    }

    /**
     * The person's counter expired and started again above every earlier
     * sequence. The second decision of the new counter arrives before the first.
     */
    @Test
    void aCounterThatStartsAgainKeepsTheOrderOfItsDecisions() throws Exception {
        for (long sequence = 1; sequence <= 4; sequence++) {
            process(settled("customer-42", sequence));
        }

        List<String> onTheSecond = process(decision("customer-42", "restarted-2", 1_001, false));
        List<String> onTheFirst = process(decision("customer-42", "restarted-1", 1_000, true));

        assertEquals(List.of(), onTheSecond);
        assertEquals(List.of("customer-42/restarted-1", "customer-42/restarted-2"), onTheFirst);
    }

    @Test
    void aMissingDecisionHoldsTheLaterOnesHoweverLongItTakes() throws Exception {
        process(settled("customer-42", 1));
        List<String> onTheThird = process(settled("customer-42", 3));
        List<String> aDayLater = advanceTo(Duration.ofDays(1).toMillis());
        List<String> onTheSecond = process(settled("customer-42", 2));

        assertEquals(List.of(), onTheThird);
        assertEquals(List.of(), aDayLater);
        assertEquals(List.of("customer-42/event-2", "customer-42/event-3"), onTheSecond);
    }

    @Test
    void aDecisionHeldAcrossACheckpointIsReleasedInOrderAfterTheRestore() throws Exception {
        process(settled("customer-42", 1));
        process(settled("customer-42", 3));
        OperatorSubtaskState checkpoint = order.snapshot(1L, 0L);
        order.close();

        order = harness();
        order.initializeState(checkpoint);
        order.open();
        List<String> atTheRestore = advanceTo(Duration.ofDays(1).toMillis());
        List<String> onTheSecond = process(settled("customer-42", 2));
        List<String> onTheFourth = process(settled("customer-42", 4));

        assertEquals(List.of(), atTheRestore);
        assertEquals(List.of("customer-42/event-2", "customer-42/event-3"), onTheSecond);
        assertEquals(List.of("customer-42/event-4"), onTheFourth);
    }

    /**
     * A decision that started an older counter and arrives after later ones were
     * released does not move the expected sequence back.
     */
    @Test
    void aLateDecisionThatStartsASequenceDoesNotHoldBackTheNextOne() throws Exception {
        process(settled("customer-42", 1));
        process(settled("customer-42", 2));

        List<String> theLateOne = process(decision("customer-42", "late", 1, true));
        List<String> theNextOne = process(settled("customer-42", 3));

        assertEquals(List.of("customer-42/late"), theLateOne);
        assertEquals(List.of("customer-42/event-3"), theNextOne);
    }

    @Test
    void aRuleWhoseProfileConditionFailsFiresNothingAndHoldsNoOneBack() throws Exception {
        Decision mixed = Decision
            .of(event("customer-42", "event-1"), 1, true, List.of(rule("node-2", null), rule("node-3", IN_HANOI)))
            .withProfile(UserProfile.empty());
        Decision onlyWaiting = Decision
            .of(event("customer-42", "event-2"), 2, false, List.of(rule("node-3", IN_HANOI)))
            .withProfile(UserProfile.empty());

        List<String> onTheMixed = firedRules(mixed);
        List<String> onTheWaiting = firedRules(onlyWaiting);
        List<String> onTheNext = process(settled("customer-42", 3));

        assertEquals(List.of("event-1 node-2:yes"), onTheMixed);
        assertEquals(List.of(), onTheWaiting);
        assertEquals(List.of("customer-42/event-3"), onTheNext);
    }

    private static KeyedOneInputStreamOperatorTestHarness<String, Decision, VersionedTrigger> harness()
        throws Exception {
        return new KeyedOneInputStreamOperatorTestHarness<>(new KeyedProcessOperator<>(new DecisionOrderFunction(31)),
            decision -> decision.event().canonId(), Types.STRING);
    }

    /** The person and event of each trigger released because of the decision. */
    private List<String> process(Decision decision) throws Exception {
        return released(decision).stream().map(DecisionOrderFunctionTest::personAndEvent).toList();
    }

    /**
     * The event, node, and branch of each trigger released because of the decision.
     */
    private List<String> firedRules(Decision decision) throws Exception {
        return released(decision)
            .stream()
            .map(trigger -> trigger.trigger().eventId() + " " + trigger.trigger().nodeId() + ":"
                + trigger.trigger().branch())
            .toList();
    }

    private List<VersionedTrigger> released(Decision decision) throws Exception {
        order.getOutput().clear();
        order.processElement(DecisionPipeline.throughNetwork(decision, Decision.class), 0L);
        return order.extractOutputValues();
    }

    /**
     * Moves the clock and returns the person and event of each trigger released.
     */
    private List<String> advanceTo(long processingTime) throws Exception {
        order.getOutput().clear();
        order.setProcessingTime(processingTime);
        return order.extractOutputValues().stream().map(DecisionOrderFunctionTest::personAndEvent).toList();
    }

    private static String personAndEvent(VersionedTrigger trigger) {
        return trigger.trigger().canonId() + "/" + trigger.trigger().eventId();
    }

    /**
     * A decision of one rule that fires without the profile, from a counter that
     * started at 1.
     */
    private static Decision settled(String canonId, long sequence) {
        return decision(canonId, "event-" + sequence, sequence, sequence == 1);
    }

    private static Decision decision(String canonId, String eventId, long sequence, boolean startsSequence) {
        return Decision.of(event(canonId, eventId), sequence, startsSequence, List.of(rule("node-2", null)));
    }

    private static RuleDecision rule(String nodeId, Predicate profileCondition) {
        return new RuleDecision("CAMP-0001", nodeId, 1L, List.of("yes"), profileCondition);
    }

    private static Event event(String canonId, String eventId) {
        return new Event(canonId, "d1", null, null, "view_page", 1_785_800_000_000L, null, null, null, null, "web",
            "{}", eventId);
    }
}
