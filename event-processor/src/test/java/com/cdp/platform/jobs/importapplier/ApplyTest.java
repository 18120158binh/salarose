package com.cdp.platform.jobs.importapplier;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Arrays;
import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.IntStream;

import com.cdp.platform.jobs.importapplier.MemoryStores.Crash;
import com.cdp.platform.jobs.importapplier.MemoryStores.Drops;
import com.cdp.platform.jobs.importapplier.MemoryStores.Kept;
import com.cdp.platform.jobs.importapplier.MemoryStores.Run;
import com.cdp.platform.jobs.importapplier.MemoryStores.Runs;
import com.cdp.platform.jobs.importapplier.MemoryStores.Store;
import com.cdp.platform.shared.models.imports.DatasetVersion;
import com.cdp.platform.shared.utils.JacksonMapper;
import com.cdp.platform.shared.utils.PlaceholderIds;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * Apply, crash safety, and re-derive, end to end through recovery, the queue,
 * and the processor, over in-memory stores that keep their state across a
 * simulated crash. Each case compares the stored rows with a clean run.
 */
class ApplyTest {

    static final String ORDERS = "00000000-0000-0000-0000-0000000000a1";
    static final String CUSTOMERS = "00000000-0000-0000-0000-0000000000c1";
    static final String ORDERS_HEADER = "order_id,customer_id,event_time,updated_at,amount,deleted\n";
    static final String CUSTOMERS_HEADER = "customer_id,name,email,age\n";
    static final ApplierConfig CONFIG = new ApplierConfig(null, "", "", "", "bucket", "k".repeat(32), "VN",
        PlaceholderIds.DEFAULT, Limits.DEFAULT);

    static DatasetVersion orders(int version, String zone, String keyColumn) {
        return DatasetVersion
            .parse(ORDERS, version, "event",
                JacksonMapper
                    .readTree("[{\"name\":\"order_id\",\"type\":\"string\"},"
                        + "{\"name\":\"customer_id\",\"type\":\"string\"},{\"name\":\"buyer_id\",\"type\":\"string\"},"
                        + "{\"name\":\"event_time\",\"type\":\"datetime\"},"
                        + "{\"name\":\"updated_at\",\"type\":\"datetime\"},{\"name\":\"amount\",\"type\":\"number\"},"
                        + "{\"name\":\"deleted\",\"type\":\"boolean\"}]"),
                JacksonMapper
                    .readTree("{\"customer_key\":\"" + keyColumn + "\",\"record_id\":\"order_id\","
                        + "\"event_time\":\"event_time\",\"updated_at\":\"updated_at\",\"deleted_flag\":\"deleted\"}"),
                "incremental", zone, ",");
    }

    static DatasetVersion customers() {
        return DatasetVersion
            .parse(CUSTOMERS, 1, "profile",
                JacksonMapper
                    .readTree("[{\"name\":\"customer_id\",\"type\":\"string\"},{\"name\":\"name\",\"type\":\"string\"},"
                        + "{\"name\":\"email\",\"type\":\"string\"},{\"name\":\"age\",\"type\":\"number\"}]"),
                JacksonMapper.readTree("{\"customer_key\":\"customer_id\",\"email\":\"email\"}"), "snapshot",
                "Asia/Ho_Chi_Minh", ",");
    }

    /** One deployment: the stores, and an applier start over them. */
    static final class Applier {
        final Runs runs = new Runs();
        final Store store = new Store();
        final Drops drops = new Drops();

        Applier(DatasetVersion... versions) {
            for (DatasetVersion version : versions)
                runs.versions.put(version.recordTypeId(), version);
        }

        Run deliver(String runId, String recordTypeId, String source, String writer, String csv, int minute) {
            byte[] bytes = csv.getBytes(StandardCharsets.UTF_8);
            String key = "imports/incoming/" + writer + "/" + runId + ".csv";
            drops.objects.put(key, bytes);
            Run run = new Run(runId, recordTypeId, source, writer, "csv", (long) bytes.length, key,
                MemoryStores.sha256(bytes), Instant.parse("2026-11-14T01:00:00Z").plusSeconds(60L * minute));
            runs.runs.put(runId, run);
            return run;
        }

