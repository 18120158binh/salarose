package com.cdp.platform.jobs.eventparser.identity;

import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;

import org.apache.flink.api.common.serialization.SerializerConfigImpl;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.metrics.Counter;
import org.apache.flink.runtime.jobgraph.OperatorID;
import org.apache.flink.runtime.metrics.groups.InternalOperatorMetricGroup;
import org.apache.flink.runtime.metrics.util.InterceptingOperatorMetricGroup;
import org.apache.flink.runtime.metrics.util.InterceptingTaskMetricGroup;
import org.apache.flink.runtime.operators.testutils.MockEnvironment;
import org.apache.flink.runtime.operators.testutils.MockEnvironmentBuilder;
import org.apache.flink.streaming.api.operators.KeyedProcessOperator;
import org.apache.flink.streaming.runtime.streamrecord.StreamRecord;
import org.apache.flink.streaming.util.KeyedOneInputStreamOperatorTestHarness;

import com.cdp.platform.shared.db.repositories.IdentityGraphRepository;
import com.cdp.platform.shared.db.repositories.IdentityGraphRepository.StoredRows;
import com.cdp.platform.shared.db.repositories.UnreachableDatabase;
import com.cdp.platform.shared.models.ParsedEvent;
import com.cdp.platform.shared.models.db.IdentityGraph;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * The stitcher run through its operator, keyed as the event parse job keys it,
 * with {@code identity_graph} held in memory. Every row the stitcher emits is
 * written to that table before the next event, as the sink does after its
 * batch interval.
 */
class IdentityStitcherFunctionTest {

    private static final TypeInformation<ParsedEvent> EVENT = TypeInformation.of(ParsedEvent.class);

    @Test
    void anEventWithoutAnIdentifierSkipsTheStitcher() {
        assertFalse(IdentityStitcherFunction.hasIdentifier(event(null, null)));
    }

    @Test
    void anEventWithAnIdentifierIsKeyedByItsDeviceElseItsUser() {
        assertTrue(IdentityStitcherFunction.hasIdentifier(event("d1", "u1")));
        assertTrue(IdentityStitcherFunction.hasIdentifier(event("d1", null)));
        assertTrue(IdentityStitcherFunction.hasIdentifier(event(null, "u1")));
        assertEquals("d1", IdentityStitcherFunction.keyOf(event("d1", "u1")));
        assertEquals("d1", IdentityStitcherFunction.keyOf(event("d1", null)));
        assertEquals("u1", IdentityStitcherFunction.keyOf(event(null, "u1")));
    }

    @Test
    void eventsWithOnlyAUserIdFollowAMergeOnTheUsersDevice() throws Exception {
        IdentityGraphTable table = new IdentityGraphTable();
        try (var harness = start(table)) {
            send(harness, table, null, "u2");
            // A shared device: u1 logs in, then u2. U(u1) sorts before U(u2), so the
            // device gives u2 the root U(u1).
            send(harness, table, "dS", "u1");
            send(harness, table, "dS", "u2");
            send(harness, table, null, "u2");

            assertEquals(List.of(derived("u2"), derived("u1"), derived("u1"), derived("u1")), canonIds(harness));
        }
    }

    @Test
    void anEventWithOnlyAUserIdWhoseReadFailsGetsTheUsersDerivedRoot() throws Exception {
        IdentityGraphTable table = new IdentityGraphTable();
        table.write(new IdentityGraph("d1", "u1", "canon-of-u1"));
        try (var harness = start(table)) {
            send(harness, table, null, "u1");
            table.failing = true;
            send(harness, table, null, "u1");
            table.failing = false;
            send(harness, table, null, "u1");

            assertEquals(List.of("canon-of-u1", derived("u1"), "canon-of-u1"), canonIds(harness));
            assertEquals(List.of(new IdentityGraph("d1", "u1", "canon-of-u1")), table.rows());
        }
    }

