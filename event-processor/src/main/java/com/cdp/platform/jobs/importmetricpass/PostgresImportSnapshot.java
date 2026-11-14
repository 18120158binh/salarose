package com.cdp.platform.jobs.importmetricpass;

import java.math.BigDecimal;
import java.sql.Array;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.Consumer;

import com.cdp.platform.jobs.importmetricpass.EventMetricQuery.Output;
import com.cdp.platform.shared.db.repositories.ImportIdentifiersTable;
import com.cdp.platform.shared.db.repositories.ImportProfilesTable;
import com.cdp.platform.shared.db.repositories.ImportRunCommitsTable;
import com.cdp.platform.shared.models.imports.DatasetColumn.ColumnType;
import com.cdp.platform.shared.models.imports.DatasetVersion;
import com.cdp.platform.shared.utils.JacksonMapper;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * The import store, read as {@code import_reader} in one repeatable-read,
 * read-only transaction (IMP-FR-03, IMP-FR-16). Results stream with a fetch
 * size, so a dataset's rows never sit in memory together.
 */
final class PostgresImportSnapshot implements ImportSnapshot {

    private static final int FETCH_SIZE = 5000;

    private static final String COMMITS = "SELECT " + ImportRunCommitsTable.RUN_ID + "::text, "
        + ImportRunCommitsTable.COMMITTED_AT + " FROM " + ImportRunCommitsTable.TABLE_NAME;
    private static final String IDENTIFIERS = "ARRAY(SELECT DISTINCT i." + ImportIdentifiersTable.VALUE + " FROM "
        + ImportIdentifiersTable.TABLE_NAME + " i WHERE i." + ImportIdentifiersTable.RECORD_TYPE_ID + " = p."
        + ImportProfilesTable.RECORD_TYPE_ID + " AND i." + ImportIdentifiersTable.CUSTOMER_KEY + " = p."
        + ImportProfilesTable.CUSTOMER_KEY + " AND i." + ImportIdentifiersTable.TYPE + " = '%s')";
    private static final String PROFILES = "SELECT p." + ImportProfilesTable.CUSTOMER_KEY + ", p."
        + ImportProfilesTable.DATA + "::text, " + IDENTIFIERS.formatted("email") + ", " + IDENTIFIERS.formatted("phone")
        + " FROM " + ImportProfilesTable.TABLE_NAME + " p WHERE p." + ImportProfilesTable.RECORD_TYPE_ID
        + " = ?::uuid";
    private static final String SHARED = "SELECT " + ImportIdentifiersTable.TYPE + ", " + ImportIdentifiersTable.VALUE
        + " FROM " + ImportIdentifiersTable.TABLE_NAME + " GROUP BY " + ImportIdentifiersTable.TYPE + ", "
        + ImportIdentifiersTable.VALUE + " HAVING count(DISTINCT " + ImportIdentifiersTable.CUSTOMER_KEY + ") >= 2";

    private final Connection connection;
    private final ZoneId zone;

    private PostgresImportSnapshot(Connection connection, ZoneId zone) {
        this.connection = connection;
        this.zone = zone;
    }

    /** Begins the transaction. Its snapshot is taken at the first query. */
    static PostgresImportSnapshot open(Connection connection, ZoneId zone) throws SQLException {
        connection.setAutoCommit(false);
        connection.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
        connection.setReadOnly(true);
        return new PostgresImportSnapshot(connection, zone);
    }

    @Override
    public List<Commit> commits() throws SQLException {
        List<Commit> commits = new ArrayList<>();
        try (PreparedStatement statement = connection.prepareStatement(COMMITS)) {
            statement.setFetchSize(FETCH_SIZE);
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    commits.add(new Commit(rows.getString(1), rows.getObject(2, OffsetDateTime.class).toInstant()));
                }
            }
        }
        return commits;
    }

    @Override
    public void events(DatasetVersion version, List<MetricDefinition> active, Instant asOf,
        List<MetricDefinition> unusable, Consumer<EventRow> each) throws SQLException {
        EventMetricQuery query = EventMetricQuery.build(version, active, asOf, unusable);
        try (PreparedStatement statement = connection.prepareStatement(query.sql())) {
            statement.setFetchSize(FETCH_SIZE);
            for (int i = 0; i < query.parameters().size(); i++) {
                Object parameter = query.parameters().get(i);
                if (parameter instanceof String text) statement.setString(i + 1, text);
                else statement.setObject(i + 1, parameter);
            }
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    Map<String, JsonNode> values = new HashMap<>();
                    for (int i = 0; i < query.outputs().size(); i++) {
                        Output output = query.outputs().get(i);
                        value(rows, i + 2, output).ifPresent(value -> values.put(output.definition().name(), value));
                    }
                    each.accept(new EventRow(rows.getString(1), values));
                }
            }
        }
    }

    /** One metric's result column, in its attribute form. */
    private Optional<JsonNode> value(ResultSet rows, int index, Output output) throws SQLException {
        switch (output.definition().function()) {
            case COUNT, DISTINCT_COUNT -> {
                return AttributeValues.number(rows.getLong(index));
            }
            case SUM, AVG, MIN, MAX -> {
                BigDecimal value = rows.getBigDecimal(index);
                return value == null ? Optional.empty() : AttributeValues.number(value.doubleValue());
            }
            case MEDIAN -> {
                double value = rows.getDouble(index);
                return rows.wasNull() ? Optional.empty() : AttributeValues.number(value);
            }
            case FIRST_TIME, LAST_TIME -> {
                OffsetDateTime value = rows.getObject(index, OffsetDateTime.class);
                return value == null
                    ? Optional.empty()
                    : Optional.of(AttributeValues.datetime(value.toInstant(), zone));
            }
            case LATEST -> {
                String value = rows.getString(index);
                if (value == null) return Optional.empty();
                ColumnType type = output.columnType().orElseThrow();
                return AttributeValues.ofColumn(JacksonMapper.readTree(value), type, zone);
            }
            default -> throw new IllegalStateException(output.definition().function().name());
        }
    }

    @Override
    public void profiles(String recordTypeId, Consumer<ProfileRow> each) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(PROFILES)) {
            statement.setFetchSize(FETCH_SIZE);
            statement.setString(1, recordTypeId);
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    each
                        .accept(new ProfileRow(rows.getString(1), JacksonMapper.readTree(rows.getString(2)),
                            strings(rows, 3), strings(rows, 4)));
                }
            }
        }
    }

    private static List<String> strings(ResultSet rows, int index) throws SQLException {
        Array array = rows.getArray(index);
        return array == null ? List.of() : Arrays.asList((String[]) array.getArray());
    }

    @Override
    public Set<String> sharedIdentifiers() throws SQLException {
        Set<String> shared = new HashSet<>();
        try (PreparedStatement statement = connection.prepareStatement(SHARED)) {
            statement.setFetchSize(FETCH_SIZE);
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    shared.add(rows.getString(1) + ":" + rows.getString(2));
                }
            }
        }
        return shared;
    }

    /** Ends the transaction. It wrote nothing, so a rollback ends it. */
    @Override
    public void close() throws SQLException {
        connection.rollback();
    }
}
