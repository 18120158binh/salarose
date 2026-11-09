package com.cdp.platform.jobs.eventparser.identity;

import java.sql.SQLException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import org.apache.flink.api.common.functions.OpenContext;
import org.apache.flink.api.common.state.ListState;
import org.apache.flink.api.common.state.ListStateDescriptor;
import org.apache.flink.api.common.state.MapState;
import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.state.StateTtlConfig;
import org.apache.flink.api.common.state.ValueState;
import org.apache.flink.api.common.state.ValueStateDescriptor;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.metrics.Counter;
import org.apache.flink.streaming.api.functions.KeyedProcessFunction;
import org.apache.flink.util.Collector;
import org.apache.flink.util.OutputTag;

import com.cdp.platform.jobs.eventparser.identity.IdentityCacheResolver.MappingLookup;
import com.cdp.platform.jobs.eventparser.identity.IdentityCacheResolver.Resolution;
import com.cdp.platform.shared.config.DatabaseConfig;
import com.cdp.platform.shared.db.repositories.IdentityGraphRepository;
import com.cdp.platform.shared.db.repositories.IdentityGraphRepository.StoredRows;
import com.cdp.platform.shared.models.ParsedEvent;
import com.cdp.platform.shared.models.db.IdentityGraph;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Stateful stream transformation function that stitches user identities across
 * incoming tracking events into a single canonical ID.
 */
public class IdentityStitcherFunction extends KeyedProcessFunction<String, ParsedEvent, ParsedEvent> {

    /**
     * The {@code identity_graph} row of each event with a {@code domain_userid}
     * whose {@code canon_id} the stitcher kept.
     */
    public static final OutputTag<IdentityGraph> DEVICE_MAPPINGS = new OutputTag<>("identity-graph-rows",
        TypeInformation.of(IdentityGraph.class));

    private static final long serialVersionUID = 1L;
    private static final Logger LOG = LoggerFactory.getLogger(IdentityStitcherFunction.class);
    // Each device's structure as one value, as earlier versions kept it. A
    // device's first event moves it to the states below.
    private static final String VALUE_STATE_NAME = "identity-dsu-state";
    /** IDS-NFR-03: a device's state expires this long after its last write. */
    static final Duration STATE_TTL = Duration.ofDays(7);
    // A device's expiry timer fires on the first hour boundary after it is due,
    // so that a busy device moves its timer at most once an hour.
    private static final long EXPIRY_TIMER_GRANULARITY = Duration.ofHours(1).toMillis();
    // A waiting key checks its read after 1 ms, then backs off to every 50 ms.
    private static final long FIRST_POLL_DELAY_MS = 1;
    private static final long MAX_POLL_DELAY_MS = 50;
    private static final int MAX_READS_IN_FLIGHT = 100;

    /**
     * How often a device whose set holds a user checks the user's rows by default.
     */
    public static final Duration DEFAULT_RECHECK_INTERVAL = Duration.ofMinutes(1);

    private final DatabaseConfig database;
    private final Duration recheckInterval;
    private transient ValueState<DisjointSetUnion> valueState;
    private transient MapState<String, String> parentLinks;
    private transient MapState<String, Integer> rootPriorities;
    private transient ValueState<Integer> entryCount;
    private transient ValueState<Long> writtenAt;
    // When the device last read identity_graph, for IDS-FR-10.
    private transient ValueState<Long> checkedAt;
    // The events of a key that wait for its read, oldest first. They are in state,
    // so a restart reads again for the first of them.
    private transient ListState<ParsedEvent> pendingEvents;
    private transient Map<String, InFlight> readsInFlight;
    private transient Executor lookupExecutor;
    private transient ExecutorService lookupThreads;
    private transient IdentityGraphRepository identityRepository;
    private transient Counter clearedStructures;

    public IdentityStitcherFunction(DatabaseConfig database) {
        this(database, DEFAULT_RECHECK_INTERVAL);
    }

