package com.cdp.platform.jobs.customerdecision.transforms;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

import org.apache.flink.api.common.functions.DefaultOpenContext;
import org.apache.flink.streaming.api.functions.async.CollectionSupplier;
import org.apache.flink.streaming.api.functions.async.ResultFuture;

import com.cdp.platform.shared.models.Event;
import com.cdp.platform.shared.models.db.UserProfile;
import com.cdp.platform.shared.models.node.And;
import com.cdp.platform.shared.models.node.Comparison;
import com.cdp.platform.shared.models.node.Predicate;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class ProfileLookupFunctionTest {

    private static final String PHONE = "0912345678";
    private static final String CONNECTION_DETAILS = "jdbc:postgresql://profiles.internal:5432/cdp user=cdp_reader";
    private static final Predicate IN_HANOI = new Comparison("profile.city", "=", "Hanoi");
    private static final Predicate IN_HANOI_AND_FEMALE = new And(
        List.of(new Comparison("profile.city", "=", "Hanoi"), new Comparison("user.gender", "=", "female")));
    private static final UserProfile HANOI = new UserProfile(null, null, null, null, null, null, null, null, null,
        null, "Hanoi", null, null, null, null);

    private final ByteArrayOutputStream log = new ByteArrayOutputStream();
    private final List<Decision> completed = new ArrayList<>();
    /** Each lookup, as the profile id and the columns it asked for. */
    private final List<String> profileLookups = new ArrayList<>();
    private PrintStream standardError;

    @BeforeEach
    void captureLog() {
        standardError = System.err;
        System.setErr(new PrintStream(log, true, StandardCharsets.UTF_8));
    }

    @AfterEach
    void restoreLog() {
        System.setErr(standardError);
    }

    @Test
    void aLookupAsksOnlyForTheColumnsThatTheWaitingRulesCompare() {
        ProfileLookupFunction lookup = open(CompletableFuture.completedFuture(HANOI));

        lookup
            .asyncInvoke(Decision
                .of(event(), 1, true,
                    List.of(rule("node-2", null), rule("node-3", IN_HANOI), rule("node-4", IN_HANOI_AND_FEMALE))),
                new Collecting());

        assertEquals(List.of(PHONE + " [city, gender]"), profileLookups);
        assertEquals(List.of("node-2:yes", "node-3:yes"), fired());
    }

    @Test
    void aFailedLookupGivesAnEmptyProfileSoTheWaitingRuleFiresNothing() {
        ProfileLookupFunction lookup = open(
            CompletableFuture.failedFuture(new IllegalStateException(CONNECTION_DETAILS)));

        lookup
            .asyncInvoke(Decision.of(event(), 1, true, List.of(rule("node-2", null), rule("node-3", IN_HANOI))),
                new Collecting());

        assertEquals(List.of(UserProfile.empty()), completed.stream().map(Decision::profile).toList());
        assertEquals(List.of("node-2:yes"), fired());
        assertTrue(logged().contains("customer-42"), logged());
        assertFalse(logged().contains(CONNECTION_DETAILS), logged());
        assertFalse(logged().contains(PHONE), logged());
    }

    @Test
    void aTimedOutLookupGivesAnEmptyProfileSoTheWaitingRuleFiresNothing() {
        ProfileLookupFunction lookup = open(new CompletableFuture<>());

        lookup
            .timeout(Decision.of(event(), 1, true, List.of(rule("node-2", null), rule("node-3", IN_HANOI))),
                new Collecting());

        assertEquals(List.of(UserProfile.empty()), completed.stream().map(Decision::profile).toList());
        assertEquals(List.of("node-2:yes"), fired());
        assertTrue(logged().contains("customer-42"), logged());
        assertFalse(logged().contains(PHONE), logged());
    }

    private ProfileLookupFunction open(CompletableFuture<UserProfile> profile) {
        ProfileLookupFunction lookup = new ProfileLookupFunction(() -> new Profiles(profile));
        lookup.open(DefaultOpenContext.INSTANCE);
        return lookup;
    }

    /** The node and branch of each trigger the completed decisions fire. */
    private List<String> fired() {
        return completed
            .stream()
            .flatMap(decision -> decision.triggers().stream())
            .map(trigger -> trigger.trigger().nodeId() + ":" + trigger.trigger().branch())
            .toList();
    }

    private String logged() {
        return log.toString(StandardCharsets.UTF_8);
    }

    private static RuleDecision rule(String nodeId, Predicate profileCondition) {
        return new RuleDecision("CAMP-0001", nodeId, 1L, List.of("yes"), profileCondition);
    }

    private static Event event() {
        return new Event("customer-42", "d1", null, PHONE, "view_page", 1_785_800_000_000L, null, null, null, null,
            "web", "{}", "view-1");
    }

    /** Answers every lookup with the same future, and records what it asked for. */
    private final class Profiles implements ProfileLookupFunction.ProfileStore {

        private final CompletableFuture<UserProfile> answer;

        Profiles(CompletableFuture<UserProfile> answer) {
            this.answer = answer;
        }

        @Override
        public CompletableFuture<UserProfile> find(String userId, String canonId, Set<String> columns) {
            profileLookups.add(userId + " " + columns);
            return answer;
        }

        @Override
        public void close() {
        }
    }

    /** Collects what the lookup completes with. */
    private final class Collecting implements ResultFuture<Decision> {

        @Override
        public void complete(Collection<Decision> results) {
            completed.addAll(results);
        }

        @Override
        public void complete(CollectionSupplier<Decision> results) {
            try {
                complete(results.get());
            } catch (Exception exception) {
                throw new IllegalStateException(exception);
            }
        }

        @Override
        public void completeExceptionally(Throwable error) {
            throw new IllegalStateException("The profile lookup never fails a decision", error);
        }
    }
}
