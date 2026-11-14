package com.cdp.platform.jobs.importmetricpass;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.OptionalDouble;
import java.util.Set;
import java.util.UUID;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

import com.cdp.platform.jobs.importmetricpass.PassLedger.RowKey;
import com.cdp.platform.shared.batch.LockGuard;
import com.cdp.platform.shared.batch.Tombstones;
import com.cdp.platform.shared.batch.WalGovernor;
import com.cdp.platform.shared.models.imports.DatasetVersion;
import com.cdp.platform.shared.utils.JacksonMapper;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.DoubleNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

/**
 * One start of the import metric pass over an in-memory main Postgres and
 * import store (docs/internal/architecture/components/import-metric-pass.md,
 * Acceptance criteria).
 */
class MetricPassTest {

    static final String KEY = "k".repeat(32);
    static final String CUSTOMERS = "22222222-2222-2222-2222-222222222222";
    // 2026-11-08T03:05+07:00, just after the night's scheduled time.
    static final Instant NOW = Instant.parse("2026-11-07T20:05:00Z");
    static final Instant AS_OF = Instant.parse("2026-11-07T20:00:00Z");
    static final MetricPassSettings SETTINGS = MetricPassSettings
        .fromVariables(Map.of("IMPORT_TOMBSTONE_KEY", KEY, "METRIC_PASS_BATCH_SIZE", "2"));

    final Ledger ledger = new Ledger();
    final Store store = new Store();
    final Deque<WalGovernor.Reading> readings = new ArrayDeque<>();
    final List<Duration> ownRateSleeps = new ArrayList<>();
    Instant now = NOW;

    @Test
    void aNightWithNoDeliveryStillRunsAPassForThatNight() throws Exception {
        assertEquals(MetricPass.Result.DONE, pass().run());

        assertEquals(1, ledger.passes.size());
        assertEquals(AS_OF, ledger.passes.getFirst().asOf);
        assertEquals("done", ledger.passes.getFirst().state);
    }

    @Test
    void aSecondStartTheSameNightInsertsNothing() throws Exception {
        pass().run();

        assertEquals(MetricPass.Result.NOTHING_TO_DO, pass().run());
        assertEquals(1, ledger.passes.size());
    }

    @Test
    void aPassLeftRunningByACrashFailsBeforeTheNewPassExists() throws Exception {
        Ledger.Pass crashed = ledger.add(AS_OF.minus(Duration.ofDays(1)), "running");

        pass().run();

        assertEquals("failed", crashed.state);
        assertEquals("crashed", crashed.reason);
        assertEquals(List.of("failRunning", "insert"), ledger.calls.subList(0, 2));
    }

    @Test
    void writesOnlyRowsWhoseHashChangedAndNothingOnAnUnchangedNight() throws Exception {
        store.orders.add(event("0912345678", Map.of("orders_90d", DoubleNode.valueOf(3))));
        store.orders.add(event("c-2", Map.of("orders_90d", DoubleNode.valueOf(1))));
        pass().run();
        assertEquals(2, ledger.rows.size());
        assertEquals(2, ledger.passes.getLast().changedRows);

        now = NOW.plus(Duration.ofDays(1));
        store.orders.set(1, event("c-2", Map.of("orders_90d", DoubleNode.valueOf(2))));
        pass().run();
        assertEquals(1, ledger.passes.getLast().changedRows);

        now = NOW.plus(Duration.ofDays(2));
        int upserts = ledger.upsertedRows;
        pass().run();
        assertEquals(0, ledger.passes.getLast().changedRows);
        assertEquals(upserts, ledger.upsertedRows);
    }

    @Test
    void deletesARowThatNoRecordBacksAnymore() throws Exception {
        store.orders.add(event("c-1", Map.of("orders_90d", DoubleNode.valueOf(1))));
        pass().run();

        store.orders.clear();
        now = NOW.plus(Duration.ofDays(1));
        pass().run();

        assertEquals(Map.of(), ledger.rows);
        assertEquals(1, ledger.passes.getLast().changedRows);
    }

