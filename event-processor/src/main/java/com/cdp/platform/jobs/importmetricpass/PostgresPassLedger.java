package com.cdp.platform.jobs.importmetricpass;

import java.sql.Array;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import com.cdp.platform.shared.batch.WalGovernor;
import com.cdp.platform.shared.db.repositories.CustomerAttributesTable;
import com.cdp.platform.shared.db.repositories.ImportMetricDefinitionsTable;
import com.cdp.platform.shared.db.repositories.ImportMetricPassesTable;
import com.cdp.platform.shared.db.repositories.ImportRecordTypesTable;
import com.cdp.platform.shared.db.repositories.ImportRunsTable;
import com.cdp.platform.shared.db.repositories.PersonTombstonesTable;
import com.cdp.platform.shared.models.imports.DatasetVersion;
import com.cdp.platform.shared.utils.JacksonMapper;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The pass's reads and writes on the main Postgres, over one connection in
 * autocommit. Each write to {@code customer_attributes} runs inside
 * {@code EXPLAIN (ANALYZE, WAL, FORMAT JSON)}, which executes it and reports
 * the WAL it wrote, so the pass measures its own WAL on Postgres 16 with no
 * extension loaded.
 */
final class PostgresPassLedger implements PassLedger {

    private static final Logger LOG = LoggerFactory.getLogger(PostgresPassLedger.class);
    private static final int FETCH_SIZE = 5000;

    private static final String PASSES = ImportMetricPassesTable.TABLE_NAME;
    private static final String STATE = ImportMetricPassesTable.STATE;
    private static final String AS_OF = ImportMetricPassesTable.AS_OF;
    private static final String ID = ImportMetricPassesTable.ID;
    private static final String RETRY = ImportMetricPassesTable.RETRY_REQUESTED_AT;
    private static final String RUNNING = "'" + ImportMetricPassesTable.RUNNING + "'";
    private static final String DONE = "'" + ImportMetricPassesTable.DONE + "'";
    private static final String FAILED = "'" + ImportMetricPassesTable.FAILED + "'";

    private static final String FAIL_RUNNING = "UPDATE " + PASSES + " SET " + STATE + " = " + FAILED + ", "
        + ImportMetricPassesTable.REASON + " = 'crashed', " + ImportMetricPassesTable.FINISHED_AT + " = now() WHERE "
        + STATE + " = " + RUNNING;
    private static final String INSERT = "INSERT INTO " + PASSES + " (" + AS_OF + ", " + STATE + ") VALUES (?, "
        + RUNNING + ") ON CONFLICT (" + AS_OF + ") DO NOTHING RETURNING " + ID;
    private static final String RETRY_REQUESTS = "SELECT " + ID + ", " + AS_OF + " FROM " + PASSES + " WHERE "
        + STATE + " = " + FAILED + " AND " + RETRY + " IS NOT NULL ORDER BY " + AS_OF + " DESC";
    private static final String LATER_DONE = "SELECT EXISTS (SELECT 1 FROM " + PASSES + " WHERE " + STATE + " = "
        + DONE + " AND " + AS_OF + " > ?)";
    private static final String REFUSE_RETRY = "UPDATE " + PASSES + " SET " + RETRY + " = NULL WHERE " + ID
        + " = ?::uuid AND " + STATE + " = " + FAILED;
    // The IMP-FR-18 check repeats here, so a pass that reaches done meanwhile still
    // refuses the retry.
    private static final String START_RETRY = "UPDATE " + PASSES + " p SET " + STATE + " = " + RUNNING + ", " + RETRY
        + " = NULL, " + ImportMetricPassesTable.REASON + " = NULL, " + ImportMetricPassesTable.STARTED_AT
        + " = now(), " + ImportMetricPassesTable.FINISHED_AT + " = NULL WHERE p." + ID + " = ?::uuid AND p." + STATE
        + " = " + FAILED + " AND p." + RETRY + " IS NOT NULL AND NOT EXISTS (SELECT 1 FROM " + PASSES + " d WHERE d."
        + STATE + " = " + DONE + " AND d." + AS_OF + " > p." + AS_OF + ")";
    private static final String END = "UPDATE " + PASSES + " SET " + STATE + " = ?, "
        + ImportMetricPassesTable.REASON + " = ?, " + ImportMetricPassesTable.CHANGED_ROWS + " = ?, "
        + ImportMetricPassesTable.WAL_BYTES + " = ?, " + ImportMetricPassesTable.COUNTS + " = ?::jsonb, "
        + ImportMetricPassesTable.PAUSES + " = ?::jsonb, " + ImportMetricPassesTable.LAST_RUN_FINISHED_AT + " = ?, "
        + ImportMetricPassesTable.FINISHED_AT + " = now() WHERE " + ID + " = ?::uuid AND " + STATE + " = " + RUNNING;
    private static final String FIRST_PASS = "UPDATE " + ImportRunsTable.TABLE_NAME + " SET "
        + ImportRunsTable.FIRST_PASS_ID + " = ?::uuid WHERE " + ImportRunsTable.ID + " = ANY(?::uuid[]) AND "
        + ImportRunsTable.FIRST_PASS_ID + " IS NULL";