        Run rederive(String runId, String recordTypeId, int minute) {
            Run run = new Run(runId, recordTypeId, "rederive", "rederive", null, null, null, null,
                Instant.parse("2026-11-14T01:00:00Z").plusSeconds(60L * minute));
            runs.runs.put(runId, run);
            return run;
        }

        /** One applier start: recovery, then the queue until it is empty. */
        void start() throws Exception {
            try {
                ImportApplierMain.recover(runs, store);
                ImportApplierMain
                    .drain(runs, new RunProcessor(runs, MemoryStores.lookups(store), store, drops, CONFIG,
                        new Tombstones(CONFIG.tombstoneKey(), runs.tombstones()), LockGuard.none()));
            } catch (Crash crash) {
                store.crashed();
                throw crash;
            }
        }

        String state(String runId) {
            return runs.runs.get(runId).state;
        }

        Kept record(String recordId) {
            return store.committed.records().get(ORDERS + "/" + recordId);
        }

        Kept profile(String customerKey) {
            return store.committed.profiles().get(CUSTOMERS + "/" + customerKey);
        }
    }

    static String orderRows(int from, int to, String updatedAt, int amount) {
        return IntStream
            .range(from, to)
            .mapToObj(i -> "o-%d,c-%d,2026-11-07T08:00:00,%s,%d,false\n".formatted(i, i % 50, updatedAt, amount))
            .collect(Collectors.joining());
    }

    static String customerRows(String... keys) {
        return Arrays
            .stream(keys)
            .map(key -> key + ",Name " + key + "," + key + "@Example.com,30\n")
            .collect(Collectors.joining());
    }

    static Applier cleanOrders(String csv) throws Exception {
        Applier clean = new Applier(orders(1, "Asia/Ho_Chi_Minh", "customer_id"));
        clean.deliver("run-1", ORDERS, "drop", "sk_1", csv, 0);
        clean.start();
        assertEquals("applied", clean.state("run-1"));
        return clean;
    }

    @Test
    void aValidatedRunAppliesItsRowsAndItsCommitMarker() throws Exception {
        Applier applier = cleanOrders(ORDERS_HEADER + orderRows(0, 3, "2026-11-07T09:00:00", 5));
        assertEquals(3, applier.store.committed.records().size());
        Kept row = applier.record("o-1");
        assertEquals("c-1", row.customerKey());
        assertEquals("sk_1", row.writer());
        assertEquals("run-1", row.runId());
        assertEquals(Instant.parse("2026-11-07T01:00:00Z"), row.eventTime());
        assertEquals(3, applier.runs.runs.get("run-1").counts.get("rows_new").asLong());
        assertEquals(applier.runs.runs.get("run-1").counts.toString(), applier.store.committed.markers().get("run-1"));
    }

    @Test
    void aFileReplayedTwiceEqualsOneCleanRun() throws Exception {
        String csv = ORDERS_HEADER + orderRows(0, 1200, "2026-11-07T09:00:00", 5);
        Applier clean = cleanOrders(csv);
        Applier replayed = cleanOrders(csv);
        replayed.deliver("run-2", ORDERS, "drop", "sk_1", csv, 5);
        int writesBefore = replayed.store.writes;
        replayed.start();

        assertEquals("applied", replayed.state("run-2"));
        assertEquals(clean.store.committed.rows(), replayed.store.committed.rows());
        assertEquals(1200, replayed.runs.runs.get("run-2").counts.get("rows_unchanged").asLong());
        assertEquals(writesBefore, replayed.store.writes, "an unchanged row of the same writer is not rewritten");
    }

