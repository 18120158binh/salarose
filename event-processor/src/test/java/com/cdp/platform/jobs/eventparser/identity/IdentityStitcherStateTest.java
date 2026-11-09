package com.cdp.platform.jobs.eventparser.identity;

import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.time.Duration;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;

import org.apache.flink.api.common.functions.OpenContext;
import org.apache.flink.api.common.serialization.SerializerConfigImpl;
import org.apache.flink.api.common.state.StateTtlConfig;
import org.apache.flink.api.common.state.ValueState;
import org.apache.flink.api.common.state.ValueStateDescriptor;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.configuration.Configuration;
import org.apache.flink.configuration.PipelineOptions;
import org.apache.flink.runtime.checkpoint.OperatorSubtaskState;
import org.apache.flink.runtime.state.StateBackend;
import org.apache.flink.runtime.state.hashmap.HashMapStateBackend;
import org.apache.flink.state.rocksdb.EmbeddedRocksDBStateBackend;
import org.apache.flink.streaming.api.functions.KeyedProcessFunction;
import org.apache.flink.streaming.api.operators.KeyedProcessOperator;
import org.apache.flink.streaming.util.KeyedOneInputStreamOperatorTestHarness;
import org.apache.flink.util.Collector;

import com.cdp.platform.shared.db.repositories.IdentityGraphRepository;
import com.cdp.platform.shared.db.repositories.IdentityGraphRepository.StoredRows;
import com.cdp.platform.shared.db.repositories.UnreachableDatabase;
import com.cdp.platform.shared.models.ParsedEvent;
import com.cdp.platform.shared.models.db.IdentityGraph;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;

import org.junit.jupiter.api.Test;

/**
 * The stitcher's keyed state across an upgrade and a restart, run through the
 * operator on both state backends the job can run on. Every read of
 * {@code identity_graph} fails, so an event resolves to a stored set only when
 * its device's state was restored.
 */
class IdentityStitcherStateTest {

    // Checkpoints name the state, so the old and the new stitcher share it.
    private static final String STATE_NAME = "identity-dsu-state";
    private static final TypeInformation<ParsedEvent> EVENT = TypeInformation.of(ParsedEvent.class);

    @Test
    void stateWrittenWithKryoRestoresAndThenNoLongerNeedsKryoOnRocksDb() throws Exception {
        assertKryoStateCarriesOver(new EmbeddedRocksDBStateBackend());
    }

    @Test
    void stateWrittenWithKryoRestoresAndThenNoLongerNeedsKryoOnHeap() throws Exception {
        assertKryoStateCarriesOver(new HashMapStateBackend());
    }

    private static void assertKryoStateCarriesOver(StateBackend backend) throws Exception {
        OperatorSubtaskState kryoCheckpoint;
        try (var before = start(new StitcherWithKryoState(), backend, null, true)) {
            before.processElement(event("d1", null), 0L);
            before.processElement(event("d1", "u1"), 0L);
            kryoCheckpoint = before.snapshot(1L, 0L);
        }

        OperatorSubtaskState upgradedCheckpoint;
        try (var upgraded = start(new WithoutPostgres(), backend, kryoCheckpoint, true)) {
            upgradedCheckpoint = upgraded.snapshot(2L, 0L);
        }

        try (var restarted = start(new WithoutPostgres(), backend, upgradedCheckpoint, false)) {
            restarted.processElement(event("d1", null), 0L);
            // u2's derived root sorts after u1's, so the set keeps u1's root only if
            // the restored root kept its user priority.
            restarted.processElement(event("d1", "u2"), 0L);

            assertEquals(List.of(derived("u1"), derived("u1")), canonIds(restarted));
        }
    }

    @Test
    void stateOfTheStitcherThatKeptOneValuePerDeviceRestoresOnRocksDb() throws Exception {
        assertValueStateCarriesOver(new EmbeddedRocksDBStateBackend());
    }

    @Test
    void stateOfTheStitcherThatKeptOneValuePerDeviceRestoresOnHeap() throws Exception {
        assertValueStateCarriesOver(new HashMapStateBackend());
    }

    @Test
    void stateExpiresSevenDaysAfterItsLastWriteOnRocksDb() throws Exception {
        assertStateExpiresAfterItsLastWrite(new EmbeddedRocksDBStateBackend());
    }

    @Test
    void stateExpiresSevenDaysAfterItsLastWriteOnHeap() throws Exception {
        assertStateExpiresAfterItsLastWrite(new HashMapStateBackend());
    }

    @Test
    void stateIsRemovedWhenItExpires() throws Exception {
        try (var stitcher = start(new WithoutPostgres(), new HashMapStateBackend(), null, false)) {
            stitcher.processElement(event("d1", null), 0L);
            stitcher.processElement(event("d2", null), 0L);
            advanceTo(stitcher, Duration.ofDays(1).toMillis());
            stitcher.processElement(event("d2", null), 0L);
            int bothDevices = stitcher.numKeyedStateEntries();

            advanceTo(stitcher, Duration.ofDays(7).plusHours(1).toMillis());

            assertEquals(bothDevices / 2, stitcher.numKeyedStateEntries());
        }
    }

