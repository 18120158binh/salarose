package com.cdp.platform.shared.utils;

import java.time.Duration;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;

public final class JdbcUtil {

    private JdbcUtil() {
    }

    /**
     * A pool on {@code jdbcUrl} whose callers wait at most
     * {@code connectionTimeout} for a connection, and for a dead one to be
     * detected.
     */
    public static HikariDataSource createDataSource(String jdbcUrl, String user, String password, int maxPoolSize,
        Duration connectionTimeout) {
        HikariConfig config = new HikariConfig();
        config.setDriverClassName("org.postgresql.Driver");
        config.setJdbcUrl(jdbcUrl);
        config.setUsername(user);
        config.setPassword(password);
        config.setMaximumPoolSize(maxPoolSize);
        config.setConnectionTimeout(connectionTimeout.toMillis());
        config.setValidationTimeout(Math.min(connectionTimeout.toMillis(), 5_000));
        config.setInitializationFailTimeout(-1);
        config.addDataSourceProperty("preparedStatementCacheQueries", "256");
        config.addDataSourceProperty("prepareThreshold", "1");
        return new HikariDataSource(config);
    }
}