    @Test
    void anArchivedMetricKeepsItsStoredValueAndItsRow() throws Exception {
        ledger.store("c-1", "orders", "{\"aov\":150,\"spend_90d\":300}");
        ledger.store("c-2", "orders", "{\"aov\":90}");
        store.archived.add("aov");
        store.orders.add(event("c-1", Map.of("spend_90d", DoubleNode.valueOf(450))));
        String c2Pass = ledger.rows.get(new RowKey("c-2", "orders")).passId;

        pass().run();

        assertEquals("{\"aov\":150,\"spend_90d\":450}", ledger.rows.get(new RowKey("c-1", "orders")).attributes);
        assertEquals("{\"aov\":90}", ledger.rows.get(new RowKey("c-2", "orders")).attributes);
        assertEquals(c2Pass, ledger.rows.get(new RowKey("c-2", "orders")).passId);
    }

    @Test
    void aTombstonedKeyGetsNoRowAndLosesItsStoredRows() throws Exception {
        ledger.store("c-4", "orders", "{\"orders_90d\":1}");
        ledger.store("c-4", "customers", "{\"loyalty_tier\":\"Gold\"}");
        store.orders.add(event("c-4", Map.of("orders_90d", DoubleNode.valueOf(2))));
        ledger.tombstones.add(Tombstones.of(KEY, "c-4"));

        pass().run();

        assertEquals(Map.of(), ledger.rows);
    }

    @Test
    void aProfileRowHoldsItsColumnsAndSortedIdentifiersAndCountsSharedValues() throws Exception {
        store.profiles
            .add(new ImportSnapshot.ProfileRow("c-1",
                JacksonMapper.readTree("{\"customer_id\":\"c-1\",\"loyalty_tier\":\"Gold\",\"dropped\":1}"),
                List.of("b@x.vn", "ann@example.com"), List.of()));
        store.profiles
            .add(new ImportSnapshot.ProfileRow("c-2", JacksonMapper.readTree("{\"customer_id\":\"c-2\"}"),
                List.of("ann@example.com"), List.of("+84000000000")));
        store.shared.add("email:ann@example.com");

        pass().run();

        assertEquals("{\"customer_id\":\"c-1\",\"emails\":[\"ann@example.com\",\"b@x.vn\"],\"loyalty_tier\":\"Gold\"}",
            ledger.rows.get(new RowKey("c-1", "customers")).attributes);
        assertEquals(2, ledger.passes.getLast().counts.path("shared_values").asLong());
    }

    @Test
    void includesExactlyTheSnapshotsRunsAndSetsFirstPassIdOnlyWhenDone() throws Exception {
        store.commits.add(new ImportSnapshot.Commit("run-1", Instant.parse("2026-11-07T19:00:00Z")));
        ledger.failUpsertAfter = 0;
        store.orders.add(event("c-1", Map.of("orders_90d", DoubleNode.valueOf(1))));

        assertEquals(MetricPass.Result.FAILED, pass().run());
        assertEquals(Map.of(), ledger.firstPass);
        assertEquals("IllegalStateException", ledger.passes.getLast().reason);

        now = NOW.plus(Duration.ofDays(1));
        ledger.failUpsertAfter = Integer.MAX_VALUE;
        pass().run();
        assertEquals(ledger.passes.getLast().id, ledger.firstPass.get("run-1"));
        assertEquals(Instant.parse("2026-11-07T19:00:00Z"), ledger.passes.getLast().lastRunFinishedAt);
    }

    @Test
    void aRetryKeepsItsAsOfWritesTheRestAndConvergesOnACleanPass() throws Exception {
        for (int i = 0; i < 5; i++) {
            store.orders.add(event("c-" + i, Map.of("orders_90d", DoubleNode.valueOf(i))));
        }
        ledger.failUpsertAfter = 1;
        pass().run();
        Ledger.Pass failed = ledger.passes.getLast();
        assertEquals("failed", failed.state);
        assertEquals(2, failed.changedRows);

        failed.retryRequestedAt = now;
        now = NOW.plus(Duration.ofHours(7));
        ledger.failUpsertAfter = Integer.MAX_VALUE;
        assertEquals(MetricPass.Result.DONE, pass().run());

        assertEquals(1, ledger.passes.size());
        assertEquals(AS_OF, failed.asOf);
        assertEquals("done", failed.state);
        assertNull(failed.retryRequestedAt);
        assertEquals(3, failed.changedRows);
        assertEquals(5, ledger.rows.size());
    }

