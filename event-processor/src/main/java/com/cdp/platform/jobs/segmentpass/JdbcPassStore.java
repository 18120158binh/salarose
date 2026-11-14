package com.cdp.platform.jobs.segmentpass;

import java.sql.Array;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Types;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import com.cdp.platform.jobs.segmentpass.MetricPassWait.MetricPass;
import com.cdp.platform.shared.db.repositories.CustomerAttributesTable;
import com.cdp.platform.shared.db.repositories.CustomerProfilesTable;
import com.cdp.platform.shared.db.repositories.IdentityGraphTable;
import com.cdp.platform.shared.db.repositories.ImportMetricPassesTable;
import com.cdp.platform.shared.db.repositories.SegmentImportMembersTable;
import com.cdp.platform.shared.db.repositories.SegmentMembershipPassesTable;
import com.cdp.platform.shared.db.repositories.SegmentsTable;
import com.cdp.platform.shared.models.db.UserProfile;
import com.cdp.platform.shared.utils.JacksonMapper;

import com.fasterxml.jackson.databind.JsonNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * {@link PassStore} on one JDBC connection to the main Postgres. Reads run in
 * autocommit, and each write batch in its own transaction, so a crash leaves
 * whole batches and the next pass converges (SMP-FR-09).
 */
final class JdbcPassStore implements PassStore {

    private static final Logger LOG = LoggerFactory.getLogger(JdbcPassStore.class);

    /**
     * The advisory lock that one pass at a time holds. Any fixed number no other
     * job takes.
     */
    static final long LOCK_KEY = 0x5345474d5041L;

    private static final String MEMBERS = SegmentImportMembersTable.TABLE_NAME;
    private static final String RUNS = SegmentMembershipPassesTable.TABLE_NAME;
    private static final String ATTRIBUTES = CustomerAttributesTable.TABLE_NAME;
    private static final String KEY = CustomerAttributesTable.CUSTOMER_KEY;

    private static final String METRIC_PASSES_SQL = """
        SELECT %1$s, %2$s, %3$s FROM %4$s WHERE %2$s > ? AND %2$s <= ?
        UNION
        (SELECT %1$s, %2$s, %3$s FROM %4$s WHERE %3$s = '%5$s' ORDER BY %2$s DESC LIMIT 1)
        """
        .formatted(ImportMetricPassesTable.ID, ImportMetricPassesTable.AS_OF, ImportMetricPassesTable.STATE,
            ImportMetricPassesTable.TABLE_NAME, ImportMetricPassesTable.DONE);

    private static final String FAIL_RUNNING_SQL = "UPDATE %s SET %s = '%s', %s = ? WHERE %s = '%s'"
        .formatted(RUNS, SegmentMembershipPassesTable.STATE, SegmentMembershipPassesTable.FAILED,
            SegmentMembershipPassesTable.FINISHED_AT, SegmentMembershipPassesTable.STATE,
            SegmentMembershipPassesTable.RUNNING);

    private static final String OPEN_RUN_SQL = "INSERT INTO %s (%s, %s, %s, %s, %s) VALUES (?, '%s', ?, ?, ?)"
        .formatted(RUNS, SegmentMembershipPassesTable.AS_OF, SegmentMembershipPassesTable.STATE,
            SegmentMembershipPassesTable.FALLBACK, SegmentMembershipPassesTable.METRIC_PASS_ID,
            SegmentMembershipPassesTable.STARTED_AT, SegmentMembershipPassesTable.RUNNING);

    private static final String CLOSE_RUN_SQL = "UPDATE %s SET %s = ?, %s = ?, %s = ?, %s = ?, %s = ?, %s = ?, %s = ?"
        .formatted(RUNS, SegmentMembershipPassesTable.STATE, SegmentMembershipPassesTable.FINISHED_AT,
            SegmentMembershipPassesTable.ROWS_INSERTED, SegmentMembershipPassesTable.ROWS_DELETED,
            SegmentMembershipPassesTable.SKIPPED_SEGMENTS, SegmentMembershipPassesTable.PAUSES,
            SegmentMembershipPassesTable.PAUSED_SECONDS)
        + " WHERE %s = ?".formatted(SegmentMembershipPassesTable.AS_OF);

