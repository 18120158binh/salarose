package com.cdp.platform.jobs.importapplier;

import java.sql.SQLException;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.Set;

import com.cdp.platform.shared.models.imports.DatasetVersion;

import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * The applier's reads and writes of runs, datasets, and tombstones on the main
 * Postgres. Each state change is one conditional update from the state it
 * leaves, and returns false when the run was no longer there (IAP-FR-03).
 */
interface RunStore {

    /** A run found at {@code validating} or {@code applying} by recovery. */
    record Stranded(String id, String state, boolean approved) {
    }

    /**
     * An applied run of a type, which a re-derive applies again.
     *
     * @param startedAt
     *            when its last validation started, which its event time range is
     *            relative to
     */
    record AppliedRun(String id, String source, String writer, String format, Long byteSize, String fileKey,
        String storedSha256, Instant startedAt) {
    }

    List<Stranded> stranded() throws SQLException;

    /**
     * Moves a stranded run back to {@code approved} or {@code queued} (IAP-FR-24).
     */
    boolean reset(Stranded run) throws SQLException;

    /** Moves a run from {@code applying} to {@code applied}, with its counts. */
    boolean markApplied(String runId, ObjectNode counts) throws SQLException;

    /** IAP-FR-04: expires every stale upload. Returns how many. */
    int expireUploads() throws SQLException;

    List<OpenRun> openRuns() throws SQLException;

    /**
     * The dataset's version that is current now.
     *
     * @throws IllegalArgumentException
     *             when the stored version breaks the shape studio saves
     */
    DatasetVersion currentVersion(String recordTypeId) throws SQLException;

    /**
     * Moves the run from {@code queued} or {@code approved} to {@code validating},
     * records the version and the start, and returns the start, or empty when
     * the run left that state.
     */
    Optional<Instant> startValidating(OpenRun run, int version) throws SQLException;

    boolean quarantine(String runId, String reason, ObjectNode counts) throws SQLException;

    /**
     * Moves a run that passed the decision from {@code validating} to
     * {@code applying}.
     */
    boolean startApplying(String runId) throws SQLException;

    /**
     * Moves a run from {@code applying} to {@code failed}, with the error's class.
     */
    boolean fail(String runId, String reason) throws SQLException;

    /**
     * Puts a run whose validation broke off back where it waited, for the next
     * start.
     */
    boolean abandon(String runId, String waitedAt) throws SQLException;

    /**
     * The type's applied runs that delivered a file, in {@code confirmed_at} order.
     */
    List<AppliedRun> appliedRuns(String recordTypeId) throws SQLException;

    /**
     * The valid rows of the type's last applied snapshot from any source key, or
     * null when it has none (IAP-FR-10).
     */
    Long lastSnapshotValid(String recordTypeId) throws SQLException;

    /** Every tombstone, requested or done. */
    Set<String> tombstones() throws SQLException;
}