    @Test
    void anEventWhoseReadFailsWritesNoRowAndLeavesTheDeviceAsItWas() throws Exception {
        IdentityGraphTable table = new IdentityGraphTable();
        try (var harness = start(table)) {
            send(harness, table, "d1", null);
            table.failing = true;
            send(harness, table, "d1", "u2");
            table.failing = false;
            send(harness, table, "d1", null);

            assertEquals(List.of(deviceRoot("d1"), derived("u2"), deviceRoot("d1")), canonIds(harness));
            assertEquals(List.of(new IdentityGraph("d1", null, deviceRoot("d1"))), table.rows());
        }
    }

    @Test
    void eachEventWithADeviceWritesTheDevicesRow() throws Exception {
        IdentityGraphTable table = new IdentityGraphTable();
        try (var harness = start(table)) {
            send(harness, table, "d1", null);
            send(harness, table, "d1", "u1");

            assertEquals(List.of(new IdentityGraph("d1", "u1", derived("u1"))), table.rows());
        }
    }

    /**
     * IDS-KI-17: a merge on a shared device reaches the user's other device once
     * that device checks the user's rows again, a minute after its last read.
     */
    @Test
    void aMergeOnAnotherDeviceReachesADeviceInStateWithinTheRecheckInterval() throws Exception {
        assertTrue(derived("u1").compareTo(derived("u2")) < 0, "u1's root must sort first");
        IdentityGraphTable table = new IdentityGraphTable();
        try (var harness = start(table)) {
            send(harness, table, "dA", "u2");
            send(harness, table, "dS", "u1");
            send(harness, table, "dS", "u2");
            send(harness, table, "dA", "u2");
            harness.setProcessingTime(Duration.ofMinutes(2).toMillis());
            send(harness, table, "dA", "u2");
            send(harness, table, "dA", null);

            assertEquals(List
                .of(derived("u2"), derived("u1"), derived("u1"), derived("u2"), derived("u1"),
                    derived("u1")),
                canonIds(harness));
            assertEquals(derived("u1"), table.rowOf("dA").canonId());
        }
    }

    /**
     * IDS-KI-16: a device that read before the merged row was written converges
     * on the merged root at its next check.
     */
    @Test
    void aDeviceThatMissedAnUnwrittenRowConvergesWithinTheRecheckInterval() throws Exception {
        IdentityGraphTable table = new IdentityGraphTable();
        try (var harness = start(table)) {
            send(harness, table, "dA", "u2");
            harness.processElement(event("dS", "u1"), 0L);
            harness.processElement(event("dS", "u2"), 0L);
            // dB reads before the shared device's rows are written.
            send(harness, table, "dB", "u2");
            harness.setProcessingTime(Duration.ofMinutes(2).toMillis());
            send(harness, table, "dB", "u2");

            assertEquals(List.of(derived("u2"), derived("u1"), derived("u1"), derived("u2"), derived("u1")),
                canonIds(harness));
        }
    }

    /**
     * When two of a user's devices hold different roots, an event without a
     * device takes the root they converge on, not the newest row's.
     */
    @Test
    void anEventWithOnlyAUserIdTakesTheRootTheUsersDevicesConvergeOn() throws Exception {
        IdentityGraphTable table = new IdentityGraphTable();
        try (var harness = start(table)) {
            send(harness, table, "dA", "u2");
            send(harness, table, "dS", "u1");
            send(harness, table, "dS", "u2");
            send(harness, table, "dA", "u2");
            send(harness, table, null, "u2");

            assertEquals(derived("u1"), canonIds(harness).getLast());
        }
    }

    /**
     * IDS-KI-12: a slow read holds only the events of its own key. Reads run on
     * the stitcher's lookup threads here, not on the test's.
     */
    @Test
    void aSlowReadHoldsOnlyTheEventsOfItsOwnDevice() {
        assertTimeoutPreemptively(Duration.ofSeconds(5), () -> {
            IdentityGraphTable table = new IdentityGraphTable();
            table.write(new IdentityGraph("dOther", "u1", "canon-of-u1"));
            try (var harness = start(new WithLookupThreads(table))) {
                send(harness, table, "d2", null);
                awaitOutputs(harness, 1);
                table.gate = new CountDownLatch(1);

                send(harness, table, "d1", "u1");
                send(harness, table, "d2", null);
                send(harness, table, "d1", null);
                assertEquals(List.of(deviceRoot("d2"), deviceRoot("d2")), canonIds(harness));

                table.gate.countDown();
                awaitOutputs(harness, 4);

                assertEquals(List.of(deviceRoot("d2"), deviceRoot("d2"), "canon-of-u1", "canon-of-u1"),
                    canonIds(harness));
            }
        });
    }

