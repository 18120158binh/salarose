package com.cdp.platform.jobs.importmetricpass;

import java.sql.SQLException;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;

import com.cdp.platform.shared.models.imports.DatasetVersion;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * One repeatable-read, read-only transaction on the import store (IMP-FR-03,
 * IMP-FR-16). Every read of a pass goes through one snapshot, and
 * {@link #close} ends it before the pass publishes.
 */
interface ImportSnapshot extends AutoCloseable {

    /** A commit marker: an applied run the snapshot holds. */
    record Commit(String runId, Instant committedAt) {
    }

    /**
     * A customer's computed values of one event dataset, keyed by metric name,
     * already in their attribute form. A metric with no value is absent.
     */
    record EventRow(String customerKey, Map<String, JsonNode> values) {
    }

    /** A customer's profile row, and the normalized identifiers it holds. */
    record ProfileRow(String customerKey, JsonNode data, List<String> emails, List<String> phones) {
    }

    /** Opens a snapshot. */
    interface Opener {
        ImportSnapshot open() throws SQLException;
    }

    List<Commit> commits() throws SQLException;

    /**
     * Streams one row per customer with a record of the dataset. A definition
     * that names a column the version lacks goes in {@code unusable}.
     */
    void events(DatasetVersion version, List<MetricDefinition> active, Instant asOf, List<MetricDefinition> unusable,
        Consumer<EventRow> each) throws SQLException;

    void profiles(String recordTypeId, Consumer<ProfileRow> each) throws SQLException;

    /**
     * Emails and phones held by two or more customer keys across every profile
     * dataset, as {@code email:<value>} and {@code phone:<value>}.
     */
    Set<String> sharedIdentifiers() throws SQLException;

    @Override
    void close() throws SQLException;
}
