package com.cdp.platform.jobs.importmetricpass;

import java.sql.SQLException;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import com.cdp.platform.shared.batch.WalGovernor;
import com.cdp.platform.shared.models.imports.DatasetVersion;

import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * What the pass reads and writes on the main Postgres: its rows in
 * {@code import_metric_passes}, the datasets and metric definitions,
 * {@code customer_attributes}, {@code person_tombstones}, and
 * {@code import_runs.first_pass_id}. Each pass transition is a conditional
 * update from the state it leaves.
 */
interface PassLedger {

    /** A dataset and its current version. Its name is the attribute source. */
    record Dataset(String id, String name, DatasetVersion version) {
    }

    record RowKey(String customerKey, String sourceId) {
    }

    /**
     * A stored row's hash, and the archived metrics' keys and values it holds, or
     * null when its source has no archived metric.
     */
    record Stored(String hash, ObjectNode archived) {
    }

    /** A built row whose hash differs from the stored one. */
    record Staged(RowKey key, String attributes, String hash) {
    }

    /** Rows a statement changed, and the WAL it wrote. */
    record Written(long rows, long walBytes) {
    }

    record Attempt(UUID id, Instant asOf) {
    }

    /** What a pass records when it ends, at {@code done} or {@code failed}. */
    record Outcome(long changedRows, long walBytes, ObjectNode counts, List<WalGovernor.Pause> pauses,
        Optional<Instant> lastRunFinishedAt) {
    }

    /**
     * Moves every pass at {@code running} to {@code failed} with reason
     * {@code crashed}.
     */
    int failRunning() throws SQLException;

    /**
     * Inserts a pass at {@code running}, or returns empty when the {@code as_of} is
     * taken.
     */
    Optional<UUID> insert(Instant asOf) throws SQLException;

    /**
     * Failed passes with {@code retry_requested_at}, latest {@code as_of} first.
     */
    List<Attempt> retryRequests() throws SQLException;

    /** Whether a pass with a later {@code as_of} is {@code done} (IMP-FR-18). */
    boolean laterDone(Instant asOf) throws SQLException;

    /** Clears the stamp of a refused retry. */
    void refuseRetry(UUID id) throws SQLException;

    /** Moves a stamped failed pass to {@code running} and clears the stamp. */
    boolean startRetry(UUID id) throws SQLException;

    /**
     * Datasets whose current version parses. The names of the others go in
     * {@code unreadable}, and the pass leaves their rows alone.
     */
    List<Dataset> datasets(Set<String> unreadable) throws SQLException;

    /** Definitions that parse. */
    List<MetricDefinition> definitions() throws SQLException;

    /**
     * Every stored row. For a source in {@code archivedBySource}, the row's keys
     * of those names come with it.
     */
    Map<RowKey, Stored> storedRows(Map<String, Set<String>> archivedBySource) throws SQLException;

    Set<String> tombstoneHashes() throws SQLException;

    Written upsert(UUID passId, List<Staged> rows) throws SQLException;

    Written delete(List<RowKey> rows) throws SQLException;

    /** Deletes every row of these customer keys. */
    Written deleteCustomers(Collection<String> customerKeys) throws SQLException;

    /**
     * Moves the pass to {@code done}, and sets {@code first_pass_id} on each
     * included run that has none, in one transaction (IMP-FR-04).
     */
    void finish(UUID passId, Outcome outcome, Collection<String> runIds) throws SQLException;

    void fail(UUID passId, String reason, Outcome outcome) throws SQLException;
}
