package com.cdp.platform.jobs.segmentpass;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import com.cdp.platform.jobs.segmentpass.MetricPassWait.MetricPass;

/** What the pass reads and writes in the main Postgres. */
interface PassStore extends AutoCloseable {

    /** One {@code segments} row, unparsed. */
    record SegmentRow(String id, String conditionsJson) {
    }

    /** One {@code segment_import_members} pair. */
    record Member(String segmentId, String customerKey) {
    }

    /** Takes the pass's lock for this session. False when another pass holds it. */
    boolean tryLock() throws Exception;

    /**
     * The metric passes that {@link MetricPassWait#decide} needs: every row with
     * {@code as_of} in the 24 hours up to {@code scheduledTime}, and the latest
     * {@code done} row.
     */
    List<MetricPass> metricPasses(Instant scheduledTime) throws Exception;

    /**
     * Sets every run record still {@code running} to {@code failed}, finished at
     * {@code now}.
     */
    int failRunning(Instant now) throws Exception;

    void openRun(Instant asOf, boolean fallback, Optional<UUID> metricPassId) throws Exception;

    void closeRun(Instant asOf, RunTotals totals) throws Exception;

    List<SegmentRow> segments() throws Exception;

    /**
     * Up to {@code limit} imported-only customer keys after {@code after}, in
     * order.
     */
    List<String> importedOnlyKeys(String after, int limit) throws Exception;

    /**
     * The customers of the keys, with their profile fields and imported attributes.
     */
    Map<String, ImportedCustomer> customers(Collection<String> keys) throws Exception;

    /** The stored segment ids of each key that has any. */
    Map<String, Set<String>> storedSegments(Collection<String> keys) throws Exception;

    /**
     * Inserts the members with {@code since} = {@code asOf} and deletes the
     * leavers, in one transaction. Returns the rows inserted and deleted.
     */
    long[] apply(Collection<Member> inserts, Collection<Member> deletes, Instant asOf) throws Exception;

    /**
     * Deletes up to {@code limit} rows of a key that a tracked person holds, of a
     * key gone from {@code customer_attributes}, or of a segment not in
     * {@code segmentIds}. Returns the rows deleted.
     */
    int deleteStale(Set<String> segmentIds, int limit) throws Exception;

    /** What the run record holds when it closes. */
    record RunTotals(String state, Instant finishedAt, long rowsInserted, long rowsDeleted,
        List<String> skippedSegments, int pauses, double pausedSeconds) {
    }
}