    @Test
    void eventsWaitingForAReadArePublishedAfterARestartOnRocksDb() throws Exception {
        assertWaitingEventsSurviveARestart(new EmbeddedRocksDBStateBackend());
    }

    @Test
    void eventsWaitingForAReadArePublishedAfterARestartOnHeap() throws Exception {
        assertWaitingEventsSurviveARestart(new HashMapStateBackend());
    }

    /**
     * A checkpoint taken while a device waits for its read holds the waiting
     * events. After a restore, the stitcher reads again and publishes them in
     * order.
     */
    private static void assertWaitingEventsSurviveARestart(StateBackend backend) throws Exception {
        assertTimeoutPreemptively(Duration.ofSeconds(10), () -> {
            OperatorSubtaskState checkpoint;
            CountDownLatch neverOpens = new CountDownLatch(1);
            try (var before = start(new WithStoredRow(neverOpens), backend, null, false)) {
                before.processElement(event("d1", "u1"), 0L);
                before.processElement(event("d1", null), 0L);
                checkpoint = before.snapshot(1L, 0L);
                assertEquals(List.of(), canonIds(before));
            }

            try (var restored = start(new WithStoredRow(new CountDownLatch(0)), backend, checkpoint, false)) {
                while (canonIds(restored).size() < 2) {
                    Thread.sleep(5);
                    restored.setProcessingTime(restored.getProcessingTime() + 5);
                }

                assertEquals(List.of("canon-of-u1", "canon-of-u1"), canonIds(restored));
            }
        });
    }

    /**
     * The stitcher kept each device's structure as one value until IDS-KI-13. A
     * device restored from such a checkpoint keeps its set, also after another
     * checkpoint and restart.
     */
    private static void assertValueStateCarriesOver(StateBackend backend) throws Exception {
        OperatorSubtaskState valueCheckpoint;
        try (var before = start(new StitcherWithValueState(), backend, null, false)) {
            before.processElement(event("d1", null), 0L);
            before.processElement(event("d1", "u1"), 0L);
            valueCheckpoint = before.snapshot(1L, 0L);
        }

        OperatorSubtaskState upgradedCheckpoint;
        try (var upgraded = start(new WithoutPostgres(), backend, valueCheckpoint, false)) {
            upgraded.processElement(event("d1", null), 0L);
            upgradedCheckpoint = upgraded.snapshot(2L, 0L);
        }

        try (var restarted = start(new WithoutPostgres(), backend, upgradedCheckpoint, false)) {
            restarted.processElement(event("d1", "u2"), 0L);
            restarted.processElement(event("d1", null), 0L);

            assertEquals(List.of(derived("u1"), derived("u1")), canonIds(restarted));
        }
    }

    /**
     * Every read fails, so a device resolves to its stored set only while its
     * state lives.
     */
    private static void assertStateExpiresAfterItsLastWrite(StateBackend backend) throws Exception {
        long day = Duration.ofDays(1).toMillis();
        OperatorSubtaskState checkpoint;
        try (var before = start(new StitcherWithValueState(), backend, null, false)) {
            before.processElement(event("d1", "u1"), 0L);
            checkpoint = before.snapshot(1L, 0L);
        }

        try (var stitcher = start(new WithoutPostgres(), backend, checkpoint, false)) {
            advanceTo(stitcher, 6 * day);
            stitcher.processElement(event("d1", null), 0L);
            advanceTo(stitcher, 12 * day);
            stitcher.processElement(event("d1", null), 0L);
            advanceTo(stitcher, 19 * day + 1);
            stitcher.processElement(event("d1", null), 0L);

            assertEquals(List.of(derived("u1"), derived("u1"), deviceRoot("d1")), canonIds(stitcher));
        }
    }

    private static void advanceTo(KeyedOneInputStreamOperatorTestHarness<String, ParsedEvent, ParsedEvent> harness,
        long time) throws Exception {
        harness.setStateTtlProcessingTime(time);
        harness.setProcessingTime(time);
    }

    private static KeyedOneInputStreamOperatorTestHarness<String, ParsedEvent, ParsedEvent> start(
        KeyedProcessFunction<String, ParsedEvent, ParsedEvent> function, StateBackend backend,
        OperatorSubtaskState restored,
        boolean kryoAllowed) throws Exception {
        var harness = new KeyedOneInputStreamOperatorTestHarness<>(new KeyedProcessOperator<>(function),
            ParsedEvent::domainUserid, Types.STRING);
        harness.setup(EVENT.createSerializer(new SerializerConfigImpl()));
        harness.setStateBackend(backend);
        if (!kryoAllowed) {
            Configuration noGenericTypes = new Configuration();
            noGenericTypes.set(PipelineOptions.GENERIC_TYPES, false);
            harness.getExecutionConfig().configure(noGenericTypes, IdentityStitcherStateTest.class.getClassLoader());
        }
        if (restored != null) harness.initializeState(restored);
        harness.open();
        return harness;
    }

