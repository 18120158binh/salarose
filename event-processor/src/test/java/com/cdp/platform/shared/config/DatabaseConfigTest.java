package com.cdp.platform.shared.config;

import java.util.Map;

import org.apache.flink.util.InstantiationUtil;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

class DatabaseConfigTest {

    @Test
    void theTextFormHidesThePassword() {
        DatabaseConfig database = new DatabaseConfig("db.internal", "5432", "flink", "s3cret", "cdp",
            "jdbc:postgresql://db.internal:5432/cdp", "jdbc:postgresql://replica.internal:5432/cdp", 10);

        assertEquals("DatabaseConfig[host=db.internal, port=5432, user=flink, password=<redacted>, database=cdp, "
            + "readJdbcUrl=jdbc:postgresql://replica.internal:5432/cdp, cdcConfirmDelayCheckpoints=10]",
            database.toString());
    }

    @Test
    void lookupsReadTheReplicaInDbReadHost() {
        DatabaseConfig database = DatabaseConfig
            .fromVariables(Map
                .of("DB_HOST", "primary.internal", "DB_READ_HOST", "replica.internal", "DB_PORT", "6432",
                    "DB_DATABASE", "cdp", "DB_USER", "flink", "DB_PASSWORD", "s3cret"));

        assertEquals("jdbc:postgresql://primary.internal:6432/cdp?reWriteBatchedInserts=true", database.jdbcUrl());
        assertEquals("jdbc:postgresql://replica.internal:6432/cdp?reWriteBatchedInserts=true",
            database.readJdbcUrl());
        assertEquals("flink", database.user());
        assertEquals("s3cret", database.password());
    }

    @Test
    void withoutDbReadHostLookupsReadThePrimary() {
        DatabaseConfig database = DatabaseConfig.fromVariables(Map.of("DB_PASSWORD", "s3cret"));

        assertEquals("jdbc:postgresql://postgres:5432/auroracy?reWriteBatchedInserts=true", database.jdbcUrl());
        assertEquals(database.jdbcUrl(), database.readJdbcUrl());
        assertEquals("postgres", database.user());
    }

    /**
     * At the 30 second checkpoint interval, 10 checkpoints hold about 5
     * minutes of WAL in each slot, under max_slot_wal_keep_size at peak writes.
     */
    @Test
    void cdcSourcesConfirmTenCheckpointsBackByDefault() {
        DatabaseConfig database = DatabaseConfig.fromVariables(Map.of("DB_PASSWORD", "s3cret"));

        assertEquals(10, database.cdcConfirmDelayCheckpoints());
    }

    @Test
    void cdcConfirmDelayCheckpointsSetsTheDelay() {
        DatabaseConfig database = DatabaseConfig
            .fromVariables(Map.of("DB_PASSWORD", "s3cret", "CDC_CONFIRM_DELAY_CHECKPOINTS", "40"));

        assertEquals(40, database.cdcConfirmDelayCheckpoints());
    }

    @Test
    void aJobWithADelayOfNoCheckpointsDoesNotStart() {
        IllegalArgumentException failure = assertThrows(IllegalArgumentException.class, () -> DatabaseConfig
            .fromVariables(Map.of("DB_PASSWORD", "s3cret", "CDC_CONFIRM_DELAY_CHECKPOINTS", "0")));

        assertEquals("CDC_CONFIRM_DELAY_CHECKPOINTS must be above 0, but is 0", failure.getMessage());
    }

    @Test
    void aJobWithoutDbPasswordDoesNotStart() {
        IllegalStateException failure = assertThrows(IllegalStateException.class,
            () -> DatabaseConfig.fromVariables(Map.of("DB_PASSWORD", " ")));

        assertEquals("DB_PASSWORD is not set", failure.getMessage());
    }

    /** Functions carry the settings to the task managers. */
    @Test
    void theSettingsReachATaskManagerUnchanged() throws Exception {
        DatabaseConfig database = new DatabaseConfig("db.internal", "5432", "flink", "s3cret", "cdp",
            "jdbc:postgresql://db.internal:5432/cdp", "jdbc:postgresql://replica.internal:5432/cdp", 10);

        assertEquals(database, InstantiationUtil.clone(database));
    }
}