    private static final String DATASETS = "SELECT t." + ImportRecordTypesTable.ID + ", t."
        + ImportRecordTypesTable.NAME + ", t." + ImportRecordTypesTable.KIND + ", v."
        + ImportRecordTypesTable.VERSION + ", v." + ImportRecordTypesTable.VERSION_COLUMNS + ", v."
        + ImportRecordTypesTable.VERSION_ROLES + ", v." + ImportRecordTypesTable.VERSION_DELIVERY_MODE + ", v."
        + ImportRecordTypesTable.VERSION_TIME_ZONE + ", v." + ImportRecordTypesTable.VERSION_DELIMITER + " FROM "
        + ImportRecordTypesTable.TABLE_NAME + " t JOIN " + ImportRecordTypesTable.VERSIONS_TABLE_NAME + " v ON v."
        + ImportRecordTypesTable.VERSION_RECORD_TYPE_ID + " = t." + ImportRecordTypesTable.ID + " AND v."
        + ImportRecordTypesTable.VERSION + " = t." + ImportRecordTypesTable.CURRENT_VERSION;
    private static final String DEFINITIONS = "SELECT " + ImportMetricDefinitionsTable.ID + ", "
        + ImportMetricDefinitionsTable.RECORD_TYPE_ID + ", " + ImportMetricDefinitionsTable.NAME + ", "
        + ImportMetricDefinitionsTable.FUNCTION + ", " + ImportMetricDefinitionsTable.COLUMN + ", "
        + ImportMetricDefinitionsTable.FILTERS + ", " + ImportMetricDefinitionsTable.WINDOW_DAYS + ", "
        + ImportMetricDefinitionsTable.ARCHIVED_AT + " IS NOT NULL FROM " + ImportMetricDefinitionsTable.TABLE_NAME;
    private static final String STORED = "SELECT " + CustomerAttributesTable.CUSTOMER_KEY + ", "
        + CustomerAttributesTable.SOURCE_ID + ", " + CustomerAttributesTable.ATTRIBUTES_HASH + ", CASE WHEN "
        + CustomerAttributesTable.SOURCE_ID + " = ANY(?::text[]) THEN " + CustomerAttributesTable.ATTRIBUTES
        + " END FROM " + CustomerAttributesTable.TABLE_NAME;
    private static final String TOMBSTONES = "SELECT " + PersonTombstonesTable.CUSTOMER_KEY_HASH + " FROM "
        + PersonTombstonesTable.TABLE_NAME;

    private static final String EXPLAIN = "EXPLAIN (ANALYZE, WAL, FORMAT JSON) ";
    // Only a changed hash rewrites a row, so a retry converges on the rows a clean
    // pass writes.
    private static final String UPSERT = "INSERT INTO " + CustomerAttributesTable.TABLE_NAME + " ("
        + CustomerAttributesTable.CUSTOMER_KEY + ", " + CustomerAttributesTable.SOURCE_ID + ", "
        + CustomerAttributesTable.ATTRIBUTES + ", " + CustomerAttributesTable.ATTRIBUTES_HASH + ", "
        + CustomerAttributesTable.PASS_ID + ", " + CustomerAttributesTable.UPDATED_AT
        + ") SELECT k, s, a::jsonb, h, ?::uuid, now() FROM unnest(?::text[], ?::text[], ?::text[], ?::text[])"
        + " AS t(k, s, a, h) ON CONFLICT (" + CustomerAttributesTable.CUSTOMER_KEY + ", "
        + CustomerAttributesTable.SOURCE_ID + ") DO UPDATE SET " + CustomerAttributesTable.ATTRIBUTES
        + " = EXCLUDED." + CustomerAttributesTable.ATTRIBUTES + ", " + CustomerAttributesTable.ATTRIBUTES_HASH
        + " = EXCLUDED." + CustomerAttributesTable.ATTRIBUTES_HASH + ", " + CustomerAttributesTable.PASS_ID
        + " = EXCLUDED." + CustomerAttributesTable.PASS_ID + ", " + CustomerAttributesTable.UPDATED_AT
        + " = EXCLUDED." + CustomerAttributesTable.UPDATED_AT + " WHERE " + CustomerAttributesTable.TABLE_NAME + "."
        + CustomerAttributesTable.ATTRIBUTES_HASH + " <> EXCLUDED." + CustomerAttributesTable.ATTRIBUTES_HASH;
    private static final String DELETE_ROWS = "DELETE FROM " + CustomerAttributesTable.TABLE_NAME
        + " c USING unnest(?::text[], ?::text[]) AS t(k, s) WHERE c." + CustomerAttributesTable.CUSTOMER_KEY
        + " = t.k AND c." + CustomerAttributesTable.SOURCE_ID + " = t.s";
    private static final String DELETE_CUSTOMERS = "DELETE FROM " + CustomerAttributesTable.TABLE_NAME + " WHERE "
        + CustomerAttributesTable.CUSTOMER_KEY + " = ANY(?::text[])";