    /**
     * @param database
     *            the primary whose {@code identity_graph} the lookups read
     * @param recheckInterval
     *            how long a device whose set holds a user trusts its state before
     *            it reads the user's rows again
     */
    public IdentityStitcherFunction(DatabaseConfig database, Duration recheckInterval) {
        this.database = database;
        this.recheckInterval = recheckInterval;
    }

    /**
     * Whether the event has a {@code domain_userid} or a {@code user_id}. An event
     * with neither has no {@code canon_id}, so it skips the stitcher.
     */
    public static boolean hasIdentifier(ParsedEvent event) {
        return event.domainUserid() != null || event.userId() != null;
    }

    /**
     * The key the stitcher runs under: the event's device, else its user. Only
     * events that {@link #hasIdentifier} have one.
     */
    public static String keyOf(ParsedEvent event) {
        return event.domainUserid() != null ? event.domainUserid() : event.userId();
    }

    @Override
    public void open(OpenContext openContext) throws Exception {
        super.open(openContext);

        StateTtlConfig ttlConfig = StateTtlConfig
            .newBuilder(STATE_TTL)
            .setUpdateType(StateTtlConfig.UpdateType.OnCreateAndWrite)
            .setStateVisibility(StateTtlConfig.StateVisibility.NeverReturnExpired)
            .build();

        ValueStateDescriptor<DisjointSetUnion> valueDescriptor = new ValueStateDescriptor<>(VALUE_STATE_NAME,
            DisjointSetUnionSerializer.INSTANCE);
        valueDescriptor.enableTimeToLive(ttlConfig);

        valueState = getRuntimeContext().getState(valueDescriptor);
        parentLinks = getRuntimeContext()
            .getMapState(new MapStateDescriptor<>("identity-parent-links", Types.STRING, Types.STRING));
        rootPriorities = getRuntimeContext()
            .getMapState(new MapStateDescriptor<>("identity-root-priorities", Types.STRING, Types.INT));
        entryCount = getRuntimeContext().getState(new ValueStateDescriptor<>("identity-entry-count", Types.INT));
        writtenAt = getRuntimeContext().getState(new ValueStateDescriptor<>("identity-written-at", Types.LONG));
        checkedAt = getRuntimeContext().getState(new ValueStateDescriptor<>("identity-checked-at", Types.LONG));
        pendingEvents = getRuntimeContext()
            .getListState(new ListStateDescriptor<>("identity-pending-events", TypeInformation.of(ParsedEvent.class)));
        identityRepository = openIdentityRepository();
        lookupExecutor = openLookupExecutor();
        readsInFlight = new HashMap<>();
        clearedStructures = getRuntimeContext().getMetricGroup().counter("identityStructuresCleared");
    }

    @Override
    public void processElement(ParsedEvent value, Context context, Collector<ParsedEvent> out) throws Exception {
        // A key's events keep their order: while one waits for its read, the ones
        // after it wait too.
        if (pendingEvents.get().iterator().hasNext()) {
            pendingEvents.add(value);
            return;
        }
        if (!publishOrRead(value, null, context, out)) pendingEvents.add(value);
    }

    @Override
    public void onTimer(long timestamp, OnTimerContext context, Collector<ParsedEvent> out) throws Exception {
        Long lastWrite = writtenAt.value();
        if (lastWrite != null && timestamp == expiryTimer(lastWrite)) clearDevice();

        if (!pendingEvents.get().iterator().hasNext()) return;
        String key = context.getCurrentKey();
        InFlight inFlight = readsInFlight.get(key);
        if (inFlight == null) {
            // The read was lost in a restart. The events wait in state, so read again.
            publishPending(null, context, out);
        } else if (timestamp != inFlight.nextPoll()) {
            return;
        } else if (!inFlight.read().isDone()) {
            long delay = Math.min(inFlight.pollDelay() * 2, MAX_POLL_DELAY_MS);
            long nextPoll = context.timerService().currentProcessingTime() + delay;
            readsInFlight.put(key, new InFlight(inFlight.read(), delay, nextPoll));
            context.timerService().registerProcessingTimeTimer(nextPoll);
        } else {
            readsInFlight.remove(key);
            publishPending(inFlight, context, out);
        }
    }

