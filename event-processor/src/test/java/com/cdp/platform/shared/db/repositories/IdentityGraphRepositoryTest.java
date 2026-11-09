package com.cdp.platform.shared.db.repositories;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.List;
import java.util.Map;

import com.cdp.platform.shared.config.DatabaseConfig;
import com.cdp.platform.shared.config.EnvironmentSettings;
import com.cdp.platform.shared.models.db.IdentityGraph;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.zaxxer.hikari.HikariDataSource;
import org.junit.jupiter.api.Test;

class IdentityGraphRepositoryTest {

    @Test
    void anonymousEventAfterALoginInOneBatchKeepsTheUserId() {
        IdentityGraph merged = IdentityGraphRepository
            .mergeInOrder(new IdentityGraph("d1", "u1", "canon-of-u1"), new IdentityGraph("d1", null, "canon-of-u1"));

        assertEquals(new IdentityGraph("d1", "u1", "canon-of-u1"), merged);
    }

    @Test
    void laterEventInOneBatchSetsTheUserIdAndCanonId() {
        IdentityGraph merged = IdentityGraphRepository
            .mergeInOrder(new IdentityGraph("d1", "u1", "canon-of-u1"), new IdentityGraph("d1", "u2", "canon-of-u2"));

        assertEquals(new IdentityGraph("d1", "u2", "canon-of-u2"), merged);
    }

    @Test
    void failedReadIsNotTakenForNoRow() {
        IdentityGraphRepository repository = new IdentityGraphRepository(new UnreachableDataSource());

        SQLException failure = assertThrows(SQLException.class, () -> repository.findRows("d1", "u1"));

        assertEquals("connection refused", failure.getMessage());
    }

    @Test
    void lookupReadsThePrimaryThatTheSinkWrites() {
        DatabaseConfig primary = new DatabaseConfig("primary.invalid", "5432", "cdp", "secret", "cdp",
            "jdbc:postgresql://primary.invalid:5432/cdp", "jdbc:postgresql://replica.invalid:5432/cdp", 10);

        try (IdentityGraphRepository repository = IdentityGraphRepository.open(primary)) {
            assertEquals("jdbc:postgresql://primary.invalid:5432/cdp", repository.dataSource.getJdbcUrl());
        }
    }

    @Test
    void lookupConcurrencyIsAWholeNumberFrom1To32() {
        assertEquals(8, IdentityGraphRepository.lookupConcurrency(settings("8")));
        assertEquals(32, IdentityGraphRepository.lookupConcurrency(settings("32")));
        assertEquals(4, IdentityGraphRepository.lookupConcurrency(settings(" ")));
        assertEquals(4, IdentityGraphRepository.lookupConcurrency(new EnvironmentSettings(Map.of())));
        for (String invalid : List.of("0", "-1", "33", "four", "1.5")) {
            IllegalArgumentException failure = assertThrows(IllegalArgumentException.class,
                () -> IdentityGraphRepository.lookupConcurrency(settings(invalid)), invalid);
            assertTrue(failure.getMessage().startsWith("IDENTITY_LOOKUP_CONCURRENCY"), failure.getMessage());
        }
    }

    private static EnvironmentSettings settings(String concurrency) {
        return new EnvironmentSettings(Map.of("IDENTITY_LOOKUP_CONCURRENCY", concurrency));
    }

    private static final class UnreachableDataSource extends HikariDataSource {
        @Override
        public Connection getConnection() throws SQLException {
            throw new SQLException("connection refused");
        }
    }
}
