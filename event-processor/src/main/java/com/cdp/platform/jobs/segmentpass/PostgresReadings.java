package com.cdp.platform.jobs.segmentpass;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.util.Optional;
import java.util.OptionalDouble;

import com.cdp.platform.shared.utils.JacksonMapper;

import com.fasterxml.jackson.databind.JsonNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The governor's readings. The slot share is the smallest {@code safe_wal_size}
 * of any slot over {@code max_slot_wal_keep_size}, and 1 with no slot. No cap
 * set is a missing reading. The disk share is the worse of the node
 * filesystem's free share, from the monitoring query, and the database's free
 * share of its claim. No query configured, or one that fails, is a missing
 * reading.
 */
final class PostgresReadings implements WalGovernor.Readings {

    private static final Logger LOG = LoggerFactory.getLogger(PostgresReadings.class);
    private static final Duration QUERY_TIMEOUT = Duration.ofSeconds(10);

    // The setting's unit is MB. -1 means no cap.
    private static final String SLOT_SQL = """
        SELECT (SELECT setting::bigint FROM pg_settings WHERE name = 'max_slot_wal_keep_size'),
               (SELECT min(safe_wal_size) FROM pg_replication_slots)
        """;
    private static final String DATABASE_BYTES_SQL = "SELECT pg_database_size(current_database())";

    private final Connection connection;
    private final Optional<URI> freeDiskQuery;
    private final long claimBytes;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(QUERY_TIMEOUT).build();

    PostgresReadings(Connection connection, Optional<URI> freeDiskQuery, long claimBytes) {
        this.connection = connection;
        this.freeDiskQuery = freeDiskQuery;
        this.claimBytes = claimBytes;
    }

    @Override
    public WalGovernor.Reading read() throws SQLException {
        OptionalDouble disk = OptionalDouble.empty();
        OptionalDouble node = nodeFreeShare();
        if (node.isPresent()) disk = OptionalDouble.of(Math.min(node.getAsDouble(), databaseFreeShare()));
        return new WalGovernor.Reading(slotShare(), disk);
    }

    private OptionalDouble slotShare() throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(SLOT_SQL);
            ResultSet row = statement.executeQuery()) {
            row.next();
            long capMb = row.getLong(1);
            if (row.wasNull() || capMb <= 0) return OptionalDouble.empty();
            long safe = row.getLong(2);
            if (row.wasNull()) return OptionalDouble.of(1);
            return OptionalDouble.of(Math.max(0, safe) / (capMb * 1024.0 * 1024.0));
        }
    }

    private double databaseFreeShare() throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(DATABASE_BYTES_SQL);
            ResultSet row = statement.executeQuery()) {
            row.next();
            return Math.max(0, 1 - row.getLong(1) / (double) claimBytes);
        }
    }

    /**
     * The first sample of a Prometheus instant-query response, read as the
     * node's free share of its root filesystem.
     */
    private OptionalDouble nodeFreeShare() {
        if (freeDiskQuery.isEmpty()) return OptionalDouble.empty();
        try {
            HttpResponse<String> response = http
                .send(HttpRequest.newBuilder(freeDiskQuery.get()).timeout(QUERY_TIMEOUT).GET().build(),
                    HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) {
                LOG.warn("Free disk query answered {}", response.statusCode());
                return OptionalDouble.empty();
            }
            return freeShare(JacksonMapper.readTree(response.body()));
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return OptionalDouble.empty();
        } catch (Exception failure) {
            LOG.warn("Free disk query failed", failure);
            return OptionalDouble.empty();
        }
    }

    /** {@code data.result[0].value[1]} of a Prometheus vector, if it is a share. */
    static OptionalDouble freeShare(JsonNode body) {
        JsonNode value = body.path("data").path("result").path(0).path("value").path(1);
        if (!value.isTextual()) return OptionalDouble.empty();
        try {
            double share = Double.parseDouble(value.asText());
            return share >= 0 && share <= 1 ? OptionalDouble.of(share) : OptionalDouble.empty();
        } catch (NumberFormatException invalid) {
            return OptionalDouble.empty();
        }
    }
}
