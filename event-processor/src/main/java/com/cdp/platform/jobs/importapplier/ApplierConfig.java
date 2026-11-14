package com.cdp.platform.jobs.importapplier;

import java.time.DateTimeException;
import java.time.Period;
import java.util.Map;

import com.cdp.platform.shared.config.DatabaseConfig;
import com.cdp.platform.shared.utils.PlaceholderIds;

/**
 * The applier's settings, read once at start. A missing required value or a
 * malformed one stops the applier before it takes the lock. The variables are
 * listed in {@code docs/internal/operations/configuration.md}.
 *
 * @param tombstoneKey
 *            the HMAC key of tombstones, used byte for byte as studio uses it
 */
record ApplierConfig(DatabaseConfig main, String importStoreUrl, String importStoreUser, String importStorePassword,
    String bucket, String tombstoneKey, String phoneCountry, PlaceholderIds placeholders, Limits limits) {

    static final int MIN_TOMBSTONE_KEY_LENGTH = 32;

    static ApplierConfig fromEnvironment() {
        return fromVariables(System.getenv(), DatabaseConfig.fromEnvironment());
    }

    static ApplierConfig fromVariables(Map<String, String> env, DatabaseConfig main) {
        String tombstoneKey = env.get("IMPORT_TOMBSTONE_KEY");
        if (tombstoneKey == null || tombstoneKey.length() < MIN_TOMBSTONE_KEY_LENGTH) {
            throw new IllegalStateException("IMPORT_TOMBSTONE_KEY must hold at least 32 characters");
        }
        String url = "jdbc:postgresql://%s:%s/%s"
            .formatted(required(env, "IMPORT_DB_HOST"),
                env.getOrDefault("IMPORT_DB_PORT", "5432"), required(env, "IMPORT_DB_DATABASE"));
        Limits limits = new Limits(share(env, "IMPORT_REJECT_THRESHOLD", Limits.DEFAULT.rejectThreshold()),
            share(env, "IMPORT_SHRINK_RATIO", Limits.DEFAULT.shrinkRatio()),
            positive(env, "IMPORT_RECORD_CAP", Limits.DEFAULT.recordCap()),
            period(env, "IMPORT_HISTORY_LIMIT", Limits.DEFAULT.historyLimit()),
            period(env, "IMPORT_FUTURE_LIMIT", Limits.DEFAULT.futureLimit()));
        return new ApplierConfig(main, url, required(env, "IMPORT_DB_USER"), required(env, "IMPORT_DB_PASSWORD"),
            required(env, "IMPORTS_BUCKET"), tombstoneKey, env.getOrDefault("IMPORT_DEFAULT_PHONE_COUNTRY", "VN"),
            PlaceholderIds.parse(env.get(PlaceholderIds.VARIABLE)), limits);
    }

    private static String required(Map<String, String> env, String name) {
        String value = env.get(name);
        if (value == null || value.isBlank()) throw new IllegalStateException(name + " is not set");
        return value.trim();
    }

    private static double share(Map<String, String> env, String name, double fallback) {
        String value = env.get(name);
        if (value == null || value.isBlank()) return fallback;
        try {
            double share = Double.parseDouble(value.trim());
            if (share >= 0 && share <= 1) return share;
        } catch (NumberFormatException e) {
            // Reported below.
        }
        throw new IllegalStateException(name + " must be a number from 0 to 1: " + value);
    }

    private static long positive(Map<String, String> env, String name, long fallback) {
        String value = env.get(name);
        if (value == null || value.isBlank()) return fallback;
        try {
            long parsed = Long.parseLong(value.trim());
            if (parsed > 0) return parsed;
        } catch (NumberFormatException e) {
            // Reported below.
        }
        throw new IllegalStateException(name + " must be a positive integer: " + value);
    }

    private static Period period(Map<String, String> env, String name, Period fallback) {
        String value = env.get(name);
        if (value == null || value.isBlank()) return fallback;
        try {
            Period parsed = Period.parse(value.trim());
            if (!parsed.isNegative() && !parsed.isZero()) return parsed;
        } catch (DateTimeException e) {
            // Reported below.
        }
        throw new IllegalStateException(name + " must be a positive ISO-8601 period such as P3Y: " + value);
    }

    @Override
    public String toString() {
        return "ApplierConfig[main=%s, importStoreUrl=%s, bucket=%s, phoneCountry=%s, limits=%s]"
            .formatted(main,
                importStoreUrl, bucket, phoneCountry, limits);
    }
}