    @Test
    void aRetryIsRefusedOnceALaterPassIsDone() throws Exception {
        Ledger.Pass old = ledger.add(AS_OF.minus(Duration.ofDays(1)), "failed");
        ledger.add(AS_OF, "done");
        old.retryRequestedAt = now;

        assertEquals(MetricPass.Result.NOTHING_TO_DO, pass().run());

        assertEquals("failed", old.state);
        assertNull(old.retryRequestedAt);
    }

    @Test
    void aPassPausedAllDayFailsAtItsDeadlineWithThePauseReason() throws Exception {
        store.orders.add(event("c-1", Map.of("orders_90d", DoubleNode.valueOf(1))));
        WalGovernor.Reading noDisk = new WalGovernor.Reading(OptionalDouble.of(0.9), OptionalDouble.empty(),
            OptionalDouble.of(0));
        for (int i = 0; i < 4000; i++)
            readings.add(noDisk);

        assertEquals(MetricPass.Result.FAILED, pass().run());

        Ledger.Pass pass = ledger.passes.getLast();
        assertEquals("timed_out:disk_reading", pass.reason);
        assertEquals(Instant.parse("2026-11-08T19:45:00Z"), now);
        assertEquals(1, pass.pauses.size());
        assertEquals(Map.of(), ledger.rows);
    }

    @Test
    void publishesOnlyAfterTheSnapshotEnds() throws Exception {
        store.orders.add(event("c-1", Map.of("orders_90d", DoubleNode.valueOf(1))));

        pass().run();

        assertTrue(ledger.snapshotClosedAtFirstWrite);
    }

    @Test
    void holdsItsOwnWalRate() throws Exception {
        store.orders.add(event("c-1", Map.of("orders_90d", DoubleNode.valueOf(1))));
        ledger.walPerStatement = 262_144;

        pass().run();

        assertEquals(List.of(Duration.ofSeconds(1)), ownRateSleeps);
        assertEquals(262_144, ledger.passes.getLast().walBytes);
    }

    @Test
    void aFailedPassLeavesAnUnstampedRetryAlone() throws Exception {
        ledger.add(AS_OF, "failed");

        assertEquals(MetricPass.Result.NOTHING_TO_DO, pass().run());
        assertEquals("failed", ledger.passes.getFirst().state);
    }

    @Test
    void aGovernorPauseEarnsNoBurstOfOwnWal() throws Exception {
        for (int i = 0; i < 4; i++) {
            store.orders.add(event("c-" + i, Map.of("orders_90d", DoubleNode.valueOf(i))));
        }
        ledger.walPerStatement = 262_144;
        WalGovernor.Reading clear = new WalGovernor.Reading(OptionalDouble.of(0.9), OptionalDouble.of(0.9),
            OptionalDouble.of(0));
        WalGovernor.Reading lowSlot = new WalGovernor.Reading(OptionalDouble.of(0.1), OptionalDouble.of(0.9),
            OptionalDouble.of(0));
        readings.add(clear);
        for (int i = 0; i < 80; i++)
            readings.add(lowSlot);

        pass().run();

        assertEquals(Duration.ofMinutes(40), Duration
            .between(ledger.passes.getLast().pauses.getFirst().start(),
                ledger.passes.getLast().pauses.getFirst().end()));
        assertEquals(List.of(Duration.ofSeconds(1), Duration.ofSeconds(1)), ownRateSleeps);
    }

    MetricPass pass() {
        WalGovernor governor = new WalGovernor(
            () -> readings.isEmpty()
                ? new WalGovernor.Reading(OptionalDouble.of(0.9), OptionalDouble.of(0.9), OptionalDouble.of(0))
                : readings.removeFirst(),
            SETTINGS.thresholds(), duration -> now = now.plus(duration), () -> now);
        Clock clock = new Clock() {
            @Override
            public ZoneId getZone() {
                return ZoneOffset.UTC;
            }

            @Override
            public Clock withZone(ZoneId zone) {
                return this;
            }

            @Override
            public Instant instant() {
                return now;
            }
        };
        ledger.snapshotOpen = () -> store.open;
        return new MetricPass(ledger, store::snapshot, governor, SETTINGS, LockGuard.none(), clock, duration -> {
            ownRateSleeps.add(duration);
            now = now.plus(duration);
        });
    }