    @Test
    void aCrashBetweenBatchesLeavesTheStoreAsBeforeAndTheRestartEqualsOneCleanRun() throws Exception {
        String csv = ORDERS_HEADER + orderRows(0, 2500, "2026-11-07T09:00:00", 5);
        Applier clean = cleanOrders(csv);

        Applier crashed = new Applier(orders(1, "Asia/Ho_Chi_Minh", "customer_id"));
        crashed.deliver("run-1", ORDERS, "drop", "sk_1", csv, 0);
        crashed.store.crashAfterWrites = 1;
        assertThrows(Crash.class, crashed::start);
        assertEquals("applying", crashed.state("run-1"));
        assertTrue(crashed.store.committed.records().isEmpty(), "the first batch did not commit");

        crashed.store.crashAfterWrites = -1;
        crashed.start();
        assertEquals("applied", crashed.state("run-1"));
        assertEquals(clean.store.committed.rows(), crashed.store.committed.rows());
        assertEquals(clean.runs.runs.get("run-1").counts, crashed.runs.runs.get("run-1").counts);
    }

    @Test
    void aCrashAfterTheCommitEndsAppliedWithTheMarkersCountsAndWritesNothingTwice() throws Exception {
        String csv = ORDERS_HEADER + orderRows(0, 1500, "2026-11-07T09:00:00", 5);
        Applier clean = cleanOrders(csv);

        Applier crashed = new Applier(orders(1, "Asia/Ho_Chi_Minh", "customer_id"));
        crashed.deliver("run-1", ORDERS, "drop", "sk_1", csv, 0);
        crashed.runs.crashOnMarkApplied = true;
        assertThrows(Crash.class, crashed::start);
        assertEquals("applying", crashed.state("run-1"));
        int writes = crashed.store.writes;

        crashed.start();
        assertEquals("applied", crashed.state("run-1"));
        assertEquals(writes, crashed.store.writes);
        assertEquals(crashed.store.committed.markers().get("run-1"), crashed.runs.runs.get("run-1").counts.toString());
        assertEquals(clean.store.committed.rows(), crashed.store.committed.rows());
    }

    @Test
    void runsAppliedOutOfOrderKeepTheLaterUpdatedAt() throws Exception {
        String older = ORDERS_HEADER + orderRows(0, 100, "2026-11-07T09:00:00", 1);
        String newer = ORDERS_HEADER + orderRows(0, 100, "2026-11-07T10:00:00", 2);
        Applier inOrder = new Applier(orders(1, "Asia/Ho_Chi_Minh", "customer_id"));
        inOrder.deliver("run-old", ORDERS, "drop", "sk_1", older, 0);
        inOrder.deliver("run-new", ORDERS, "drop", "sk_1", newer, 5);
        inOrder.start();

        Applier reversed = new Applier(orders(1, "Asia/Ho_Chi_Minh", "customer_id"));
        reversed.deliver("run-new", ORDERS, "drop", "sk_1", newer, 0);
        reversed.deliver("run-old", ORDERS, "drop", "sk_1", older, 5);
        reversed.start();

        assertEquals(inOrder.store.committed.rows(), reversed.store.committed.rows());
        assertTrue(reversed.record("o-7").data().contains("\"amount\":2"));
        assertEquals("run-new", reversed.record("o-7").runId());
        assertEquals(100, reversed.runs.runs.get("run-old").counts.get("rows_unchanged").asLong());
    }

    @Test
    void aHeldIncrementalRunWithUpdatedAtLetsLaterRunsPassAndKeepsTheirValuesWhenApproved() throws Exception {
        // Ten rows of 100 have an unreadable event time: 10% rejects, over the 5%
        // threshold.
        String held = ORDERS_HEADER + orderRows(0, 90, "2026-11-07T09:00:00", 1)
            + IntStream
                .range(90, 100)
                .mapToObj(i -> "o-%d,c-1,yesterday,,1,false\n".formatted(i))
                .collect(
                    Collectors.joining());
        String later = ORDERS_HEADER + orderRows(0, 90, "2026-11-07T10:00:00", 2);
        Applier applier = new Applier(orders(1, "Asia/Ho_Chi_Minh", "customer_id"));
        applier.deliver("run-held", ORDERS, "drop", "sk_1", held, 0);
        applier.deliver("run-later", ORDERS, "drop", "sk_1", later, 5);
        applier.start();
        assertEquals(OpenRun.QUARANTINED, applier.state("run-held"));
        assertEquals("applied", applier.state("run-later"));

        applier.runs.approve("run-held");
        applier.start();
        assertEquals("applied", applier.state("run-held"));
        assertEquals(cleanOrders(later).store.committed.rows(),
            applier.store.committed.rows().replace("run-later", "run-1"));
    }

