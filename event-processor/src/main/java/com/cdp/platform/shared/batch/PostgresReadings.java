package com.cdp.platform.shared.batch;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.time.InstantSource;
import java.util.ArrayDeque;
import java.util.Deque;
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
 * reading. The cluster WAL rate is the change in {@code pg_current_wal_lsn()}
 * over the last 60 seconds of samples, missing until two samples exist.
 */
public final class PostgresReadings implements WalGovernor.Readings {

    private static final Logger LOG = LoggerFactory.getLogger(PostgresReadings.class);
    private static final Duration QUERY_TIMEOUT = Duration.ofSeconds(10);

    // The setting's unit is MB. -1 means no cap.
    private static final String SLOT_SQL = """
        SELECT (SELECT setting::bigint FROM pg_settings WHERE name = 'max_slot_wal_keep_size'),
               (SELECT min(safe_wal_size) FROM pg_replication_slots)
        """;
    private static final String DATABASE_BYTES_SQL = "SELECT pg_database_size(current_database())";
    private static final String LSN_SQL = "SELECT pg_current_wal_lsn() - '0/0'::pg_lsn";
    static final Duration RATE_WINDOW = Duration.ofSeconds(60);

    /** One LSN sample, in bytes since the start of WAL. */
    record Sample(Instant at, double lsn) {
    }

    private final Connection connection;
    private final Optional<URI> freeDiskQuery;
    private final long claimBytes;
    private final InstantSource clock;
    private final Deque<Sample> samples = new ArrayDeque<>();
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(QUERY_TIMEOUT).build();

    public PostgresReadings(Connection connection, Optional<URI> freeDiskQuery, long claimBytes, InstantSource clock) {
        this.connection = connection;
        this.freeDiskQuery = freeDiskQuery;
        this.claimBytes = claimBytes;
        this.clock = clock;
    }

    @Override
    public WalGovernor.Reading read() throws SQLException {
        OptionalDouble disk = OptionalDouble.empty();
        OptionalDouble node = nodeFreeShare();
        if (node.isPresent()) disk = OptionalDouble.of(Math.min(node.getAsDouble(), databaseFreeShare()));
        return new WalGovernor.Reading(slotShare(), disk, sampleClusterRate());
    }

    /**
     * Takes an LSN sample and returns the rate since the oldest sample kept. A job
     * calls it once at start, so its first reading has a rate.
     */
    public OptionalDouble sampleClusterRate() throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(LSN_SQL);
            ResultSet row = statement.executeQuery()) {
            row.next();
            return rate(samples, new Sample(clock.instant(), row.getDouble(1)));
        }
    }

    /**
     * Adds the sample, drops samples no longer needed for a 60-second window, and
     * returns the rate from the oldest kept sample in bytes per second.
     */
    static OptionalDouble rate(Deque<Sample> samples, Sample now) {
        samples.addLast(now);
        Instant windowStart = now.at().minus(RATE_WINDOW);
        while (samples.size() > 2) {
            Sample second = samples.stream().skip(1).findFirst().orElseThrow();
            if (second.at().isAfter(windowStart)) break;
            samples.removeFirst();
        }
        Sample oldest = samples.getFirst();
        double seconds = Duration.between(oldest.at(), now.at()).toMillis() / 1e3;
        if (seconds <= 0) return OptionalDouble.empty();
        return OptionalDouble.of(Math.max(0, now.lsn() - oldest.lsn()) / seconds);
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
    public static OptionalDouble freeShare(JsonNode body) {
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