    /**
     * Publishes the key's waiting events in order, the first with the read that
     * completed for it, until one needs a read of its own.
     */
    private void publishPending(InFlight completed, Context context, Collector<ParsedEvent> out) throws Exception {
        List<ParsedEvent> waiting = new ArrayList<>();
        pendingEvents.get().forEach(waiting::add);
        InFlight read = completed;
        for (int next = 0; next < waiting.size(); next++) {
            if (!publishOrRead(waiting.get(next), read, context, out)) {
                pendingEvents.update(waiting.subList(next, waiting.size()));
                return;
            }
            read = null;
        }
        pendingEvents.clear();
    }

    /**
     * Resolves and publishes one event, or starts the read it needs and returns
     * false. A read that is already complete is used at once.
     */
    private boolean publishOrRead(ParsedEvent value, InFlight completed, Context context, Collector<ParsedEvent> out)
        throws Exception {
        String domainUserid = value.domainUserid();
        String userId = value.userId();

        // Only a device keeps a structure. An event without one would decide the
        // user's canon_id apart from the user's devices, so it reads identity_graph
        // on every event instead and keeps nothing.
        boolean device = domainUserid != null;
        long now = context.timerService().currentProcessingTime();
        DisjointSetUnion dsu = device ? deviceStructure(now, context) : new DisjointSetUnion();

        boolean recheckDue = device
            && IdentityCacheResolver.recheckDue(dsu, domainUserid, userId, checkedAt.value(), now, recheckInterval);
        boolean needsRead = IdentityCacheResolver.readFor(dsu, domainUserid, userId, recheckDue) != null;
        CompletableFuture<StoredRows> read = completed == null ? null : completed.read();
        if (read == null && needsRead) {
            read = startRead(domainUserid, userId);
            if (!read.isDone()) {
                long nextPoll = now + FIRST_POLL_DELAY_MS;
                readsInFlight.put(context.getCurrentKey(), new InFlight(read, FIRST_POLL_DELAY_MS, nextPoll));
                context.timerService().registerProcessingTimeTimer(nextPoll);
                return false;
            }
        }

        Resolution resolution = IdentityCacheResolver
            .resolve(dsu, domainUserid, userId, recheckDue, readResult(read));
        if (resolution.clearedEntries() > 0) {
            clearedStructures.inc();
            LOG
                .warn("Cleared the identity structure of {}: it held {} entries and the event could take it past {}",
                    domainUserid, resolution.clearedEntries(), DisjointSetUnion.MAX_NODES_PER_GRAPH);
        }
        if (device && resolution.stored()) {
            recordWrite(now, context);
            if (needsRead) checkedAt.update(now);
            context.output(DEVICE_MAPPINGS, new IdentityGraph(domainUserid, userId, resolution.canonId()));
        }

        out.collect(value.withCanonId(resolution.canonId()));
        return true;
    }

    /**
     * Starts a read on the lookup threads. With {@link #MAX_READS_IN_FLIGHT}
     * reads running, waits for one of them first, so a slow database slows the
     * stream instead of queuing reads without bound.
     */
    private CompletableFuture<StoredRows> startRead(String domainUserid, String userId) {
        CompletableFuture<?>[] running = readsInFlight
            .values()
            .stream()
            .map(InFlight::read)
            .filter(read -> !read.isDone())
            .toArray(CompletableFuture[]::new);
        if (running.length >= MAX_READS_IN_FLIGHT) {
            CompletableFuture.anyOf(running).exceptionally(failure -> null).join();
        }

        return CompletableFuture.supplyAsync(() -> {
            try {
                return findRows(domainUserid, userId);
            } catch (SQLException failure) {
                throw new CompletionException(failure);
            }
        }, lookupExecutor);
    }