    private static final String SEGMENTS_SQL = "SELECT %s, %s::text FROM %s ORDER BY %s"
        .formatted(SegmentsTable.ID, SegmentsTable.CONDITIONS_JSON, SegmentsTable.TABLE_NAME, SegmentsTable.ID);

    // Imported-only: no identity_graph row holds the key as its user_id
    // (idx_ig_user_latest).
    private static final String KEYS_SQL = """
        SELECT DISTINCT a.%1$s FROM %2$s a
        WHERE a.%1$s > ? AND NOT EXISTS (SELECT 1 FROM %3$s g WHERE g.%4$s = a.%1$s)
        ORDER BY a.%1$s LIMIT ?
        """.formatted(KEY, ATTRIBUTES, IdentityGraphTable.TABLE_NAME, IdentityGraphTable.USER_ID);

    private static final String ATTRIBUTES_SQL = "SELECT %s, %s, %s::text FROM %s WHERE %s = ANY(?)"
        .formatted(KEY, CustomerAttributesTable.SOURCE_ID, CustomerAttributesTable.ATTRIBUTES, ATTRIBUTES, KEY);

    private static final String PROFILES_SQL = "SELECT %s FROM %s WHERE %s = ANY(?)"
        .formatted(String.join(", ", CustomerProfilesTable.COLUMNS), CustomerProfilesTable.TABLE_NAME,
            CustomerProfilesTable.CDP_UUID);

    private static final String STORED_SQL = "SELECT %s, %s FROM %s WHERE %s = ANY(?)"
        .formatted(SegmentImportMembersTable.CUSTOMER_KEY, SegmentImportMembersTable.SEGMENT_ID, MEMBERS,
            SegmentImportMembersTable.CUSTOMER_KEY);

    // A conflict means the row is already there, so it keeps its since (SMP-FR-05).
    private static final String INSERT_SQL = """
        INSERT INTO %s (%s, %s, %s) SELECT s, k, ? FROM unnest(?::text[], ?::text[]) AS m(s, k)
        ON CONFLICT DO NOTHING
        """
        .formatted(MEMBERS, SegmentImportMembersTable.SEGMENT_ID, SegmentImportMembersTable.CUSTOMER_KEY,
            SegmentImportMembersTable.SINCE);

    private static final String DELETE_SQL = """
        DELETE FROM %1$s t USING unnest(?::text[], ?::text[]) AS m(s, k)
        WHERE t.%2$s = m.s AND t.%3$s = m.k
        """.formatted(MEMBERS, SegmentImportMembersTable.SEGMENT_ID, SegmentImportMembersTable.CUSTOMER_KEY);

    // Rows of a deleted segment, of a key a tracked person holds, or of a key gone
    // from customer_attributes.
    private static final String DELETE_STALE_SQL = """
        DELETE FROM %1$s t USING (
            SELECT m.%2$s, m.%3$s FROM %1$s m
            WHERE NOT (m.%2$s = ANY(?))
               OR EXISTS (SELECT 1 FROM %4$s g WHERE g.%5$s = m.%3$s)
               OR NOT EXISTS (SELECT 1 FROM %6$s a WHERE a.%7$s = m.%3$s)
            LIMIT ?
        ) stale
        WHERE t.%2$s = stale.%2$s AND t.%3$s = stale.%3$s
        """
        .formatted(MEMBERS, SegmentImportMembersTable.SEGMENT_ID, SegmentImportMembersTable.CUSTOMER_KEY,
            IdentityGraphTable.TABLE_NAME, IdentityGraphTable.USER_ID, ATTRIBUTES, KEY);

    private final Connection connection;

    JdbcPassStore(Connection connection) {
        this.connection = connection;
    }

