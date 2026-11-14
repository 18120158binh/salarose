package com.cdp.platform.jobs.segmentpass;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;

import com.cdp.platform.jobs.segmentpass.MetricPassWait.MetricPass;
import com.cdp.platform.shared.utils.JacksonMapper;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * The main Postgres tables the pass touches, in memory: {@code segments},
 * {@code customer_attributes}, the {@code user_id}s of {@code identity_graph},
 * {@code import_metric_passes}, {@code segment_import_members}, and
 * {@code segment_membership_passes}.
 */
final class FakePassStore implements PassStore {

    /** A run record, as the table holds it. */
    static final class Run {
        final Instant asOf;
        final boolean fallback;
        final Optional<UUID> metricPassId;
        String state = "running";
        RunTotals totals;

        Run(Instant asOf, boolean fallback, Optional<UUID> metricPassId) {
            this.asOf = asOf;
            this.fallback = fallback;
            this.metricPassId = metricPassId;
        }
    }

    final Map<String, String> segments = new LinkedHashMap<>();
    final Map<String, Map<String, JsonNode>> attributes = new HashMap<>();
    final Set<String> trackedUserIds = new HashSet<>();
    final List<MetricPass> metricPasses = new ArrayList<>();
    final Map<Member, Instant> members = new LinkedHashMap<>();
    final List<Run> runs = new ArrayList<>();
    boolean locked;
    int writes;
    /**
     * Fails the {@code apply} call with this number, counting from 1, to model a
     * crash.
     */
    int failApplyAt;

    void attribute(String key, String source, String json) {
        attributes.computeIfAbsent(key, ignored -> new HashMap<>()).put(source, JacksonMapper.readTree(json));
    }

    @Override
    public boolean tryLock() {
        if (locked) return false;
        locked = true;
        return true;
    }

    @Override
    public List<MetricPass> metricPasses(Instant scheduledTime) {
        return List.copyOf(metricPasses);
    }

    @Override
    public int failRunning(Instant now) {
        int failed = 0;
        for (Run run : runs) {
            if (run.state.equals("running")) {
                run.state = "failed";
                failed++;
            }
        }
        return failed;
    }

    @Override
    public void openRun(Instant asOf, boolean fallback, Optional<UUID> metricPassId) {
        runs.add(new Run(asOf, fallback, metricPassId));
    }

    @Override
    public void closeRun(Instant asOf, RunTotals totals) {
        Run run = runs.stream().filter(candidate -> candidate.asOf.equals(asOf)).findFirst().orElseThrow();
        run.state = totals.state();
        run.totals = totals;
    }

    @Override
    public List<SegmentRow> segments() {
        return segments.entrySet().stream().map(entry -> new SegmentRow(entry.getKey(), entry.getValue())).toList();
    }

    @Override
    public List<String> importedOnlyKeys(String after, int limit) {
        return new TreeSet<>(attributes.keySet())
            .tailSet(after, false)
            .stream()
            .filter(key -> !trackedUserIds.contains(key))
            .limit(limit)
            .toList();
    }

    @Override
    public Map<String, ImportedCustomer> customers(Collection<String> keys) {
        Map<String, ImportedCustomer> customers = new HashMap<>();
        keys
            .forEach(
                key -> customers.put(key, new ImportedCustomer(key, null, attributes.getOrDefault(key, Map.of()))));
        return customers;
    }

    @Override
    public Map<String, Set<String>> storedSegments(Collection<String> keys) {
        Map<String, Set<String>> stored = new HashMap<>();
        members.keySet().forEach(member -> {
            if (keys.contains(member.customerKey())) {
                stored.computeIfAbsent(member.customerKey(), ignored -> new HashSet<>()).add(member.segmentId());
            }
        });
        return stored;
    }

    @Override
    public long[] apply(Collection<Member> inserts, Collection<Member> deletes, Instant asOf) {
        writes++;
        if (writes == failApplyAt) throw new IllegalStateException("crash");
        long inserted = inserts.stream().filter(member -> members.putIfAbsent(member, asOf) == null).count();
        long deleted = deletes.stream().filter(member -> members.remove(member) != null).count();
        return new long[] {inserted, deleted};
    }

    @Override
    public int deleteStale(Set<String> segmentIds, int limit) {
        List<Member> stale = members
            .keySet()
            .stream()
            .filter(member -> !segmentIds.contains(member.segmentId())
                || trackedUserIds.contains(member.customerKey())
                || !attributes.containsKey(member.customerKey()))
            .limit(limit)
            .toList();
        stale.forEach(members::remove);
        if (!stale.isEmpty()) writes++;
        return stale.size();
    }

    @Override
    public void close() {
    }
}
