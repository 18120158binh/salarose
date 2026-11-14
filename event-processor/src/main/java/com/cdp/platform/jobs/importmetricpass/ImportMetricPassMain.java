package com.cdp.platform.jobs.importmetricpass;

import java.sql.Connection;
import java.sql.DriverManager;
import java.time.Clock;
import java.util.Map;

import com.cdp.platform.shared.batch.LockGuard;
import com.cdp.platform.shared.batch.PostgresReadings;
import com.cdp.platform.shared.batch.WalGovernor;
import com.cdp.platform.shared.config.DatabaseConfig;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The import metric pass: a batch process with no Flink, run by a Kubernetes
 * CronJob every 10 minutes. It takes the pass lock, fails a pass a crash left
 * at {@code running}, starts tonight's pass or a requested retry, and exits
 * (docs/internal/architecture/components/import-metric-pass.md). It exits 0
 * when there is nothing to do or another instance holds the lock, and 1 when
 * a pass fails, so the CronJob records it.
 */
public final class ImportMetricPassMain {

    private static final Logger LOG = LoggerFactory.getLogger(ImportMetricPassMain.class);

    private ImportMetricPassMain() {
    }

    public static void main(String[] args) {
        try {
            System.exit(run(System.getenv()) == MetricPass.Result.FAILED ? 1 : 0);
        } catch (Exception | Error failure) {
            LOG.error("Import metric pass failed", failure);
            System.exit(1);
        }
    }

    private static MetricPass.Result run(Map<String, String> env) throws Exception {
        MetricPassSettings settings = MetricPassSettings.fromVariables(env);
        DatabaseConfig main = DatabaseConfig.fromEnvironment();
        String importUrl = "jdbc:postgresql://%s:%s/%s"
            .formatted(required(env, "IMPORT_DB_HOST"), env.getOrDefault("IMPORT_DB_PORT", "5432"),
                required(env, "IMPORT_DB_DATABASE"));
        String importUser = required(env, "IMPORT_DB_USER");
        String importPassword = required(env, "IMPORT_DB_PASSWORD");
        LOG.info("import metric pass starting with {}", settings);
        Clock clock = Clock.systemUTC();
        try (Connection lockConnection = DriverManager.getConnection(main.jdbcUrl(), main.user(), main.password())) {
            LockGuard lock = LockGuard.tryAcquire(lockConnection, LockGuard.IMPORT_METRIC_PASS);
            if (lock == null) {
                LOG.info("another pass holds the lock; exiting");
                return MetricPass.Result.NOTHING_TO_DO;
            }
            try (Connection writes = DriverManager.getConnection(main.jdbcUrl(), main.user(), main.password());
                Connection readingsConnection = DriverManager
                    .getConnection(main.jdbcUrl(), main.user(), main.password());
                Connection importStore = DriverManager.getConnection(importUrl, importUser, importPassword)) {
                PostgresReadings readings = new PostgresReadings(readingsConnection, settings.freeDiskQuery(),
                    settings.claimBytes(), clock);
                readings.sampleClusterRate();
                WalGovernor governor = new WalGovernor(readings, settings.thresholds(), Thread::sleep, clock);
                return new MetricPass(new PostgresPassLedger(writes),
                    () -> PostgresImportSnapshot.open(importStore, settings.zone()), governor, settings, lock, clock,
                    Thread::sleep).run();
            }
        }
    }

    private static String required(Map<String, String> env, String name) {
        String value = env.get(name);
        if (value == null || value.isBlank()) throw new IllegalStateException(name + " is not set");
        return value.trim();
    }
}