    @Test
    void clearingAFullStructureIsCounted() throws Exception {
        IdentityGraphTable table = new IdentityGraphTable();
        InterceptingOperatorMetricGroup metrics = new InterceptingOperatorMetricGroup();
        try (var harness = start(table, metrics)) {
            // The first login adds four entries and each later one two, so the 99th
            // login is the first that could take the structure past 200.
            for (int login = 0; login < 98; login++) {
                send(harness, table, "kiosk", "user-" + login);
            }
            Counter cleared = (Counter) metrics.get("identityStructuresCleared");
            assertEquals(0, cleared.getCount());

            send(harness, table, "kiosk", "user-98");

            assertEquals(1, cleared.getCount());
        }
    }

    private static KeyedOneInputStreamOperatorTestHarness<String, ParsedEvent, ParsedEvent> start(
        IdentityGraphTable table)
        throws Exception {
        return start(new WithTable(table), new InterceptingOperatorMetricGroup());
    }

    private static KeyedOneInputStreamOperatorTestHarness<String, ParsedEvent, ParsedEvent> start(
        IdentityStitcherFunction stitcher)
        throws Exception {
        return start(stitcher, new InterceptingOperatorMetricGroup());
    }

    private static KeyedOneInputStreamOperatorTestHarness<String, ParsedEvent, ParsedEvent> start(
        IdentityGraphTable table, InternalOperatorMetricGroup metrics)
        throws Exception {
        return start(new WithTable(table), metrics);
    }

    private static KeyedOneInputStreamOperatorTestHarness<String, ParsedEvent, ParsedEvent> start(
        IdentityStitcherFunction stitcher, InternalOperatorMetricGroup metrics)
        throws Exception {
        MockEnvironment environment = new MockEnvironmentBuilder().setMetricGroup(new InterceptingTaskMetricGroup() {
            @Override
            public InternalOperatorMetricGroup getOrAddOperator(String name) {
                return metrics;
            }

            @Override
            public InternalOperatorMetricGroup getOrAddOperator(OperatorID operatorId, String name,
                Map<String, String> additionalVariables) {
                return metrics;
            }
        }).build();
        var harness = new KeyedOneInputStreamOperatorTestHarness<>(
            new KeyedProcessOperator<>(stitcher), IdentityStitcherFunction::keyOf, Types.STRING, environment);
        harness.setup(EVENT.createSerializer(new SerializerConfigImpl()));
        harness.open();
        return harness;
    }

    /** A parsed event as the parser emits it, before stitching. */
    private static ParsedEvent event(String domainUserid, String userId) {
        return new ParsedEvent(null, null, null, 0L, 0L, null, "view_page", userId, null, null, null, null,
            domainUserid, null, null, null, "5f0c1a2e-8a51-4c4e-9d1b-1d2f3e4a5b6c");
    }

    private static void send(KeyedOneInputStreamOperatorTestHarness<String, ParsedEvent, ParsedEvent> harness,
        IdentityGraphTable table, String domainUserid, String userId) throws Exception {
        harness.processElement(event(domainUserid, userId), 0L);
        writeEmittedRows(harness, table);
    }

    /**
     * Writes the rows the stitcher emitted, as the sink does after its batch
     * interval.
     */
    private static void writeEmittedRows(
        KeyedOneInputStreamOperatorTestHarness<String, ParsedEvent, ParsedEvent> harness, IdentityGraphTable table) {
        var written = harness.getSideOutput(IdentityStitcherFunction.DEVICE_MAPPINGS);
        if (written == null) return;
        for (StreamRecord<IdentityGraph> record = written.poll(); record != null; record = written.poll()) {
            table.write(record.getValue());
        }
    }

