package com.cdp.platform.shared.db.repositories;

import java.sql.Connection;
import java.sql.SQLException;
import java.sql.SQLTransientConnectionException;

import com.cdp.platform.shared.config.DatabaseConfig;

import com.zaxxer.hikari.HikariDataSource;

/**
 * A connection pool that times out on every request, as when Postgres is down.
 */
public final class UnreachableDatabase extends HikariDataSource {

    /** Settings for a function whose test replaces the pools it would open. */
    public static final DatabaseConfig CONFIG = new DatabaseConfig("unreachable.invalid", "5432", "cdp", "unused",
        "cdp", "jdbc:postgresql://unreachable.invalid:5432/cdp", "jdbc:postgresql://unreachable.invalid:5432/cdp", 10);

    /** A {@code user_metrics} repository whose every read fails. */
    public static UserMetricRepository userMetrics() {
        return new UserMetricRepository(new UnreachableDatabase());
    }

    /** An {@code identity_graph} repository whose every read fails. */
    public static IdentityGraphRepository identityGraph() {
        return new IdentityGraphRepository(new UnreachableDatabase());
    }

    private UnreachableDatabase() {
        setMaximumPoolSize(1);
    }

    @Override
    public Connection getConnection() throws SQLException {
        throw new SQLTransientConnectionException("Connection is not available, request timed out after 5000ms");
    }
}
