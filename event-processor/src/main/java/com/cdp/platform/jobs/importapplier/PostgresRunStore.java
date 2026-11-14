package com.cdp.platform.jobs.importapplier;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;

import com.cdp.platform.shared.batch.LockGuard;
import com.cdp.platform.shared.db.repositories.ImportRecordTypesTable;
import com.cdp.platform.shared.db.repositories.PersonTombstonesTable;
import com.cdp.platform.shared.models.imports.DatasetVersion;
import com.cdp.platform.shared.utils.JacksonMapper;

import static com.cdp.platform.shared.db.repositories.ImportRunsTable.APPROVED_AT;
import static com.cdp.platform.shared.db.repositories.ImportRunsTable.BYTE_SIZE;
import static com.cdp.platform.shared.db.repositories.ImportRunsTable.CONFIRMED_AT;
import static com.cdp.platform.shared.db.repositories.ImportRunsTable.COUNTS;
import static com.cdp.platform.shared.db.repositories.ImportRunsTable.CREATED_AT;
import static com.cdp.platform.shared.db.repositories.ImportRunsTable.FILE_KEY;
import static com.cdp.platform.shared.db.repositories.ImportRunsTable.FINISHED_AT;
import static com.cdp.platform.shared.db.repositories.ImportRunsTable.FORMAT;
import static com.cdp.platform.shared.db.repositories.ImportRunsTable.ID;
import static com.cdp.platform.shared.db.repositories.ImportRunsTable.REASON;
import static com.cdp.platform.shared.db.repositories.ImportRunsTable.RECORD_TYPE_ID;
import static com.cdp.platform.shared.db.repositories.ImportRunsTable.SOURCE;
import static com.cdp.platform.shared.db.repositories.ImportRunsTable.STARTED_AT;
import static com.cdp.platform.shared.db.repositories.ImportRunsTable.STATE;
import static com.cdp.platform.shared.db.repositories.ImportRunsTable.STORED_SHA256;
import static com.cdp.platform.shared.db.repositories.ImportRunsTable.TABLE_NAME;
import static com.cdp.platform.shared.db.repositories.ImportRunsTable.VERSION;
import static com.cdp.platform.shared.db.repositories.ImportRunsTable.WRITER;

import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * {@link RunStore} on the main Postgres. It writes only {@code import_runs}
 * (IAP-FR-21), and every state change is one conditional update from the
 * state it leaves, so a race with studio changes nothing (IAP-FR-03).
 */
final class PostgresRunStore implements RunStore {

    private final Connection connection;
    private final LockGuard lock;

    PostgresRunStore(Connection connection, LockGuard lock) {
        this.connection = connection;
        this.lock = lock;
    }

    @Override
    public List<Stranded> stranded() throws SQLException {
        String sql = "SELECT %s, %s, %s IS NOT NULL FROM %s WHERE %s IN ('validating', 'applying')"
            .formatted(ID, STATE, APPROVED_AT, TABLE_NAME, STATE);
        List<Stranded> runs = new ArrayList<>();
        try (PreparedStatement statement = connection.prepareStatement(sql);
            ResultSet rows = statement.executeQuery()) {
            while (rows.next()) {
                runs.add(new Stranded(rows.getString(1), rows.getString(2), rows.getBoolean(3)));
            }
        }
        return runs;
    }

    /**
     * Moves a stranded run back to {@code approved} or {@code queued} (IAP-FR-24).
     */
    @Override
    public boolean reset(Stranded run) throws SQLException {
        return transition(run.id(), run.state(), run.approved() ? OpenRun.APPROVED : OpenRun.QUEUED, null, null,
            false);
    }

    /**
     * Moves a run at {@code applying} whose commit marker exists to
     * {@code applied}, with the marker's counts.
     */
    @Override
    public boolean markApplied(String runId, ObjectNode counts) throws SQLException {
        return transition(runId, "applying", "applied", null, counts, true);
    }