    /**
     * Advances processing time until the stitcher has published {@code count}
     * events, and writes the rows it emitted on the way.
     */
    private static void awaitOutputs(KeyedOneInputStreamOperatorTestHarness<String, ParsedEvent, ParsedEvent> harness,
        int count) throws Exception {
        while (harness.extractOutputValues().size() < count) {
            Thread.sleep(5);
            harness.setProcessingTime(harness.getProcessingTime() + 5);
        }
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
     * {@code identity_graph} in memory: one row per device, and a lookup that
     * answers with the user's newest row, else the device's row.
     */
    private static final class IdentityGraphTable {

        // Insertion order is write order, so the last row of a user is the newest.
        private final Map<String, IdentityGraph> byDevice = new LinkedHashMap<>();
        private volatile boolean failing;
        // While set, a read waits until it opens, as a read of a slow Postgres does.
        private volatile CountDownLatch gate;

        synchronized void write(IdentityGraph row) {
            IdentityGraph stored = byDevice.remove(row.domainUserid());
            String userId = row.userId() != null ? row.userId() : stored == null ? null : stored.userId();
            byDevice.put(row.domainUserid(), new IdentityGraph(row.domainUserid(), userId, row.canonId()));
        }

        StoredRows find(String domainUserid, String userId) throws SQLException {
            CountDownLatch waitFor = gate;
            try {
                if (waitFor != null && !waitFor.await(10, TimeUnit.SECONDS)) throw new SQLException("read timed out");
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new SQLException("read interrupted");
            }
            return findNow(domainUserid, userId);
        }

        /**
         * The device's row, and the user's rows newest first, as the lookup reads them.
         */
        private synchronized StoredRows findNow(String domainUserid, String userId) throws SQLException {
            if (failing) throw new SQLException("connection refused");
            Optional<IdentityGraph> deviceRow = Optional
                .ofNullable(domainUserid == null ? null : byDevice.get(domainUserid));
            String user = userId != null ? userId : deviceRow.map(IdentityGraph::userId).orElse(null);
            List<IdentityGraph> userRows = new ArrayList<>(byDevice.values())
                .reversed()
                .stream()
                .filter(row -> user != null && user.equals(row.userId()))
                .limit(IdentityGraphRepository.USER_ROW_LIMIT)
                .toList();
            return new StoredRows(deviceRow, userRows);
        }

        synchronized IdentityGraph rowOf(String domainUserid) {
            return byDevice.get(domainUserid);
        }

        synchronized List<IdentityGraph> rows() {
            return List.copyOf(byDevice.values());
        }
    }

    /** The stitcher reading the table on its own lookup threads. */
    private static final class WithLookupThreads extends IdentityStitcherFunction {

        private static final long serialVersionUID = 1L;

        private final transient IdentityGraphTable table;

        WithLookupThreads(IdentityGraphTable table) {
            super(UnreachableDatabase.CONFIG);
            this.table = table;
        }

        @Override
        IdentityGraphRepository openIdentityRepository() {
            return UnreachableDatabase.identityGraph();
        }

        @Override
        StoredRows findRows(String domainUserid, String userId) throws SQLException {
            return table.find(domainUserid, userId);
        }
    }

    /** The stitcher reading the table on the stream's thread. */
    private static final class WithTable extends IdentityStitcherFunction {

        private static final long serialVersionUID = 1L;

        private final transient IdentityGraphTable table;

        WithTable(IdentityGraphTable table) {
            super(UnreachableDatabase.CONFIG);
            this.table = table;
        }

        @Override
        Executor openLookupExecutor() {
            return Runnable::run;
        }

        @Override
        IdentityGraphRepository openIdentityRepository() {
            return UnreachableDatabase.identityGraph();
        }

        @Override
        StoredRows findRows(String domainUserid, String userId) throws SQLException {
            return table.find(domainUserid, userId);
        }
    }
}