    private final Connection connection;

    PostgresPassLedger(Connection connection) {
        this.connection = connection;
    }

    @Override
    public int failRunning() throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(FAIL_RUNNING)) {
            return statement.executeUpdate();
        }
    }

    @Override
    public Optional<UUID> insert(Instant asOf) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(INSERT)) {
            statement.setTimestamp(1, Timestamp.from(asOf));
            try (ResultSet row = statement.executeQuery()) {
                return row.next() ? Optional.of(row.getObject(1, UUID.class)) : Optional.empty();
            }
        }
    }

    @Override
    public List<Attempt> retryRequests() throws SQLException {
        List<Attempt> attempts = new ArrayList<>();
        try (PreparedStatement statement = connection.prepareStatement(RETRY_REQUESTS);
            ResultSet rows = statement.executeQuery()) {
            while (rows.next()) {
                attempts.add(new Attempt(rows.getObject(1, UUID.class), rows.getTimestamp(2).toInstant()));
            }
        }
        return attempts;
    }

    @Override
    public boolean laterDone(Instant asOf) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(LATER_DONE)) {
            statement.setTimestamp(1, Timestamp.from(asOf));
            try (ResultSet row = statement.executeQuery()) {
                row.next();
                return row.getBoolean(1);
            }
        }
    }

    @Override
    public void refuseRetry(UUID id) throws SQLException {
        update(REFUSE_RETRY, id);
    }

    @Override
    public boolean startRetry(UUID id) throws SQLException {
        return update(START_RETRY, id) == 1;
    }

    private int update(String sql, UUID id) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, id.toString());
            return statement.executeUpdate();
        }
    }

    @Override
    public List<Dataset> datasets(Set<String> unreadable) throws SQLException {
        List<Dataset> datasets = new ArrayList<>();
        try (PreparedStatement statement = connection.prepareStatement(DATASETS);
            ResultSet rows = statement.executeQuery()) {
            while (rows.next()) {
                String id = rows.getString(1);
                try {
                    datasets
                        .add(new Dataset(id, rows.getString(2),
                            DatasetVersion
                                .parse(id, rows.getInt(4), rows.getString(3),
                                    JacksonMapper.readTree(rows.getString(5)),
                                    JacksonMapper.readTree(rows.getString(6)),
                                    rows.getString(7), rows.getString(8), rows.getString(9))));
                } catch (IllegalArgumentException invalid) {
                    LOG
                        .warn("dataset {} has an unreadable current version, so its rows stay: {}", id,
                            invalid.getMessage());
                    unreadable.add(rows.getString(2));
                }
            }
        }
        return datasets;
    }

    @Override
    public List<MetricDefinition> definitions() throws SQLException {
        List<MetricDefinition> definitions = new ArrayList<>();
        try (PreparedStatement statement = connection.prepareStatement(DEFINITIONS);
            ResultSet rows = statement.executeQuery()) {
            while (rows.next()) {
                try {
                    definitions
                        .add(MetricDefinition
                            .parse(rows.getString(1), rows.getString(2), rows.getString(3), rows.getString(4),
                                rows.getString(5), JacksonMapper.readTree(rows.getString(6)),
                                rows.getObject(7, Integer.class), rows.getBoolean(8)));
                } catch (IllegalArgumentException invalid) {
                    LOG.warn("skipping metric definition {}: {}", rows.getString(1), invalid.getMessage());
                }
            }
        }
        return definitions;
    }

    @Override
    public Map<RowKey, Stored> storedRows(Map<String, Set<String>> archivedBySource) throws SQLException {
        Map<RowKey, Stored> stored = new HashMap<>();
        connection.setAutoCommit(false);
        try (PreparedStatement statement = connection.prepareStatement(STORED)) {
            statement.setFetchSize(FETCH_SIZE);
            statement.setArray(1, connection.createArrayOf("text", archivedBySource.keySet().toArray()));
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    String source = rows.getString(2);
                    ObjectNode archived = null;
                    String attributes = rows.getString(4);
                    if (attributes != null) {
                        archived = JacksonMapper.instance().createObjectNode();
                        JsonNode object = JacksonMapper.readTree(attributes);
                        for (String name : archivedBySource.get(source)) {
                            if (object.has(name)) archived.set(name, object.get(name));
                        }
                    }
                    stored.put(new RowKey(rows.getString(1), source), new Stored(rows.getString(3), archived));
                }
            }
            connection.commit();
        } finally {
            connection.setAutoCommit(true);
        }
        return stored;
    }

    @Override
    public Set<String> tombstoneHashes() throws SQLException {
        Set<String> hashes = new HashSet<>();
        try (PreparedStatement statement = connection.prepareStatement(TOMBSTONES);
            ResultSet rows = statement.executeQuery()) {
            while (rows.next()) {
                hashes.add(rows.getString(1));
            }
        }
        return hashes;
    }

    @Override
    public Written upsert(UUID passId, List<Staged> rows) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(EXPLAIN + UPSERT)) {
            statement.setString(1, passId.toString());
            statement.setArray(2, texts(rows.stream().map(row -> row.key().customerKey()).toList()));
            statement.setArray(3, texts(rows.stream().map(row -> row.key().sourceId()).toList()));
            statement.setArray(4, texts(rows.stream().map(Staged::attributes).toList()));
            statement.setArray(5, texts(rows.stream().map(Staged::hash).toList()));
            return new Written(rows.size(), walBytes(explain(statement)));
        }
    }

    @Override
    public Written delete(List<RowKey> rows) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(EXPLAIN + DELETE_ROWS)) {
            statement.setArray(1, texts(rows.stream().map(RowKey::customerKey).toList()));
            statement.setArray(2, texts(rows.stream().map(RowKey::sourceId).toList()));
            return new Written(rows.size(), walBytes(explain(statement)));
        }
    }

    @Override
    public Written deleteCustomers(Collection<String> customerKeys) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(EXPLAIN + DELETE_CUSTOMERS)) {
            statement.setArray(1, texts(List.copyOf(customerKeys)));
            JsonNode plan = explain(statement);
            return new Written(scannedRows(plan), walBytes(plan));
        }
    }

    @Override
    public void finish(UUID passId, Outcome outcome, Collection<String> runIds) throws SQLException {
        connection.setAutoCommit(false);
        try {
            if (end(passId, ImportMetricPassesTable.DONE, null, outcome) != 1) {
                throw new IllegalStateException("pass " + passId + " is no longer running");
            }
            try (PreparedStatement statement = connection.prepareStatement(FIRST_PASS)) {
                statement.setString(1, passId.toString());
                statement.setArray(2, connection.createArrayOf("text", runIds.toArray()));
                statement.executeUpdate();
            }
            connection.commit();
        } catch (SQLException | RuntimeException failure) {
            connection.rollback();
            throw failure;
        } finally {
            connection.setAutoCommit(true);
        }
    }

    @Override
    public void fail(UUID passId, String reason, Outcome outcome) throws SQLException {
        end(passId, ImportMetricPassesTable.FAILED, reason, outcome);
    }

    private int end(UUID passId, String state, String reason, Outcome outcome) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(END)) {
            statement.setString(1, state);
            statement.setString(2, reason);
            statement.setLong(3, outcome.changedRows());
            statement.setLong(4, outcome.walBytes());
            statement.setString(5, JacksonMapper.writeValueAsString(outcome.counts()));
            statement.setString(6, JacksonMapper.writeValueAsString(pauses(outcome.pauses())));
            statement.setTimestamp(7, outcome.lastRunFinishedAt().map(Timestamp::from).orElse(null));
            statement.setString(8, passId.toString());
            return statement.executeUpdate();
        }
    }

    static ArrayNode pauses(List<WalGovernor.Pause> pauses) {
        ArrayNode array = JacksonMapper.instance().createArrayNode();
        for (WalGovernor.Pause pause : pauses) {
            array
                .addObject()
                .put("start", pause.start().toString())
                .put("end", pause.end().toString())
                .put("reason", pause.reason());
        }
        return array;
    }

    private Array texts(List<String> values) throws SQLException {
        return connection.createArrayOf("text", values.toArray());
    }

    private static JsonNode explain(PreparedStatement statement) throws SQLException {
        try (ResultSet row = statement.executeQuery()) {
            row.next();
            return JacksonMapper.readTree(row.getString(1)).path(0);
        }
    }

    /**
     * The statement's own WAL: the top plan node's {@code WAL Bytes}, which counts
     * its children.
     */
    static long walBytes(JsonNode explained) {
        return explained.path("Plan").path("WAL Bytes").asLong(0);
    }

    /** Rows the modify node took from its child, the rows a delete removed. */
    static long scannedRows(JsonNode explained) {
        JsonNode child = explained.path("Plan").path("Plans").path(0);
        return child.path("Actual Rows").asLong(0) * Math.max(1, child.path("Actual Loops").asLong(1));
    }
}