    static ImportSnapshot.EventRow event(String customerKey, Map<String, JsonNode> values) {
        return new ImportSnapshot.EventRow(customerKey, values);
    }

    /**
     * The import store, with one event dataset {@code orders} and one profile
     * dataset {@code customers}.
     */
    static final class Store {
        final List<ImportSnapshot.EventRow> orders = new ArrayList<>();
        final List<ImportSnapshot.ProfileRow> profiles = new ArrayList<>();
        final List<ImportSnapshot.Commit> commits = new ArrayList<>();
        final Set<String> shared = new HashSet<>();
        final Set<String> archived = new HashSet<>();
        boolean open;

        DatasetVersion customers() {
            return DatasetVersion
                .parse(CUSTOMERS, 1, "profile",
                    JacksonMapper
                        .readTree("[{\"name\":\"customer_id\",\"type\":\"string\"},"
                            + "{\"name\":\"loyalty_tier\",\"type\":\"string\"},{\"name\":\"email\",\"type\":\"string\"}]"),
                    JacksonMapper.readTree("{\"customer_key\":\"customer_id\",\"email\":[\"email\"]}"), "snapshot",
                    "Asia/Ho_Chi_Minh", ",");
        }

        ImportSnapshot snapshot() {
            open = true;
            return new ImportSnapshot() {
                @Override
                public List<Commit> commits() {
                    return List.copyOf(commits);
                }

                @Override
                public void events(DatasetVersion version, List<MetricDefinition> active, Instant asOf,
                    List<MetricDefinition> unusable, Consumer<EventRow> each) {
                    orders.forEach(each);
                }

                @Override
                public void profiles(String recordTypeId, Consumer<ProfileRow> each) {
                    profiles.forEach(each);
                }

                @Override
                public Set<String> sharedIdentifiers() {
                    return Set.copyOf(shared);
                }

                @Override
                public void close() {
                    open = false;
                }
            };
        }
    }

    /** The main Postgres. */
    final class Ledger implements PassLedger {

        final class Pass {
            final UUID id = UUID.randomUUID();
            final Instant asOf;
            String state;
            String reason;
            Instant retryRequestedAt;
            long changedRows;
            long walBytes;
            ObjectNode counts;
            List<WalGovernor.Pause> pauses;
            Instant lastRunFinishedAt;

            Pass(Instant asOf, String state) {
                this.asOf = asOf;
                this.state = state;
            }
        }

        record Row(String attributes, String hash, String passId) {
        }

        final List<Pass> passes = new ArrayList<>();
        final Map<RowKey, Row> rows = new LinkedHashMap<>();
        final Set<String> tombstones = new HashSet<>();
        final Map<String, UUID> firstPass = new HashMap<>();
        final List<String> calls = new ArrayList<>();
        BooleanSupplier snapshotOpen = () -> false;
        Boolean snapshotClosedAtFirstWrite;
        int failUpsertAfter = Integer.MAX_VALUE;
        int upserts;
        int upsertedRows;
        long walPerStatement = 100;

        Pass add(Instant asOf, String state) {
            Pass pass = new Pass(asOf, state);
            passes.add(pass);
            return pass;
        }

        void store(String customerKey, String source, String attributes) {
            String canonical = CanonicalJson.write(JacksonMapper.readTree(attributes));
            rows.put(new RowKey(customerKey, source), new Row(canonical, CanonicalJson.hash(canonical), "earlier"));
        }

        @Override
        public int failRunning() {
            calls.add("failRunning");
            int moved = 0;
            for (Pass pass : passes) {
                if (pass.state.equals("running")) {
                    pass.state = "failed";
                    pass.reason = "crashed";
                    moved++;
                }
            }
            return moved;
        }

        @Override
        public Optional<UUID> insert(Instant asOf) {
            calls.add("insert");
            if (passes.stream().anyMatch(pass -> pass.asOf.equals(asOf))) return Optional.empty();
            return Optional.of(add(asOf, "running").id);
        }