    /**
     * IAP-FR-04: every run at {@code uploading} created more than 15 minutes ago.
     * Returns how many.
     */
    @Override
    public int expireUploads() throws SQLException {
        lock.check();
        String sql = ("UPDATE %s SET %s = 'expired', %s = now() WHERE %s = 'uploading' "
            + "AND %s < now() - interval '15 minutes'").formatted(TABLE_NAME, STATE, FINISHED_AT, STATE, CREATED_AT);
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            return statement.executeUpdate();
        }
    }

    @Override
    public List<OpenRun> openRuns() throws SQLException {
        String sql = "SELECT %s, %s, %s, %s, %s, %s, %s, %s, %s, %s FROM %s WHERE %s IN (?, ?, ?, ?)"
            .formatted(ID,
                RECORD_TYPE_ID, STATE, SOURCE, WRITER, FORMAT, BYTE_SIZE, FILE_KEY, STORED_SHA256, CONFIRMED_AT,
                TABLE_NAME, STATE);
        List<OpenRun> runs = new ArrayList<>();
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, OpenRun.QUEUED);
            statement.setString(2, OpenRun.APPROVED);
            statement.setString(3, OpenRun.QUARANTINED);
            statement.setString(4, OpenRun.FAILED);
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    long size = rows.getLong(7);
                    Timestamp confirmed = rows.getTimestamp(10);
                    runs
                        .add(new OpenRun(rows.getString(1), rows.getString(2), rows.getString(3), rows.getString(4),
                            rows.getString(5), rows.getString(6), rows.wasNull() ? null : size, rows.getString(8),
                            rows.getString(9), confirmed == null ? null : confirmed.toInstant()));
                }
            }
        }
        return runs;
    }

    /**
     * The dataset's version that is current now.
     *
     * @throws IllegalArgumentException
     *             when the stored version breaks the shape studio saves
     */
    @Override
    public DatasetVersion currentVersion(String recordTypeId) throws SQLException {
        String sql = ("SELECT t.%s, v.%s, v.%s, v.%s, v.%s, v.%s, v.%s FROM %s t JOIN %s v ON v.%s = t.%s "
            + "AND v.%s = t.%s WHERE t.%s = ?::uuid")
            .formatted(ImportRecordTypesTable.KIND,
                ImportRecordTypesTable.VERSION, ImportRecordTypesTable.VERSION_COLUMNS,
                ImportRecordTypesTable.VERSION_ROLES, ImportRecordTypesTable.VERSION_DELIVERY_MODE,
                ImportRecordTypesTable.VERSION_TIME_ZONE, ImportRecordTypesTable.VERSION_DELIMITER,
                ImportRecordTypesTable.TABLE_NAME, ImportRecordTypesTable.VERSIONS_TABLE_NAME,
                ImportRecordTypesTable.VERSION_RECORD_TYPE_ID, ImportRecordTypesTable.ID,
                ImportRecordTypesTable.VERSION, ImportRecordTypesTable.CURRENT_VERSION, ImportRecordTypesTable.ID);
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, recordTypeId);
            try (ResultSet row = statement.executeQuery()) {
                if (!row.next()) throw new IllegalArgumentException("dataset has no current version");
                return DatasetVersion
                    .parse(recordTypeId, row.getInt(2), row.getString(1),
                        JacksonMapper.readTree(row.getString(3)), JacksonMapper.readTree(row.getString(4)),
                        row.getString(5), row.getString(6), row.getString(7));
            }
        }
    }

    /**
     * Moves the run from {@code queued} or {@code approved} to {@code validating},
     * records the version and the start, and returns the start, or empty when
     * the run left that state.
     */
    @Override
    public Optional<Instant> startValidating(OpenRun run, int version) throws SQLException {
        lock.check();
        String sql = ("UPDATE %s SET %s = 'validating', %s = ?, %s = now(), %s = NULL, %s = NULL "
            + "WHERE %s = ?::uuid AND %s = ? RETURNING %s")
            .formatted(TABLE_NAME, STATE, VERSION, STARTED_AT,
                FINISHED_AT, REASON, ID, STATE, STARTED_AT);
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setInt(1, version);
            statement.setString(2, run.id());
            statement.setString(3, run.state());
            try (ResultSet row = statement.executeQuery()) {
                return row.next() ? Optional.of(row.getTimestamp(1).toInstant()) : Optional.empty();
            }
        }
    }

    @Override
    public boolean quarantine(String runId, String reason, ObjectNode counts) throws SQLException {
        return transition(runId, "validating", OpenRun.QUARANTINED, reason, counts, true);
    }

    @Override
    public boolean startApplying(String runId) throws SQLException {
        return transition(runId, "validating", "applying", null, null, false);
    }

    @Override
    public boolean fail(String runId, String reason) throws SQLException {
        return transition(runId, "applying", OpenRun.FAILED, reason, null, true);
    }

    @Override
    public List<AppliedRun> appliedRuns(String recordTypeId) throws SQLException {
        String sql = ("SELECT %s, %s, %s, %s, %s, %s, %s, %s FROM %s WHERE %s = ?::uuid AND %s = 'applied' "
            + "AND %s <> 'rederive' ORDER BY %s, %s")
            .formatted(ID, SOURCE, WRITER, FORMAT, BYTE_SIZE, FILE_KEY,
                STORED_SHA256, STARTED_AT, TABLE_NAME, RECORD_TYPE_ID, STATE, SOURCE, CONFIRMED_AT, ID);
        List<AppliedRun> runs = new ArrayList<>();
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, recordTypeId);
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    long size = rows.getLong(5);
                    Long byteSize = rows.wasNull() ? null : size;
                    Timestamp started = rows.getTimestamp(8);
                    runs
                        .add(new AppliedRun(rows.getString(1), rows.getString(2), rows.getString(3),
                            rows.getString(4), byteSize, rows.getString(6), rows.getString(7),
                            started == null ? null : started.toInstant()));
                }
            }
        }
        return runs;
    }

    /**
     * Puts a run whose validation broke off back where it waited, for the next
     * start.
     */
    @Override
    public boolean abandon(String runId, String waitedAt) throws SQLException {
        return transition(runId, "validating", waitedAt, null, null, false);
    }

    private boolean transition(String runId, String from, String to, String reason, ObjectNode counts,
        boolean finished) throws SQLException {
        lock.check();
        String sql = "UPDATE %s SET %s = ?, %s = ?, %s = COALESCE(?::jsonb, %s), %s = %s WHERE %s = ?::uuid AND %s = ?"
            .formatted(TABLE_NAME, STATE, REASON, COUNTS, COUNTS, FINISHED_AT, finished ? "now()" : "NULL", ID,
                STATE);
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, to);
            statement.setString(2, reason);
            statement.setString(3, counts == null ? null : JacksonMapper.writeValueAsString(counts));
            statement.setString(4, runId);
            statement.setString(5, from);
            return statement.executeUpdate() == 1;
        }
    }

    /**
     * The valid rows of the type's last applied snapshot from any source key, or
     * null when it has none (IAP-FR-10).
     */
    @Override
    public Long lastSnapshotValid(String recordTypeId) throws SQLException {
        String sql = ("SELECT (r.%s->>'valid')::bigint FROM %s r JOIN %s v ON v.%s = r.%s AND v.%s = r.%s "
            + "WHERE r.%s = ?::uuid AND r.%s = 'applied' AND r.%s IN ('api', 'drop') AND v.%s = 'snapshot' "
            + "ORDER BY r.%s DESC NULLS LAST LIMIT 1")
            .formatted(COUNTS, TABLE_NAME,
                ImportRecordTypesTable.VERSIONS_TABLE_NAME, ImportRecordTypesTable.VERSION_RECORD_TYPE_ID,
                RECORD_TYPE_ID, ImportRecordTypesTable.VERSION, VERSION, RECORD_TYPE_ID, STATE, SOURCE,
                ImportRecordTypesTable.VERSION_DELIVERY_MODE, FINISHED_AT);
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, recordTypeId);
            try (ResultSet row = statement.executeQuery()) {
                if (!row.next()) return null;
                long valid = row.getLong(1);
                return row.wasNull() ? null : valid;
            }
        }
    }

    /** Every tombstone, requested or done. */
    @Override
    public Set<String> tombstones() throws SQLException {
        String sql = "SELECT %s FROM %s"
            .formatted(PersonTombstonesTable.CUSTOMER_KEY_HASH,
                PersonTombstonesTable.TABLE_NAME);
        Set<String> hashes = new HashSet<>();
        try (PreparedStatement statement = connection.prepareStatement(sql);
            ResultSet rows = statement.executeQuery()) {
            while (rows.next()) {
                hashes.add(rows.getString(1));
            }
        }
        return hashes;
    }
}