    private static ParsedEvent event(String domainUserid, String userId) {
        return new ParsedEvent(null, null, null, 0L, 0L, null, "view_page", userId, null, null, null, null,
            domainUserid, null, null, null, "5f0c1a2e-8a51-4c4e-9d1b-1d2f3e4a5b6c");
    }

    private static List<String> canonIds(
        KeyedOneInputStreamOperatorTestHarness<String, ParsedEvent, ParsedEvent> harness) {
        return harness.extractOutputValues().stream().map(ParsedEvent::canonId).toList();
    }

    private static String derived(String identifier) {
        return UUID.nameUUIDFromBytes(("canon:" + identifier).getBytes(StandardCharsets.UTF_8)).toString();
    }

    private static String deviceRoot(String domainUserid) {
        return UUID
            .nameUUIDFromBytes(("canon-domain_userid:" + domainUserid).getBytes(StandardCharsets.UTF_8))
            .toString();
    }

    /**
     * The stitcher reading {@code (d1, u1, canon-of-u1)} on its lookup threads,
     * once {@code readsOpen} opens.
     */
    private static final class WithStoredRow extends IdentityStitcherFunction {

        private static final long serialVersionUID = 1L;

        private final transient CountDownLatch readsOpen;

        WithStoredRow(CountDownLatch readsOpen) {
            super(UnreachableDatabase.CONFIG);
            this.readsOpen = readsOpen;
        }

        @Override
        IdentityGraphRepository openIdentityRepository() {
            return UnreachableDatabase.identityGraph();
        }

        @Override
        StoredRows findRows(String domainUserid, String userId) throws SQLException {
            try {
                readsOpen.await();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new SQLException("read interrupted");
            }
            IdentityGraph row = new IdentityGraph("d1", "u1", "canon-of-u1");
            return new StoredRows(Optional.of(row), List.of(row));
        }
    }

    /** The stitcher with every {@code identity_graph} read failing. */
    private static final class WithoutPostgres extends IdentityStitcherFunction {

        private static final long serialVersionUID = 1L;

        WithoutPostgres() {
            super(UnreachableDatabase.CONFIG);
        }

        @Override
        IdentityGraphRepository openIdentityRepository() {
            return UnreachableDatabase.identityGraph();
        }

        @Override
        Executor openLookupExecutor() {
            return Runnable::run;
        }
    }

    /**
     * Keeps the structure as the stitcher did before IDS-KI-13: one value per
     * device in its own format, with a 7-day TTL.
     */
    private static final class StitcherWithValueState
        extends
            KeyedProcessFunction<String, ParsedEvent, ParsedEvent> {

        private static final long serialVersionUID = 1L;

        private transient ValueState<DisjointSetUnion> state;

        @Override
        public void open(OpenContext openContext) {
            ValueStateDescriptor<DisjointSetUnion> descriptor = new ValueStateDescriptor<>(STATE_NAME,
                DisjointSetUnionSerializer.INSTANCE);
            descriptor
                .enableTimeToLive(StateTtlConfig
                    .newBuilder(Duration.ofDays(7))
                    .setUpdateType(StateTtlConfig.UpdateType.OnCreateAndWrite)
                    .setStateVisibility(StateTtlConfig.StateVisibility.NeverReturnExpired)
                    .build());
            state = getRuntimeContext().getState(descriptor);
        }

        @Override
        public void processElement(ParsedEvent value, Context context, Collector<ParsedEvent> out) throws Exception {
            DisjointSetUnion dsu = state.value() != null ? state.value() : new DisjointSetUnion();
            dsu.resolveCanonId(value.domainUserid(), value.userId());
            state.update(dsu);
        }
    }

    /**
     * Keeps the structure as the stitcher did before its state had a serializer of
     * its own: a Kryo value with a 7-day TTL.
     */
    private static final class StitcherWithKryoState extends KeyedProcessFunction<String, ParsedEvent, ParsedEvent> {

        private static final long serialVersionUID = 1L;

        private transient ValueState<DisjointSetUnion> state;

        @Override
        public void open(OpenContext openContext) {
            ValueStateDescriptor<DisjointSetUnion> descriptor = new ValueStateDescriptor<>(STATE_NAME,
                DisjointSetUnion.class);
            descriptor
                .enableTimeToLive(StateTtlConfig
                    .newBuilder(Duration.ofDays(7))
                    .setUpdateType(StateTtlConfig.UpdateType.OnCreateAndWrite)
                    .setStateVisibility(StateTtlConfig.StateVisibility.NeverReturnExpired)
                    .build());
            state = getRuntimeContext().getState(descriptor);
        }

        @Override
        public void processElement(ParsedEvent value, Context context, Collector<ParsedEvent> out) throws Exception {
            DisjointSetUnion dsu = state.value() != null ? state.value() : new DisjointSetUnion();
            dsu.resolveCanonId(value.domainUserid(), value.userId());
            state.update(dsu);
        }
    }
}
