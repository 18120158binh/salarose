package com.cdp.platform.jobs.importapplier;

import java.time.Period;
import java.util.List;

import com.cdp.platform.shared.models.imports.DatasetVersion;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

class DecisionTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static DatasetVersion customers(String mode) throws Exception {
        return DatasetVersion
            .parse("00000000-0000-0000-0000-000000000002", 1, "profile",
                JSON.readTree("[{\"name\":\"id\",\"type\":\"string\"}]"), JSON.readTree("{\"customer_key\":\"id\"}"),
                mode, "Asia/Ho_Chi_Minh", ",");
    }

    private static ValidationStats stats(long rows, long valid) {
        ValidationStats stats = new ValidationStats();
        stats.rowsRead = rows;
        stats.valid = valid;
        return stats;
    }

    @Test
    void sixtyRejectsInAThousandBreakTheDefaultThreshold() throws Exception {
        // IAP-FR-09
        assertEquals(List.of(Decision.REJECT_THRESHOLD),
            Decision.conditions(stats(1000, 940), customers("incremental"), true, null, 0, Limits.DEFAULT));
        assertEquals(List.of(),
            Decision.conditions(stats(1000, 950), customers("incremental"), true, null, 0, Limits.DEFAULT));
    }

    @Test
    void aConfiguredThresholdOfTenPercentLetsSixPercentApply() throws Exception {
        // IAP-NFR-03
        Limits limits = new Limits(0.10, 0.8, 5_000_000, Period.ofYears(3), Period.ofDays(1));
        assertEquals(List.of(), Decision
            .conditions(stats(1000, 940), customers("incremental"), true, null, 0,
                limits));
    }

    @Test
    void theShrinkGuardFollowsTheWorkedExample() throws Exception {
        // IAP-FR-10: 99,500 over 80% of 100,000 applies; 60,000 under 80% of 99,500 is
        // held; a new key's
        // 99,400 against 99,500 applies.
        DatasetVersion snapshot = customers("snapshot");
        assertEquals(List.of(), Decision
            .conditions(stats(99_500, 99_500), snapshot, true, 100_000L, 0,
                Limits.DEFAULT));
        assertEquals(List.of(Decision.SNAPSHOT_SHRINK), Decision
            .conditions(stats(60_000, 60_000), snapshot, true,
                99_500L, 0, Limits.DEFAULT));
        assertEquals(List.of(), Decision
            .conditions(stats(99_400, 99_400), snapshot, true, 99_500L, 0,
                Limits.DEFAULT));
    }

    @Test
    void theShrinkGuardSkipsStudioUploadsIncrementalTypesAndFirstSnapshots() throws Exception {
        assertEquals(List.of(), Decision
            .conditions(stats(5, 5), customers("snapshot"), false, 99_500L, 0,
                Limits.DEFAULT));
        assertEquals(List.of(), Decision
            .conditions(stats(5, 5), customers("incremental"), true, 99_500L, 0,
                Limits.DEFAULT));
        assertEquals(List.of(), Decision
            .conditions(stats(5, 5), customers("snapshot"), true, null, 0,
                Limits.DEFAULT));
    }

    @Test
    void theRecordCapCountsOnlyNewRecords() throws Exception {
        ValidationStats stats = stats(10, 10);
        stats.newRecords = 4;
        assertEquals(List.of(), Decision
            .conditions(stats, customers("incremental"), true, null, 4_999_996,
                Limits.DEFAULT));
        assertEquals(List.of(Decision.RECORD_CAP), Decision
            .conditions(stats, customers("incremental"), true, null,
                4_999_997, Limits.DEFAULT));
    }

    @Test
    void everyConditionThatHoldsIsNamed() throws Exception {
        ValidationStats stats = stats(100, 50);
        stats.newRecords = 1;
        assertEquals(List.of(Decision.REJECT_THRESHOLD, Decision.SNAPSHOT_SHRINK, Decision.RECORD_CAP),
            Decision.conditions(stats, customers("snapshot"), true, 1000L, 5_000_000, Limits.DEFAULT));
    }
}
