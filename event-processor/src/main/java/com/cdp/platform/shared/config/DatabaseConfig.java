package com.cdp.platform.shared.config;

import java.io.Serializable;
import java.util.Map;

/**
 * Shared PostgreSQL connection configuration, resolved from the environment
 * where the job is submitted. Functions carry it to the task managers, so it
 * is serializable, and its text form hides the password.
 *
 * @param jdbcUrl
 *            the primary, for writes, CDC, and lookups that must see the job's
 *            own writes
 * @param readJdbcUrl
 *            the read replica, or the primary when none is set, for the other
 *            lookups
 * @param cdcConfirmDelayCheckpoints
 *            how many completed checkpoints back each CDC source confirms a
 *            log position to its slot, which sets the CDC restore window
 */
public record DatabaseConfig(String host, String port, String user, String password, String database,
    String jdbcUrl, String readJdbcUrl, int cdcConfirmDelayCheckpoints) implements Serializable {

    // 10 checkpoints is about 5 minutes at the 30 s interval, 10 for the outbox at
    // 60 s. At the measured 6 MB/s peak a running slot then holds about 2 GB of
    // WAL, 4 GB for the outbox, under max_slot_wal_keep_size in
    // infra/k8s/data/postgres.yaml.
    static final int DEFAULT_CDC_CONFIRM_DELAY_CHECKPOINTS = 10;

    public static DatabaseConfig fromEnvironment() {
        return fromVariables(System.getenv());
    }

    /**
     * {@code DB_HOST}, {@code DB_READ_HOST}, {@code DB_PORT}, {@code DB_DATABASE},
     * {@code DB_USER}, {@code DB_PASSWORD}, which must be set, and
     * {@code CDC_CONFIRM_DELAY_CHECKPOINTS}.
     */
    static DatabaseConfig fromVariables(Map<String, String> variables) {
        String host = variables.getOrDefault("DB_HOST", "postgres");
        String readHost = variables.getOrDefault("DB_READ_HOST", host);
        String port = variables.getOrDefault("DB_PORT", "5432");
        String database = variables.getOrDefault("DB_DATABASE", "auroracy");
        String password = variables.get("DB_PASSWORD");
        if (password == null || password.isBlank()) throw new IllegalStateException("DB_PASSWORD is not set");
        int cdcConfirmDelayCheckpoints = new EnvironmentSettings(variables)
            .positiveInt("CDC_CONFIRM_DELAY_CHECKPOINTS", DEFAULT_CDC_CONFIRM_DELAY_CHECKPOINTS);
        return new DatabaseConfig(host, port, variables.getOrDefault("DB_USER", "postgres"), password, database,
            jdbcUrl(host, port, database), jdbcUrl(readHost, port, database), cdcConfirmDelayCheckpoints);
    }

    private static String jdbcUrl(String host, String port, String database) {
        return "jdbc:postgresql://%s:%s/%s?reWriteBatchedInserts=true".formatted(host, port, database);
    }

    @Override
    public String toString() {
        return ("DatabaseConfig[host=%s, port=%s, user=%s, password=<redacted>, database=%s, readJdbcUrl=%s, "
            + "cdcConfirmDelayCheckpoints=%d]")
            .formatted(host, port, user, database, readJdbcUrl,
                cdcConfirmDelayCheckpoints);
    }
}