    @Override
    public boolean tryLock() throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement("SELECT pg_try_advisory_lock(?)")) {
            statement.setLong(1, LOCK_KEY);
            try (ResultSet row = statement.executeQuery()) {
                return row.next() && row.getBoolean(1);
            }
        }
    }

    @Override
    public List<MetricPass> metricPasses(Instant scheduledTime) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(METRIC_PASSES_SQL)) {
            statement.setObject(1, utc(scheduledTime.minus(MetricPassWait.TONIGHT)));
            statement.setObject(2, utc(scheduledTime));
            List<MetricPass> passes = new ArrayList<>();
            try (ResultSet row = statement.executeQuery()) {
                while (row.next()) {
                    passes
                        .add(new MetricPass(row.getObject(1, UUID.class), row.getTimestamp(2).toInstant(),
                            row.getString(3)));
                }
            }
            return passes;
        }
    }

    @Override
    public int failRunning(Instant now) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(FAIL_RUNNING_SQL)) {
            statement.setObject(1, utc(now));
            return statement.executeUpdate();
        }
    }

    @Override
    public void openRun(Instant asOf, boolean fallback, Optional<UUID> metricPassId) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(OPEN_RUN_SQL)) {
            statement.setObject(1, utc(asOf));
            statement.setBoolean(2, fallback);
            if (metricPassId.isPresent()) {
                statement.setObject(3, metricPassId.get());
            } else {
                statement.setNull(3, Types.OTHER);
            }
            statement.setObject(4, utc(asOf));
            statement.executeUpdate();
        }
    }

    @Override
    public void closeRun(Instant asOf, RunTotals totals) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(CLOSE_RUN_SQL)) {
            statement.setString(1, totals.state());
            statement.setObject(2, utc(totals.finishedAt()));
            statement.setLong(3, totals.rowsInserted());
            statement.setLong(4, totals.rowsDeleted());
            statement.setArray(5, textArray(totals.skippedSegments()));
            statement.setInt(6, totals.pauses());
            statement.setDouble(7, totals.pausedSeconds());
            statement.setObject(8, utc(asOf));
            statement.executeUpdate();
        }
    }

    @Override
    public List<SegmentRow> segments() throws SQLException {
        List<SegmentRow> rows = new ArrayList<>();
        try (PreparedStatement statement = connection.prepareStatement(SEGMENTS_SQL);
            ResultSet row = statement.executeQuery()) {
            while (row.next()) {
                rows.add(new SegmentRow(row.getString(1), row.getString(2)));
            }
        }
        return rows;
    }

    @Override
    public List<String> importedOnlyKeys(String after, int limit) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(KEYS_SQL)) {
            statement.setString(1, after);
            statement.setInt(2, limit);
            List<String> keys = new ArrayList<>();
            try (ResultSet row = statement.executeQuery()) {
                while (row.next()) {
                    keys.add(row.getString(1));
                }
            }
            return keys;
        }
    }

    @Override
    public Map<String, ImportedCustomer> customers(Collection<String> keys) throws SQLException {
        Map<String, Map<String, JsonNode>> attributes = new HashMap<>();
        try (PreparedStatement statement = connection.prepareStatement(ATTRIBUTES_SQL)) {
            statement.setArray(1, textArray(keys));
            try (ResultSet row = statement.executeQuery()) {
                while (row.next()) {
                    attributes
                        .computeIfAbsent(row.getString(1), key -> new HashMap<>())
                        .put(row.getString(2), JacksonMapper.readTree(row.getString(3)));
                }
            }
        }
        Map<String, UserProfile> profiles = profiles(keys);
        Map<String, ImportedCustomer> customers = new HashMap<>();
        for (String key : keys) {
            customers
                .put(key, new ImportedCustomer(key, profiles.get(key), attributes.getOrDefault(key, Map.of())));
        }
        return customers;
    }

    // Matched on cdp_uuid by the customer key, as customer decision matches a
    // user_id.
    private Map<String, UserProfile> profiles(Collection<String> keys) throws SQLException {
        Map<String, UserProfile> profiles = new HashMap<>();
        try (PreparedStatement statement = connection.prepareStatement(PROFILES_SQL)) {
            statement.setArray(1, textArray(keys));
            try (ResultSet row = statement.executeQuery()) {
                while (row.next()) {
                    UserProfile profile = profile(row);
                    profiles.putIfAbsent(profile.cdpUuid(), profile);
                }
            }
        }
        return profiles;
    }

    private static UserProfile profile(ResultSet row) throws SQLException {
        Object fid = row.getObject(CustomerProfilesTable.FID);
        Object age = row.getObject(CustomerProfilesTable.AGE);
        return new UserProfile(
            fid == null ? null : row.getLong(CustomerProfilesTable.FID),
            row.getString(CustomerProfilesTable.CARDCODE),
            row.getString(CustomerProfilesTable.CUSTOMER_ID),
            row.getString(CustomerProfilesTable.PHONE),
            row.getString(CustomerProfilesTable.EMAIL),
            row.getString(CustomerProfilesTable.NAME),
            row.getString(CustomerProfilesTable.FIRST_NAME),
            row.getString(CustomerProfilesTable.PRONOUN),
            row.getString(CustomerProfilesTable.GENDER),
            age == null ? null : row.getDouble(CustomerProfilesTable.AGE),
            row.getString(CustomerProfilesTable.CITY),
            row.getString(CustomerProfilesTable.ENV),
            row.getString(CustomerProfilesTable.CDP_UUID),
            row.getString(CustomerProfilesTable.NETWORK_USER_ID),
            row.getString(CustomerProfilesTable.USER_TIME));
    }

    @Override
    public Map<String, Set<String>> storedSegments(Collection<String> keys) throws SQLException {
        Map<String, Set<String>> stored = new HashMap<>();
        try (PreparedStatement statement = connection.prepareStatement(STORED_SQL)) {
            statement.setArray(1, textArray(keys));
            try (ResultSet row = statement.executeQuery()) {
                while (row.next()) {
                    stored.computeIfAbsent(row.getString(1), key -> new HashSet<>()).add(row.getString(2));
                }
            }
        }
        return stored;
    }

    @Override
    public long[] apply(Collection<Member> inserts, Collection<Member> deletes, Instant asOf) throws SQLException {
        connection.setAutoCommit(false);
        try {
            long inserted = 0;
            long deleted = 0;
            if (!inserts.isEmpty()) {
                try (PreparedStatement statement = connection.prepareStatement(INSERT_SQL)) {
                    statement.setObject(1, utc(asOf));
                    statement.setArray(2, textArray(inserts.stream().map(Member::segmentId).toList()));
                    statement.setArray(3, textArray(inserts.stream().map(Member::customerKey).toList()));
                    inserted = statement.executeUpdate();
                }
            }
            if (!deletes.isEmpty()) {
                try (PreparedStatement statement = connection.prepareStatement(DELETE_SQL)) {
                    statement.setArray(1, textArray(deletes.stream().map(Member::segmentId).toList()));
                    statement.setArray(2, textArray(deletes.stream().map(Member::customerKey).toList()));
                    deleted = statement.executeUpdate();
                }
            }
            connection.commit();
            return new long[] {inserted, deleted};
        } catch (SQLException failure) {
            connection.rollback();
            throw failure;
        } finally {
            connection.setAutoCommit(true);
        }
    }

    @Override
    public int deleteStale(Set<String> segmentIds, int limit) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(DELETE_STALE_SQL)) {
            statement.setArray(1, textArray(segmentIds));
            statement.setInt(2, limit);
            return statement.executeUpdate();
        }
    }

    @Override
    public void close() {
        try {
            connection.close();
        } catch (SQLException failure) {
            LOG.warn("Cannot close the segment membership pass's connection", failure);
        }
    }

    private Array textArray(Collection<String> values) throws SQLException {
        return connection.createArrayOf("text", values.toArray());
    }

    private static OffsetDateTime utc(Instant instant) {
        return OffsetDateTime.ofInstant(instant, ZoneOffset.UTC);
    }
}
