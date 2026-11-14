package com.cdp.platform.jobs.importapplier;

import java.sql.Array;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import com.cdp.platform.shared.db.repositories.IdentityGraphTable;
import com.cdp.platform.shared.db.repositories.ImportIdentifiersTable;
import com.cdp.platform.shared.db.repositories.ImportRecordsTable;
import com.cdp.platform.shared.db.repositories.ImportRunCommitsTable;
import com.cdp.platform.shared.utils.JacksonMapper;

import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * {@link Lookups} on the two Postgres clusters: {@code identity_graph} on the
 * main one, and the import store. Every statement only reads.
 */
final class PostgresLookups implements Lookups {

    private final Connection main;
    private final Connection importStore;

    PostgresLookups(Connection main, Connection importStore) {
        this.main = main;
        this.importStore = importStore;
    }

    @Override
    public int matchedUserIds(List<String> customerKeys) {
        String sql = "SELECT count(DISTINCT %s) FROM %s WHERE %s = ANY(?)"
            .formatted(IdentityGraphTable.USER_ID,
                IdentityGraphTable.TABLE_NAME, IdentityGraphTable.USER_ID);
        return (int) count(main, sql, customerKeys, null);
    }

    @Override
    public int storedRecordIds(String recordTypeId, List<String> recordIds) {
        String sql = "SELECT count(*) FROM %s WHERE %s = ANY(?) AND %s = ?::uuid"
            .formatted(
                ImportRecordsTable.TABLE_NAME, ImportRecordsTable.RECORD_ID, ImportRecordsTable.RECORD_TYPE_ID);
        return (int) count(importStore, sql, recordIds, recordTypeId);
    }

    @Override
    public Shared sharedContacts(List<Contact> contacts) {
        String sql = "SELECT %s, %s, %s FROM %s WHERE (%s, %s) IN (SELECT * FROM unnest(?::text[], ?::text[]))"
            .formatted(ImportIdentifiersTable.TYPE, ImportIdentifiersTable.VALUE, ImportIdentifiersTable.CUSTOMER_KEY,
                ImportIdentifiersTable.TABLE_NAME, ImportIdentifiersTable.TYPE, ImportIdentifiersTable.VALUE);
        Map<String, Set<String>> holders = new HashMap<>();
        try (PreparedStatement statement = importStore.prepareStatement(sql)) {
            statement.setArray(1, importStore.createArrayOf("text", contacts.stream().map(Contact::type).toArray()));
            statement.setArray(2, importStore.createArrayOf("text", contacts.stream().map(Contact::value).toArray()));
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    holders
                        .computeIfAbsent(rows.getString(1) + ':' + rows.getString(2), key -> new HashSet<>())
                        .add(rows.getString(3));
                }
            }
        } catch (SQLException e) {
            throw new IllegalStateException("reading import_identifiers failed", e);
        }
        long emails = 0;
        long phones = 0;
        for (Contact contact : contacts) {
            Set<String> keys = holders.getOrDefault(contact.type() + ':' + contact.value(), Set.of());
            boolean another = keys.size() > 1 || keys.size() == 1 && !keys.contains(contact.customerKey());
            if (!another) continue;
            if (contact.type().equals("email")) {
                emails++;
            } else {
                phones++;
            }
        }
        return new Shared(emails, phones);
    }

    @Override
    public long storedRecords() {
        String sql = "SELECT count(*) FROM " + ImportRecordsTable.TABLE_NAME;
        try (PreparedStatement statement = importStore.prepareStatement(sql);
            ResultSet row = statement.executeQuery()) {
            row.next();
            return row.getLong(1);
        } catch (SQLException e) {
            throw new IllegalStateException("counting import_records failed", e);
        }
    }

    /**
     * The counts of the run's commit marker, or empty when the run has none
     * (IAP-FR-15).
     */
    Optional<ObjectNode> commitMarker(String runId) throws SQLException {
        String sql = "SELECT %s FROM %s WHERE %s = ?::uuid"
            .formatted(ImportRunCommitsTable.COUNTS,
                ImportRunCommitsTable.TABLE_NAME, ImportRunCommitsTable.RUN_ID);
        try (PreparedStatement statement = importStore.prepareStatement(sql)) {
            statement.setString(1, runId);
            try (ResultSet row = statement.executeQuery()) {
                return row.next()
                    ? Optional.of((ObjectNode) JacksonMapper.readTree(row.getString(1)))
                    : Optional.empty();
            }
        }
    }

    /**
     * Runs a count over an array of values, and a record type id as the second
     * parameter when given.
     */
    private static long count(Connection connection, String sql, List<String> values, String recordTypeId) {
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            Array array = connection.createArrayOf("text", values.toArray());
            statement.setArray(1, array);
            if (recordTypeId != null) statement.setString(2, recordTypeId);
            try (ResultSet row = statement.executeQuery()) {
                row.next();
                return row.getLong(1);
            }
        } catch (SQLException e) {
            throw new IllegalStateException("a lookup failed", e);
        }
    }
}
