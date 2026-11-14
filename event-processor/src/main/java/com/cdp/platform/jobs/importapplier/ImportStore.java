package com.cdp.platform.jobs.importapplier;

import java.sql.SQLException;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import com.cdp.platform.shared.models.imports.DatasetVersion.Kind;

import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * The applier's writes to the import store. Every write between
 * {@link #begin} and {@link #commit} or {@link #rollback} is one transaction,
 * so a crash at any point leaves the store as the last commit left it
 * (IAP-FR-15). A key is a record id for {@link Kind#EVENT} and a customer key
 * for {@link Kind#PROFILE}. The rules that decide what to write live in
 * {@link RunApply}. This interface only reads and writes rows by key.
 */
interface ImportStore {

    /** A stored row: its values and the writer that last delivered it. */
    record Stored(ObjectNode data, String writer) {
    }

    /**
     * A row to write, in full. For a profile, {@code emails} and {@code phones}
     * replace the customer's identifiers of the type.
     */
    record Row(String key, String customerKey, Instant eventTime, Instant updatedAt, ObjectNode data,
        List<String> emails, List<String> phones) {
    }

    void begin() throws SQLException;

    /** The stored rows of the keys that the store holds. */
    Map<String, Stored> stored(Kind kind, String recordTypeId, Collection<String> keys) throws SQLException;

    /** Inserts or replaces each row, with the writer and run id. */
    void write(Kind kind, String recordTypeId, List<Row> rows, String writer, String runId) throws SQLException;

    /** Removes the rows of the keys, and a profile's identifiers. */
    void remove(Kind kind, String recordTypeId, Collection<String> keys) throws SQLException;

    /** Marks keys the current snapshot holds. */
    void keep(Collection<String> keys) throws SQLException;

    /**
     * Removes every row of the type whose key {@link #keep} did not mark and
     * whose writer is not {@code spared}, then forgets the marks. Returns how
     * many rows it removed.
     */
    long removeUnkept(Kind kind, String recordTypeId, String spared) throws SQLException;

    /** Removes every row of the type from every table, for a re-derive. */
    void clear(String recordTypeId) throws SQLException;

    /** The rows {@code import_records} holds, uncommitted writes included. */
    long records() throws SQLException;

    /** Writes the run's commit marker with its counts, and commits. */
    void commit(String runId, String recordTypeId, ObjectNode counts) throws SQLException;

    void rollback() throws SQLException;

    /** The counts of the run's commit marker, or empty when it has none. */
    Optional<ObjectNode> commitMarker(String runId) throws SQLException;
}