    /**
     * The completed read of the event's identifiers, as the resolver asks for it.
     * The resolver asks only when {@link IdentityCacheResolver#readFor} says so,
     * and the stitcher starts the read in that case.
     */
    private static MappingLookup readResult(CompletableFuture<StoredRows> read) {
        return (domainUserid, userId) -> {
            if (read == null) throw new IllegalStateException("The stitcher asked for a read it did not make");
            try {
                return read.join();
            } catch (CompletionException failure) {
                if (failure.getCause() instanceof SQLException sqlFailure) throw sqlFailure;
                throw failure;
            }
        };
    }

    /** A read of {@code identity_graph} that a key's first waiting event needs. */
    private record InFlight(CompletableFuture<StoredRows> read, long pollDelay, long nextPoll) {
    }

    /** The store read on a state miss. Tests replace it to run without Postgres. */
    IdentityGraphRepository openIdentityRepository() {
        return IdentityGraphRepository.open(database);
    }

    /**
     * The threads that read {@code identity_graph}, one per pooled connection.
     * Tests replace it to read on the stream's thread.
     */
    Executor openLookupExecutor() {
        lookupThreads = Executors.newFixedThreadPool(identityRepository.lookupConcurrency(), runnable -> {
            Thread thread = new Thread(runnable, "identity-lookup");
            thread.setDaemon(true);
            return thread;
        });
        return lookupThreads;
    }

    /** Reads {@code identity_graph}. Tests replace it to serve stored rows. */
    StoredRows findRows(String domainUserid, String userId) throws SQLException {
        return identityRepository.findRows(domainUserid, userId);
    }

    /**
     * The device's structure, read and changed entry by entry in keyed state. A
     * structure past its TTL reads as empty, also before its timer fires.
     */
    private DisjointSetUnion deviceStructure(long now, Context context) throws Exception {
        Long lastWrite = writtenAt.value();
        if (lastWrite != null && now >= lastWrite + STATE_TTL.toMillis()) clearDevice();

        DisjointSetUnion structure = new DisjointSetUnion(new StateBackedMap<>(parentLinks, entryCount),
            new StateBackedMap<>(rootPriorities, null));
        DisjointSetUnion stored = valueState.value();
        if (stored != null) {
            stored.parentLinks().forEach(structure::link);
            stored.rootPriorities().forEach(structure::prioritize);
            valueState.clear();
            // A device that only fails its reads from now on must still expire.
            recordWrite(now, context);
        }
        return structure;
    }

    /** Moves the device's expiry to {@link #STATE_TTL} from now. */
    private void recordWrite(long now, Context context) throws Exception {
        Long lastWrite = writtenAt.value();
        long timer = expiryTimer(now);
        if (lastWrite == null || expiryTimer(lastWrite) != timer) {
            if (lastWrite != null) context.timerService().deleteProcessingTimeTimer(expiryTimer(lastWrite));
            context.timerService().registerProcessingTimeTimer(timer);
        }
        writtenAt.update(now);
    }

    private static long expiryTimer(long lastWrite) {
        long due = lastWrite + STATE_TTL.toMillis();
        return (due / EXPIRY_TIMER_GRANULARITY + 1) * EXPIRY_TIMER_GRANULARITY;
    }

    private void clearDevice() {
        parentLinks.clear();
        rootPriorities.clear();
        entryCount.clear();
        writtenAt.clear();
        checkedAt.clear();
        valueState.clear();
    }

    @Override
    public void close() throws Exception {
        if (lookupThreads != null) {
            lookupThreads.shutdownNow();
            lookupThreads = null;
        }
        if (identityRepository != null) {
            identityRepository.close();
            identityRepository = null;
        }
        super.close();
    }
}