    @Test
    void aDeletedFlagRemovesTheStoredRowUnlessItsUpdatedAtIsLater() throws Exception {
        Applier applier = cleanOrders(ORDERS_HEADER + orderRows(0, 3, "2026-11-07T09:00:00", 5));
        applier
            .deliver("run-2", ORDERS, "drop", "sk_1",
                ORDERS_HEADER + "o-1,c-1,2026-11-07T08:00:00,2026-11-07T09:30:00,5,true\n"
                    + "o-2,c-2,2026-11-07T08:00:00,2026-11-07T08:30:00,5,true\n",
                5);
        applier.start();
        assertEquals(null, applier.record("o-1"));
        assertNotNull(applier.record("o-2"), "the stored row's updated_at is later");
        assertEquals(1, applier.runs.runs.get("run-2").counts.get("rows_removed").asLong());
    }

    @Test
    void aRejectedRowNeverChangesItsStoredRow() throws Exception {
        Applier applier = cleanOrders(ORDERS_HEADER + orderRows(0, 100, "2026-11-07T09:00:00", 5));
        Kept before = applier.record("o-1");
        applier
            .deliver("run-2", ORDERS, "drop", "sk_2",
                ORDERS_HEADER + "o-1,c-1,2026-11-07T08:00:00,2026-11-07T10:00:00,lots,false\n"
                    + orderRows(2, 100, "2026-11-07T09:00:00", 5),
                5);
        applier.start();
        assertEquals("applied", applier.state("run-2"));
        assertEquals(before, applier.record("o-1"));
    }

    @Test
    void aRejectedRowWithAKeyProtectsItsStoredRowFromSnapshotRemoval() throws Exception {
        Applier applier = new Applier(customers());
        applier.deliver("run-1", CUSTOMERS, "drop", "sk_12", CUSTOMERS_HEADER + customerRows("c-1", "c-2", "c-3"), 0);
        applier.start();
        Kept c2 = applier.profile("c-2");

        // c-2 is rejected as type_mismatch:age and keeps its row. The reject
        // without a key protects nothing, so c-3 goes. Two rejects in four rows
        // quarantine the run, and the admin approves it (IAP-FR-11).
        applier
            .deliver("run-2", CUSTOMERS, "drop", "sk_12",
                CUSTOMERS_HEADER + customerRows("c-1") + "c-2,Changed,c-2@example.com,old\n,No key,x@example.com,1\n"
                    + customerRows("c-4"),
                5);
        applier.start();
        assertEquals(OpenRun.QUARANTINED, applier.state("run-2"));
        applier.runs.approve("run-2");
        applier.start();
        assertEquals("applied", applier.state("run-2"));
        assertEquals(c2, applier.profile("c-2"));
        assertEquals(null, applier.profile("c-3"));
        assertNotNull(applier.profile("c-4"));
    }