        @Override
        public List<Attempt> retryRequests() {
            return passes
                .stream()
                .filter(pass -> pass.state.equals("failed") && pass.retryRequestedAt != null)
                .map(pass -> new Attempt(pass.id, pass.asOf))
                .toList();
        }

        @Override
        public boolean laterDone(Instant asOf) {
            return passes.stream().anyMatch(pass -> pass.state.equals("done") && pass.asOf.isAfter(asOf));
        }

        @Override
        public void refuseRetry(UUID id) {
            pass(id).retryRequestedAt = null;
        }

        @Override
        public boolean startRetry(UUID id) {
            Pass pass = pass(id);
            pass.state = "running";
            pass.retryRequestedAt = null;
            return true;
        }

        @Override
        public List<Dataset> datasets(Set<String> unreadable) {
            return List
                .of(new Dataset(EventMetricQueryTest.ORDERS, "orders", EventMetricQueryTest.orders()),
                    new Dataset(CUSTOMERS, "customers", store.customers()));
        }

        @Override
        public List<MetricDefinition> definitions() {
            List<MetricDefinition> definitions = new ArrayList<>();
            for (String name : List.of("orders_90d", "spend_90d", "aov")) {
                definitions
                    .add(MetricDefinition
                        .parse(name, EventMetricQueryTest.ORDERS, name, "COUNT", null, JacksonMapper.readTree("[]"), 90,
                            store.archived.contains(name)));
            }
            return definitions;
        }

        @Override
        public Map<RowKey, Stored> storedRows(Map<String, Set<String>> archivedBySource) {
            Map<RowKey, Stored> stored = new HashMap<>();
            rows.forEach((key, row) -> {
                ObjectNode archived = null;
                Set<String> names = archivedBySource.get(key.sourceId());
                if (names != null) {
                    archived = JacksonMapper.instance().createObjectNode();
                    JsonNode object = JacksonMapper.readTree(row.attributes());
                    for (String name : names) {
                        if (object.has(name)) archived.set(name, object.get(name));
                    }
                }
                stored.put(key, new Stored(row.hash(), archived));
            });
            return stored;
        }

        @Override
        public Set<String> tombstoneHashes() {
            return Set.copyOf(tombstones);
        }

        @Override
        public Written upsert(UUID passId, List<Staged> batch) {
            firstWrite();
            if (upserts++ >= failUpsertAfter) throw new IllegalStateException("connection reset");
            for (Staged row : batch) {
                Row before = rows.get(row.key());
                if (before != null && before.hash().equals(row.hash())) continue;
                rows.put(row.key(), new Row(row.attributes(), row.hash(), passId.toString()));
                upsertedRows++;
            }
            return new Written(batch.size(), walPerStatement);
        }

        @Override
        public Written delete(List<RowKey> batch) {
            firstWrite();
            batch.forEach(rows::remove);
            return new Written(batch.size(), walPerStatement);
        }

        @Override
        public Written deleteCustomers(Collection<String> customerKeys) {
            firstWrite();
            int before = rows.size();
            rows.keySet().removeIf(key -> customerKeys.contains(key.customerKey()));
            return new Written(before - rows.size(), walPerStatement);
        }

        private void firstWrite() {
            if (snapshotClosedAtFirstWrite == null) snapshotClosedAtFirstWrite = !snapshotOpen.getAsBoolean();
        }

        @Override
        public void finish(UUID passId, Outcome outcome, Collection<String> runIds) {
            end(passId, "done", null, outcome);
            runIds.forEach(run -> firstPass.putIfAbsent(run, passId));
        }

        @Override
        public void fail(UUID passId, String reason, Outcome outcome) {
            end(passId, "failed", reason, outcome);
        }

        private void end(UUID passId, String state, String reason, Outcome outcome) {
            Pass pass = pass(passId);
            assertEquals("running", pass.state);
            pass.state = state;
            pass.reason = reason;
            pass.changedRows = outcome.changedRows();
            pass.walBytes = outcome.walBytes();
            pass.counts = outcome.counts();
            pass.pauses = outcome.pauses();
            pass.lastRunFinishedAt = outcome.lastRunFinishedAt().orElse(null);
        }

        private Pass pass(UUID id) {
            return passes.stream().filter(pass -> pass.id.equals(id)).findFirst().orElseThrow();
        }
    }
}
