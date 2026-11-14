package com.cdp.platform.jobs.segmentpass;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.cdp.platform.jobs.segmentpass.MetricPassWait.Decision;
import com.cdp.platform.jobs.segmentpass.MetricPassWait.Start;
import com.cdp.platform.jobs.segmentpass.PassStore.Member;
import com.cdp.platform.jobs.segmentpass.PassStore.RunTotals;
import com.cdp.platform.jobs.segmentpass.PassStore.SegmentRow;
import com.cdp.platform.shared.models.db.Segment;
import com.cdp.platform.shared.models.node.PersonConditions;
import com.cdp.platform.shared.models.node.RuleDocuments;
import com.cdp.platform.shared.utils.ParseResult;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * One nightly segment membership pass (SMP-FR-01 to SMP-FR-12): waits for
 * tonight's metric pass, evaluates every segment for each imported-only
 * customer at {@code as_of}, and writes only the pairs whose membership
 * changed. It emits no message and starts no journey (SMP-FR-07).
 */
final class SegmentMembershipPass {

    private static final Logger LOG = LoggerFactory.getLogger(SegmentMembershipPass.class);

    /** How the pass waits between two looks at {@code import_metric_passes}. */
    interface Waiter {
        void sleep(Duration duration) throws InterruptedException;
    }

    private final PassStore store;
    private final WalGovernor governor;
    private final SegmentPassSettings settings;
    private final Clock clock;
    private final Waiter waiter;

    SegmentMembershipPass(PassStore store, WalGovernor governor, SegmentPassSettings settings, Clock clock,
        Waiter waiter) {
        this.store = store;
        this.governor = governor;
        this.settings = settings;
        this.clock = clock;
        this.waiter = waiter;
    }

    /**
     * Runs one pass for the night of {@code scheduledTime}. False when another pass
     * holds the lock.
     */
    boolean run(Instant scheduledTime) throws Exception {
        if (!store.tryLock()) {
            LOG.warn("Another segment membership pass holds the lock, so this one ends");
            return false;
        }
        Start start = awaitStart(scheduledTime);
        // Postgres keeps microseconds, so as_of is the value the run record stores.
        Instant asOf = clock.instant().truncatedTo(ChronoUnit.MICROS);
        int crashed = store.failRunning(asOf);
        if (crashed > 0) LOG.warn("Marked {} run records left running by a crashed pass as failed", crashed);
        store.openRun(asOf, start.fallback(), start.metricPassId());
        LOG
            .info("Segment membership pass {} started, fallback={}, metric pass {}", asOf, start.fallback(),
                start.metricPassId().orElse(null));

        List<String> skipped = new ArrayList<>();
        long[] totals = {0, 0};
        try {
            List<SegmentRow> rows = store.segments();
            List<SegmentEvaluator> segments = parse(rows, asOf, skipped);
            writeMembers(segments, asOf, totals);
            Set<String> segmentIds = new HashSet<>();
            rows.forEach(row -> segmentIds.add(row.id()));
            deleteStale(segmentIds, totals);
        } catch (Exception | Error failure) {
            store.closeRun(asOf, totals("failed", totals, skipped));
            throw failure;
        }
        store.closeRun(asOf, totals("done", totals, skipped));
        LOG
            .info("Segment membership pass {} done: {} inserted, {} deleted, skipped {}", asOf, totals[0], totals[1],
                skipped);
        return true;
    }

    private Start awaitStart(Instant scheduledTime) throws Exception {
        Instant fallbackTime = settings.fallbackTime(scheduledTime);
        while (true) {
            Decision decision = MetricPassWait
                .decide(store.metricPasses(scheduledTime), scheduledTime, fallbackTime, clock.instant());
            if (decision instanceof Start start) return start;
            waiter.sleep(settings.metricPassPoll());
        }
    }

    /**
     * The segments that parse. Each one that does not is logged and its id added to
     * {@code skipped}.
     */
    static List<SegmentEvaluator> parse(List<SegmentRow> rows, Instant asOf, List<String> skipped) {
        List<SegmentEvaluator> parsed = new ArrayList<>();
        for (SegmentRow row : rows) {
            ParseResult<PersonConditions> conditions = RuleDocuments.segmentConditions(row.conditionsJson());
            ParseResult<SegmentEvaluator> segment = conditions.isValid()
                ? SegmentEvaluator.of(new Segment(row.id(), conditions.valueOrThrow()), asOf)
                : ParseResult.failure(new IllegalArgumentException(conditions.failureMessage()));
            if (segment.isValid()) {
                parsed.add(segment.valueOrThrow());
            } else {
                LOG.warn("Skipping segment {}, whose conditions do not parse: {}", row.id(), segment.failureMessage());
                skipped.add(row.id());
            }
        }
        return parsed;
    }

    private void writeMembers(List<SegmentEvaluator> segments, Instant asOf, long[] totals) throws Exception {
        Set<String> evaluated = new HashSet<>();
        segments.forEach(segment -> evaluated.add(segment.segmentId()));
        String after = "";
        while (true) {
            List<String> keys = store.importedOnlyKeys(after, settings.batchSize());
            if (keys.isEmpty()) return;
            after = keys.getLast();
            Map<String, ImportedCustomer> customers = store.customers(keys);
            Map<String, Set<String>> stored = store.storedSegments(keys);
            List<Member> inserts = new ArrayList<>();
            List<Member> deletes = new ArrayList<>();
            for (String key : keys) {
                ImportedCustomer customer = customers
                    .getOrDefault(key, new ImportedCustomer(key, null, Map.of()));
                diff(key, SegmentEvaluator.memberships(segments, customer), stored.getOrDefault(key, Set.of()),
                    evaluated, inserts, deletes);
            }
            if (inserts.isEmpty() && deletes.isEmpty()) continue;
            governor.awaitClear();
            long[] applied = store.apply(inserts, deletes, asOf);
            totals[0] += applied[0];
            totals[1] += applied[1];
        }
    }

    /**
     * Adds the pairs to insert and delete for one key. Only segments that parsed
     * are compared, so a skipped segment's rows stay (SMP-FR-12).
     */
    static void diff(String key, Set<String> members, Set<String> stored, Set<String> evaluated,
        List<Member> inserts, List<Member> deletes) {
        for (String segmentId : new LinkedHashSet<>(members)) {
            if (!stored.contains(segmentId)) inserts.add(new Member(segmentId, key));
        }
        for (String segmentId : stored) {
            if (evaluated.contains(segmentId) && !members.contains(segmentId)) deletes.add(new Member(segmentId, key));
        }
    }

    private void deleteStale(Set<String> segmentIds, long[] totals) throws Exception {
        while (true) {
            governor.awaitClear();
            int deleted = store.deleteStale(segmentIds, settings.batchSize());
            totals[1] += deleted;
            if (deleted < settings.batchSize()) return;
        }
    }

    private RunTotals totals(String state, long[] totals, List<String> skipped) {
        return new RunTotals(state, clock.instant(), totals[0], totals[1], List.copyOf(skipped), governor.pauses(),
            governor.pausedSeconds());
    }
}
