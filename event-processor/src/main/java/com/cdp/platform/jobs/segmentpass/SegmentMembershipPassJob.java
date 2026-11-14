package com.cdp.platform.jobs.segmentpass;

import java.sql.Connection;
import java.sql.DriverManager;
import java.time.Clock;
import java.time.Instant;

import com.cdp.platform.shared.config.DatabaseConfig;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Entry point of the nightly segment membership pass, a plain Java process run
 * by a Kubernetes CronJob from the {@code event-processor} image, not a Flink
 * job. It exits 0 after a pass, or when another pass holds the lock, and 1 on a
 * failure, so the CronJob records it.
 */
public final class SegmentMembershipPassJob {

    private static final Logger LOG = LoggerFactory.getLogger(SegmentMembershipPassJob.class);

    private SegmentMembershipPassJob() {
    }

    public static void main(String[] args) {
        try {
            SegmentPassSettings settings = SegmentPassSettings.fromVariables(System.getenv());
            DatabaseConfig database = DatabaseConfig.fromEnvironment();
            Clock clock = Clock.systemUTC();
            Instant scheduledTime = settings.scheduledTime(clock.instant());
            try (Connection connection = DriverManager
                .getConnection(database.jdbcUrl(), database.user(), database.password());
                Connection readings = DriverManager
                    .getConnection(database.jdbcUrl(), database.user(), database.password());
                JdbcPassStore store = new JdbcPassStore(connection)) {
                WalGovernor governor = new WalGovernor(
                    new PostgresReadings(readings, settings.freeDiskQuery(), settings.claimBytes()),
                    settings.thresholds(), duration -> Thread.sleep(duration), System::nanoTime);
                new SegmentMembershipPass(store, governor, settings, clock, duration -> Thread.sleep(duration))
                    .run(scheduledTime);
            }
            System.exit(0);
        } catch (Exception | Error failure) {
            LOG.error("Segment membership pass failed", failure);
            System.exit(1);
        }
    }
}