    @Test
    void aSnapshotRemovesWhatItsFileLacksSparesStudioRowsAndHandsRowsToANewKey() throws Exception {
        Applier applier = new Applier(customers());
        String[] ten = IntStream.range(0, 10).mapToObj(i -> "c-" + i).toArray(String[]::new);
        applier.deliver("run-1", CUSTOMERS, "drop", "sk_12", CUSTOMERS_HEADER + customerRows(ten), 0);
        applier.start();
        assertEquals(10, applier.store.committed.profiles().size());

        // A studio upload to a snapshot type applies as incremental: it removes
        // nothing.
        applier
            .deliver("run-studio", CUSTOMERS, "studio", "studio",
                CUSTOMERS_HEADER + "c-1,Corrected,c-1@example.com,31\nc-99,Studio only,c-99@example.com,40\n", 5);
        applier.start();
        assertEquals(11, applier.store.committed.profiles().size());
        assertEquals("studio", applier.profile("c-1").writer());

        // sk_12 delivers c-1 again: its values and writer win. c-99 is studio's and
        // stays.
        applier.deliver("run-2", CUSTOMERS, "drop", "sk_12", CUSTOMERS_HEADER + customerRows(ten), 10);
        applier.start();
        assertEquals("sk_12", applier.profile("c-1").writer());
        assertTrue(applier.profile("c-1").data().contains("Name c-1"));
        assertEquals("studio", applier.profile("c-99").writer());

        // A new key's snapshot of nine: it takes every row it holds, and c-9 goes.
        String[] nine = IntStream.range(0, 9).mapToObj(i -> "c-" + i).toArray(String[]::new);
        applier.deliver("run-3", CUSTOMERS, "drop", "sk_20", CUSTOMERS_HEADER + customerRows(nine), 15);
        applier.start();
        assertEquals("applied", applier.state("run-3"));
        assertEquals(null, applier.profile("c-9"));
        assertEquals("sk_20", applier.profile("c-0").writer());
        assertEquals("run-3", applier.profile("c-0").runId());
        assertEquals(9, applier.runs.runs.get("run-3").counts.get("rows_unchanged").asLong());
        assertEquals(1, applier.runs.runs.get("run-3").counts.get("rows_removed").asLong());
        assertEquals(List.of("email:c-0@example.com@sk_20"),
            applier.store.committed.identifiers().get(CUSTOMERS + "/c-0"));
        assertNotNull(applier.profile("c-99"));
    }

    @Test
    void aRederiveEqualsApplyingEveryRunAgainWithTheNewVersion() throws Exception {
        // Times without an offset: a new time zone moves every event time.
        String first = ORDERS_HEADER + orderRows(0, 1200, "2026-11-07T09:00:00", 1);
        String second = ORDERS_HEADER + orderRows(600, 1800, "2026-11-07T10:00:00", 2);
        Applier applier = new Applier(orders(1, "Asia/Ho_Chi_Minh", "customer_id"));
        applier.deliver("run-1", ORDERS, "drop", "sk_1", first, 0);
        applier.deliver("run-2", ORDERS, "drop", "sk_1", second, 5);
        applier.start();

        DatasetVersion utc = orders(2, "UTC", "customer_id");
        applier.runs.versions.put(ORDERS, utc);
        applier.rederive("run-rederive", ORDERS, 10);
        applier.start();
        assertEquals("applied", applier.state("run-rederive"));

        Applier reapplied = new Applier(utc);
        reapplied.deliver("run-1", ORDERS, "drop", "sk_1", first, 0);
        reapplied.deliver("run-2", ORDERS, "drop", "sk_1", second, 5);
        reapplied.start();
        assertEquals(reapplied.store.committed.rows(), applier.store.committed.rows());
        assertEquals(Instant.parse("2026-11-07T08:00:00Z"), applier.record("o-1").eventTime());
        assertTrue(applier.store.committed.markers().containsKey("run-rederive"));
    }

    @Test
    void aRederiveWhoseFileFailsRollsBackAndIsQuarantined() throws Exception {
        Applier applier = cleanOrders(ORDERS_HEADER + orderRows(0, 1200, "2026-11-07T09:00:00", 1));
        String before = applier.store.committed.rows();

        applier.runs.versions.put(ORDERS, orders(2, "Asia/Ho_Chi_Minh", "buyer_id"));
        applier.rederive("run-rederive", ORDERS, 10);
        applier.start();
        assertEquals(OpenRun.QUARANTINED, applier.state("run-rederive"));
        assertEquals("run-1: role_missing:customer_key", applier.runs.runs.get("run-rederive").reason);
        assertEquals(before, applier.store.committed.rows());
        assertFalse(applier.store.committed.markers().containsKey("run-rederive"));
    }
}
