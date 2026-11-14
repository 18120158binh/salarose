package com.cdp.platform.jobs.importapplier;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import com.cdp.platform.shared.db.repositories.ImportIdentifiersTable;
import com.cdp.platform.shared.db.repositories.ImportProfilesTable;
import com.cdp.platform.shared.db.repositories.ImportRecordsTable;
import com.cdp.platform.shared.db.repositories.ImportRunCommitsTable;
import com.cdp.platform.shared.models.imports.DatasetVersion.Kind;
import com.cdp.platform.shared.utils.JacksonMapper;

import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * {@link ImportStore} on the import store's Postgres, over one connection that
 * the lookups share. Outside a transaction the connection autocommits, so the
 * lookups read committed rows.
 */
final class PostgresImportStore implements ImportStore {

    // The keys a snapshot holds. A temporary table lives in the transaction that
    // creates it, so a rollback or a crash drops it with the writes.
    private static final String KEEP = "import_applier_keep";

    private final Connection connection;

    PostgresImportStore(Connection connection) {
        this.connection = connection;
    }

    @Override
    public void begin() throws SQLException {
        connection.setAutoCommit(false);
    }

    @Override
    public Map<String, Stored> stored(Kind kind, String recordTypeId, Collection<String> keys) throws SQLException {
        String sql = "SELECT %s, %s::text, %s FROM %s WHERE %s = ?::uuid AND %s = ANY(?)"
            .formatted(keyColumn(kind), dataColumn(kind), writerColumn(kind), table(kind), typeColumn(kind),
                keyColumn(kind));
        Map<String, Stored> stored = new HashMap<>();
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, recordTypeId);
            statement.setArray(2, connection.createArrayOf("text", keys.toArray()));
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    stored
                        .put(rows.getString(1),
                            new Stored((ObjectNode) JacksonMapper.readTree(rows.getString(2)), rows.getString(3)));
                }
            }
        }
        return stored;
    }

    @Override
    public void write(Kind kind, String recordTypeId, List<Row> rows, String writer, String runId)
        throws SQLException {
        if (kind == Kind.EVENT) {
            writeRecords(recordTypeId, rows, writer, runId);
        } else {
            writeProfiles(recordTypeId, rows, writer, runId);
        }
    }

    private void writeRecords(String recordTypeId, List<Row> rows, String writer, String runId)
        throws SQLException {
        String sql = ("INSERT INTO %s (%s, %s, %s, %s, %s, %s, %s, %s) VALUES (?::uuid, ?, ?, ?, ?, ?::jsonb, ?, ?::uuid) "
            + "ON CONFLICT (%s, %s) DO UPDATE SET %s = EXCLUDED.%s, %s = EXCLUDED.%s, %s = EXCLUDED.%s, "
            + "%s = EXCLUDED.%s, %s = EXCLUDED.%s, %s = EXCLUDED.%s")
            .formatted(ImportRecordsTable.TABLE_NAME,
                ImportRecordsTable.RECORD_TYPE_ID, ImportRecordsTable.RECORD_ID, ImportRecordsTable.CUSTOMER_KEY,
                ImportRecordsTable.EVENT_TIME, ImportRecordsTable.UPDATED_AT, ImportRecordsTable.DATA,
                ImportRecordsTable.WRITER, ImportRecordsTable.RUN_ID, ImportRecordsTable.RECORD_TYPE_ID,
                ImportRecordsTable.RECORD_ID, ImportRecordsTable.CUSTOMER_KEY, ImportRecordsTable.CUSTOMER_KEY,
                ImportRecordsTable.EVENT_TIME, ImportRecordsTable.EVENT_TIME, ImportRecordsTable.UPDATED_AT,
                ImportRecordsTable.UPDATED_AT, ImportRecordsTable.DATA, ImportRecordsTable.DATA,
                ImportRecordsTable.WRITER, ImportRecordsTable.WRITER, ImportRecordsTable.RUN_ID,
                ImportRecordsTable.RUN_ID);
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            for (Row row : rows) {
                statement.setString(1, recordTypeId);
                statement.setString(2, row.key());
                statement.setString(3, row.customerKey());
                statement.setObject(4, utc(row.eventTime()));
                if (row.updatedAt() == null) {
                    statement.setNull(5, Types.TIMESTAMP_WITH_TIMEZONE);
                } else {
                    statement.setObject(5, utc(row.updatedAt()));
                }
                statement.setString(6, JacksonMapper.writeValueAsString(row.data()));
                statement.setString(7, writer);
                statement.setString(8, runId);
                statement.addBatch();
            }
            statement.executeBatch();
        }
    }

    private void writeProfiles(String recordTypeId, List<Row> rows, String writer, String runId)
        throws SQLException {
        String upsert = ("INSERT INTO %s (%s, %s, %s, %s, %s) VALUES (?::uuid, ?, ?::jsonb, ?, ?::uuid) "
            + "ON CONFLICT (%s, %s) DO UPDATE SET %s = EXCLUDED.%s, %s = EXCLUDED.%s, %s = EXCLUDED.%s")
            .formatted(ImportProfilesTable.TABLE_NAME,
                ImportProfilesTable.RECORD_TYPE_ID, ImportProfilesTable.CUSTOMER_KEY, ImportProfilesTable.DATA,
                ImportProfilesTable.WRITER, ImportProfilesTable.RUN_ID, ImportProfilesTable.RECORD_TYPE_ID,
                ImportProfilesTable.CUSTOMER_KEY, ImportProfilesTable.DATA, ImportProfilesTable.DATA,
                ImportProfilesTable.WRITER, ImportProfilesTable.WRITER, ImportProfilesTable.RUN_ID,
                ImportProfilesTable.RUN_ID);
        try (PreparedStatement statement = connection.prepareStatement(upsert)) {
            for (Row row : rows) {
                statement.setString(1, recordTypeId);
                statement.setString(2, row.key());
                statement.setString(3, JacksonMapper.writeValueAsString(row.data()));
                statement.setString(4, writer);
                statement.setString(5, runId);
                statement.addBatch();
            }
            statement.executeBatch();
        }
        removeIdentifiers(recordTypeId, rows.stream().map(Row::key).toList());
        String insert = "INSERT INTO %s (%s, %s, %s, %s, %s, %s) VALUES (?::uuid, ?, ?, ?, ?, ?::uuid)"
            .formatted(ImportIdentifiersTable.TABLE_NAME, ImportIdentifiersTable.RECORD_TYPE_ID,
                ImportIdentifiersTable.CUSTOMER_KEY, ImportIdentifiersTable.TYPE, ImportIdentifiersTable.VALUE,
                ImportIdentifiersTable.WRITER, ImportIdentifiersTable.RUN_ID);
        try (PreparedStatement statement = connection.prepareStatement(insert)) {
            for (Row row : rows) {
                for (String email : row.emails()) {
                    addIdentifier(statement, recordTypeId, row.key(), "email", email, writer, runId);
                }
                for (String phone : row.phones()) {
                    addIdentifier(statement, recordTypeId, row.key(), "phone", phone, writer, runId);
                }
            }
            statement.executeBatch();
        }
    }

    private static void addIdentifier(PreparedStatement statement, String recordTypeId, String customerKey,
        String type, String value, String writer, String runId) throws SQLException {
        statement.setString(1, recordTypeId);
        statement.setString(2, customerKey);
        statement.setString(3, type);
        statement.setString(4, value);
        statement.setString(5, writer);
        statement.setString(6, runId);
        statement.addBatch();
    }

    @Override
    public void remove(Kind kind, String recordTypeId, Collection<String> keys) throws SQLException {
        String sql = "DELETE FROM %s WHERE %s = ?::uuid AND %s = ANY(?)"
            .formatted(table(kind), typeColumn(kind),
                keyColumn(kind));
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, recordTypeId);
            statement.setArray(2, connection.createArrayOf("text", keys.toArray()));
            statement.executeUpdate();
        }
        if (kind == Kind.PROFILE) removeIdentifiers(recordTypeId, keys);
    }

    private void removeIdentifiers(String recordTypeId, Collection<String> customerKeys) throws SQLException {
        String sql = "DELETE FROM %s WHERE %s = ?::uuid AND %s = ANY(?)"
            .formatted(ImportIdentifiersTable.TABLE_NAME,
                ImportIdentifiersTable.RECORD_TYPE_ID, ImportIdentifiersTable.CUSTOMER_KEY);
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, recordTypeId);
            statement.setArray(2, connection.createArrayOf("text", customerKeys.toArray()));
            statement.executeUpdate();
        }
    }

    @Override
    public void keep(Collection<String> keys) throws SQLException {
        createKeep();
        String sql = "INSERT INTO %s (key) SELECT unnest(?::text[]) ON CONFLICT DO NOTHING".formatted(KEEP);
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setArray(1, connection.createArrayOf("text", keys.toArray()));
            statement.executeUpdate();
        }
    }

    @Override
    public long removeUnkept(Kind kind, String recordTypeId, String spared) throws SQLException {
        createKeep();
        String gone = ("DELETE FROM %s s WHERE s.%s = ?::uuid AND s.%s <> ? "
            + "AND NOT EXISTS (SELECT 1 FROM %s k WHERE k.key = s.%s) RETURNING s.%s")
            .formatted(table(kind), typeColumn(kind),
                writerColumn(kind), KEEP, keyColumn(kind), keyColumn(kind));
        String sql = kind == Kind.EVENT
            ? "WITH gone AS (%s) SELECT count(*) FROM gone".formatted(gone)
            : ("WITH gone AS (%s), ids AS (DELETE FROM %s i USING gone WHERE i.%s = ?::uuid AND i.%s = gone.%s "
                + "RETURNING 1) SELECT count(*) FROM gone")
                .formatted(gone, ImportIdentifiersTable.TABLE_NAME, ImportIdentifiersTable.RECORD_TYPE_ID,
                    ImportIdentifiersTable.CUSTOMER_KEY, ImportProfilesTable.CUSTOMER_KEY);
        long removed;
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, recordTypeId);
            statement.setString(2, spared);
            if (kind == Kind.PROFILE) statement.setString(3, recordTypeId);
            try (ResultSet row = statement.executeQuery()) {
                row.next();
                removed = row.getLong(1);
            }
        }
        try (Statement statement = connection.createStatement()) {
            statement.execute("TRUNCATE " + KEEP);
        }
        return removed;
    }

    private void createKeep() throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement
                .execute("CREATE TEMPORARY TABLE IF NOT EXISTS %s (key text PRIMARY KEY) ON COMMIT DROP"
                    .formatted(KEEP));
        }
    }

    @Override
    public void clear(String recordTypeId) throws SQLException {
        for (String table : List
            .of(ImportRecordsTable.TABLE_NAME, ImportProfilesTable.TABLE_NAME, ImportIdentifiersTable.TABLE_NAME)) {
            try (PreparedStatement statement = connection
                .prepareStatement(
                    "DELETE FROM %s WHERE %s = ?::uuid".formatted(table, ImportRecordsTable.RECORD_TYPE_ID))) {
                statement.setString(1, recordTypeId);
                statement.executeUpdate();
            }
        }
    }

    @Override
    public long records() throws SQLException {
        try (PreparedStatement statement = connection
            .prepareStatement("SELECT count(*) FROM " + ImportRecordsTable.TABLE_NAME);
            ResultSet row = statement.executeQuery()) {
            row.next();
            return row.getLong(1);
        }
    }

    @Override
    public void commit(String runId, String recordTypeId, ObjectNode counts) throws SQLException {
        String sql = "INSERT INTO %s (%s, %s, %s) VALUES (?::uuid, ?::uuid, ?::jsonb)"
            .formatted(ImportRunCommitsTable.TABLE_NAME, ImportRunCommitsTable.RUN_ID,
                ImportRunCommitsTable.RECORD_TYPE_ID, ImportRunCommitsTable.COUNTS);
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, runId);
            statement.setString(2, recordTypeId);
            statement.setString(3, JacksonMapper.writeValueAsString(counts));
            statement.executeUpdate();
        }
        connection.commit();
        connection.setAutoCommit(true);
    }

    @Override
    public void rollback() throws SQLException {
        if (connection.getAutoCommit()) return;
        connection.rollback();
        connection.setAutoCommit(true);
    }

    @Override
    public Optional<ObjectNode> commitMarker(String runId) throws SQLException {
        String sql = "SELECT %s FROM %s WHERE %s = ?::uuid"
            .formatted(ImportRunCommitsTable.COUNTS,
                ImportRunCommitsTable.TABLE_NAME, ImportRunCommitsTable.RUN_ID);
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, runId);
            try (ResultSet row = statement.executeQuery()) {
                return row.next()
                    ? Optional.of((ObjectNode) JacksonMapper.readTree(row.getString(1)))
                    : Optional.empty();
            }
        }
    }

    private static OffsetDateTime utc(Instant instant) {
        return instant.atOffset(ZoneOffset.UTC);
    }

    private static String table(Kind kind) {
        return kind == Kind.EVENT ? ImportRecordsTable.TABLE_NAME : ImportProfilesTable.TABLE_NAME;
    }

    private static String keyColumn(Kind kind) {
        return kind == Kind.EVENT ? ImportRecordsTable.RECORD_ID : ImportProfilesTable.CUSTOMER_KEY;
    }

    private static String typeColumn(Kind kind) {
        return kind == Kind.EVENT ? ImportRecordsTable.RECORD_TYPE_ID : ImportProfilesTable.RECORD_TYPE_ID;
    }

    private static String dataColumn(Kind kind) {
        return kind == Kind.EVENT ? ImportRecordsTable.DATA : ImportProfilesTable.DATA;
    }

    private static String writerColumn(Kind kind) {
        return kind == Kind.EVENT ? ImportRecordsTable.WRITER : ImportProfilesTable.WRITER;
    }
}
