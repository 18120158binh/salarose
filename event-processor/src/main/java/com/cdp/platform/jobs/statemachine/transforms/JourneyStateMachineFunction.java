package com.cdp.platform.jobs.statemachine.transforms;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.OptionalInt;
import java.util.OptionalLong;
import java.util.Set;
import java.util.TreeMap;

import org.apache.flink.api.common.functions.OpenContext;
import org.apache.flink.api.common.state.BroadcastState;
import org.apache.flink.api.common.state.MapState;
import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.state.ReadOnlyBroadcastState;
import org.apache.flink.api.common.state.StateTtlConfig;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.metrics.Counter;
import org.apache.flink.streaming.api.TimeDomain;
import org.apache.flink.streaming.api.functions.co.KeyedBroadcastProcessFunction;
import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;
import org.apache.flink.util.Collector;
import org.apache.flink.util.OutputTag;

import com.cdp.platform.jobs.statemachine.engine.TransitionEngine;
import com.cdp.platform.jobs.statemachine.model.CampaignGraph;
import com.cdp.platform.jobs.statemachine.model.CampaignGraphLoad;
import com.cdp.platform.jobs.statemachine.model.GraphNode;
import com.cdp.platform.shared.db.repositories.CampaignNodesTable;
import com.cdp.platform.shared.models.JourneyTriggerEvent;
import com.cdp.platform.shared.models.SegmentCheck;
import com.cdp.platform.shared.models.VersionedTrigger;
import com.cdp.platform.shared.models.db.UserCampaignState;
import com.cdp.platform.shared.models.node.Branch;
import com.cdp.platform.shared.models.node.NodeType;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Evaluates reachable journey matches immediately. Matches waiting for a parent
 * are buffered until another transition unlocks them or their event-time
 * deadline passes. Matches waiting for their campaign graph, or for their node
 * in it, are buffered until the node arrives, or until the watermark passes
 * their event time plus the graph-load allowance.
 *
 * <p>
 * A journey key holds one entry per entry id that a setup trigger opened, each
 * with its own completed nodes. A trigger for the setup node applies to the
 * entry it names, or to {@value VersionedTrigger#FIRST_ENTRY}. A trigger below
 * the setup node applies to the entry it names, or else to each entry
 * separately, and stays buffered until the watermark passes it, so that an
 * entry opened later with an earlier setup sees it as in arrival order.
 */
public final class JourneyStateMachineFunction
    extends
        KeyedBroadcastProcessFunction<String, VersionedTrigger, Row, UserCampaignState> {

    public static final OutputTag<JourneyTriggerEvent> LATE_EVENTS = new OutputTag<>("late-journey-engine-matches",
        TypeInformation.of(JourneyTriggerEvent.class));
    public static final OutputTag<JourneyTriggerEvent> UNREACHABLE_EVENTS = new OutputTag<>(
        "unreachable-journey-engine-matches", TypeInformation.of(JourneyTriggerEvent.class));
    public static final OutputTag<JourneyTriggerEvent> STATE_LIMIT_EVENTS = new OutputTag<>(
        "state-limit-journey-engine-matches", TypeInformation.of(JourneyTriggerEvent.class));
    /**
     * Triggers whose parent completed on another branch than their node hangs off.
     */
    public static final OutputTag<JourneyTriggerEvent> WRONG_BRANCH_EVENTS = new OutputTag<>(
        "wrong-branch-journey-engine-matches", TypeInformation.of(JourneyTriggerEvent.class));
    /** A check for each segment that a person reached, for customer decision. */
    public static final OutputTag<SegmentCheck> SEGMENT_CHECKS = new OutputTag<>("segment-checks",
        TypeInformation.of(SegmentCheck.class));
    /**
     * The rows of each campaign that arrived since its graph last went live. A
     * job that runs this function must broadcast its graph rows with this
     * descriptor as well as its graph descriptor.
     */
    public static final MapStateDescriptor<String, CampaignGraphLoad> GRAPH_LOADS = new MapStateDescriptor<>(
        "campaign-graph-loads", Types.STRING, TypeInformation.of(CampaignGraphLoad.class));

    private static final Logger LOG = LoggerFactory.getLogger(JourneyStateMachineFunction.class);

    private final MapStateDescriptor<String, CampaignGraph> graphStateDescriptor;
    private final int maxPendingMatchesPerJourney;
    private final long maxPendingBytesPerJourney;
    private final long journeyStateTtlMillis;
    private final long graphLoadAllowanceMillis;
    private transient MapStateDescriptor<Long, List<VersionedTrigger>> pendingDescriptor;
    private transient MapState<Long, List<VersionedTrigger>> pendingByTimestamp;
    private transient MapState<String, Map<String, UserCampaignState>> entries;
    private transient TransitionEngine engine;
    private transient Counter lateEventCounter;
    private transient Counter unreachableEventCounter;
    private transient Counter stateLimitEventCounter;
    private transient Counter wrongBranchEventCounter;
    private transient boolean graphLoadGraceStarted;
    private transient long graphLoadGraceEnds;

    public JourneyStateMachineFunction(MapStateDescriptor<String, CampaignGraph> graphStateDescriptor,
        int maxPendingMatchesPerJourney, long maxPendingBytesPerJourney, long journeyStateTtlMillis,
        long graphLoadAllowanceMillis) {
        this.graphStateDescriptor = graphStateDescriptor;
        this.maxPendingMatchesPerJourney = maxPendingMatchesPerJourney;
        this.maxPendingBytesPerJourney = maxPendingBytesPerJourney;
        this.journeyStateTtlMillis = journeyStateTtlMillis;
        this.graphLoadAllowanceMillis = graphLoadAllowanceMillis;
    }

    @Override
    public void open(OpenContext openContext) throws Exception {
        // Heap state cleans up on each state access only, not on each key
        // selected. A graph row selects every key with buffered triggers to
        // find its campaign's journeys, and cleanup on each one cost about
        // 20 µs per journey. Expired entries are never returned either way.
        StateTtlConfig ttlConfig = StateTtlConfig
            .newBuilder(Duration.ofMillis(journeyStateTtlMillis))
            .setUpdateType(StateTtlConfig.UpdateType.OnReadAndWrite)
            .setStateVisibility(StateTtlConfig.StateVisibility.NeverReturnExpired)
            .cleanupIncrementally(100, false)
            .cleanupInRocksdbCompactFilter(1_000)
            .build();

        pendingDescriptor = new MapStateDescriptor<>("pending-triggers-by-event-time", Types.LONG,
            Types.LIST(TypeInformation.of(VersionedTrigger.class)));
        pendingDescriptor.enableTimeToLive(ttlConfig);
        pendingByTimestamp = getRuntimeContext().getMapState(pendingDescriptor);

        MapStateDescriptor<String, Map<String, UserCampaignState>> entriesDescriptor = new MapStateDescriptor<>(
            "journey-entries", Types.STRING, Types.MAP(Types.STRING, TypeInformation.of(UserCampaignState.class)));
        entriesDescriptor.enableTimeToLive(ttlConfig);
        entries = getRuntimeContext().getMapState(entriesDescriptor);
        engine = new TransitionEngine();
        lateEventCounter = getRuntimeContext().getMetricGroup().counter("lateMatchedEvents");
        unreachableEventCounter = getRuntimeContext().getMetricGroup().counter("unreachableMatchedEvents");
        stateLimitEventCounter = getRuntimeContext().getMetricGroup().counter("stateLimitDroppedMatchedEvents");
        wrongBranchEventCounter = getRuntimeContext().getMetricGroup().counter("wrongBranchMatchedEvents");
        graphLoadGraceStarted = false;
    }

    @Override
    public void processElement(VersionedTrigger trigger, ReadOnlyContext context, Collector<UserCampaignState> out)
        throws Exception {
        startGraphLoadGrace(context.currentProcessingTime());
        JourneyTriggerEvent event = trigger.trigger();
        ReadOnlyBroadcastState<String, CampaignGraph> graphs = context.getBroadcastState(graphStateDescriptor);
        CampaignGraph graph = graphs.get(event.campaignId());
        if (decidedAgainstReplacedGraph(trigger, graph)) {
            dropAsUnreachable(trigger, context::output);
            return;
        }
        long watermark = context.timerService().currentWatermark();
        boolean pastWatermark = watermark != Long.MIN_VALUE && event.eventTimestamp() <= watermark
            && !isWatchDeadline(event, graph);
        Map<String, Map<String, UserCampaignState>> journey = entrySnapshot();
        if (!readyFor(trigger, graph)) {
            // The live graph, if any, decides a segment answer before the
            // trigger waits for its own graph, so the answer is never late.
            if (pastWatermark && !answersSegmentCheckInAnyEntry(event, graph, journey)) {
                dropAsLate(event, context::output);
            } else {
                bufferUntilWatermark(trigger, context);
            }
            return;
        }

        boolean everyEntry = appliesToEveryEntry(trigger, graph);
        boolean late = pastWatermark;
        boolean applied = false;
        for (String entryId : targets(trigger, graph, journey.keySet())) {
            Map<String, UserCampaignState> completed = journey.getOrDefault(entryId, new HashMap<>());
            if (pastWatermark && !answersSegmentCheck(event, graph, completed)) {
                Optional<SegmentCheck> recheck = lateSegmentRecheck(event, entryId, graph, completed);
                recheck.ifPresent(check -> context.output(SEGMENT_CHECKS, check));
                late &= recheck.isEmpty();
                continue;
            }
            late = false;
            TransitionEngine.Evaluation evaluation = engine.evaluate(event, entryId, graph, completed);
            if (evaluation.status() == TransitionEngine.Status.DEFERRED) {
                if (!everyEntry) bufferUntilWatermark(trigger, context);
            } else if (evaluation.status() == TransitionEngine.Status.APPLIED) {
                applied = true;
                emitAndRemember(entryId, completed, evaluation, journey, out, context::output);
            } else if (evaluation.status() == TransitionEngine.Status.WRONG_BRANCH) {
                // A trigger kept for every entry reports its wrong branches once,
                // when the watermark passes it.
                if (!everyEntry || pastWatermark) dropOnWrongBranch(event, context::output);
            } else {
                evaluation.segmentChecks().forEach(check -> context.output(SEGMENT_CHECKS, check));
            }
        }
        if (late) {
            dropAsLate(event, context::output);
        }
        if (everyEntry && !pastWatermark) {
            bufferUntilWatermark(trigger, applied, context);
        }
        if (applied) {
            retryPendingMatches(graphs, journey, out, context::output);
        }
    }

    /**
     * Whether the trigger's graph and node have arrived, so it can tell which
     * entries it applies to.
     */
    private static boolean readyFor(VersionedTrigger trigger, CampaignGraph graph) {
        return graph != null && !decidedAgainstUnloadedGraph(trigger, graph)
            && graph.node(trigger.trigger().nodeId()) != null;
    }

    /**
     * A trigger below the setup node that names no entry applies to each entry,
     * including one whose setup trigger arrives after it with an earlier event
     * time (JEX-FR-04, JEX-FR-19). It therefore stays buffered as one record
     * until the watermark passes it, and each retry applies it to every entry.
     * Applying it again to an entry where its node completed does nothing
     * (JEX-FR-01).
     */
    private static boolean appliesToEveryEntry(VersionedTrigger trigger, CampaignGraph graph) {
        return trigger.entryId() == null && graph.node(trigger.trigger().nodeId()).parentNodeId() != null;
    }

    /**
     * The entries a ready trigger applies to: the one it names, the entry
     * {@value VersionedTrigger#FIRST_ENTRY} for a setup trigger that names none,
     * and each of the key's entries for any other trigger.
     */
    private static List<String> targets(VersionedTrigger trigger, CampaignGraph graph, Set<String> entryIds) {
        if (trigger.entryId() != null) return List.of(trigger.entryId());
        if (!appliesToEveryEntry(trigger, graph)) return List.of(VersionedTrigger.FIRST_ENTRY);
        return List.copyOf(entryIds);
    }

    /**
     * Ends a trigger kept for every entry once the watermark passed it: a drop
     * for each entry whose parent completed on another branch, and an
     * unreachable drop only when it completed its node in no entry.
     */
    private void finishForEveryEntry(VersionedTrigger trigger, CampaignGraph graph,
        Map<String, Map<String, UserCampaignState>> journey, SideOutputs outputs) {
        JourneyTriggerEvent event = trigger.trigger();
        boolean reported = completedInAnyEntry(event, journey);
        for (Map.Entry<String, Map<String, UserCampaignState>> entry : journey.entrySet()) {
            TransitionEngine.Evaluation evaluation = engine
                .evaluate(event, entry.getKey(), graph, new HashMap<>(entry.getValue()));
            if (evaluation.status() == TransitionEngine.Status.WRONG_BRANCH) {
                dropOnWrongBranch(event, outputs);
                reported = true;
            }
        }
        if (!reported) {
            dropAsUnreachable(trigger, outputs);
        }
    }

    /**
     * Ends a buffered trigger that its graph holds once the watermark passed it.
     * A trigger for one entry that is still buffered then cannot apply.
     */
    private void finishAtWatermark(VersionedTrigger trigger, CampaignGraph graph,
        Map<String, Map<String, UserCampaignState>> journey, SideOutputs outputs) {
        if (appliesToEveryEntry(trigger, graph)) {
            finishForEveryEntry(trigger, graph, journey, outputs);
        } else {
            dropAsUnreachable(trigger, outputs);
        }
    }

    private static boolean completedInAnyEntry(JourneyTriggerEvent event,
        Map<String, Map<String, UserCampaignState>> journey) {
        return journey.values().stream().anyMatch(completed -> completedBy(event, completed));
    }

    /** Whether the trigger itself completed its node in the entry. */
    private static boolean completedBy(JourneyTriggerEvent event, Map<String, UserCampaignState> completed) {
        UserCampaignState node = completed.get(event.nodeId());
        return node != null && node.eventTimestamp() == event.eventTimestamp()
            && Objects.equals(event.eventId(), node.eventId());
    }

    private static boolean answersSegmentCheckInAnyEntry(JourneyTriggerEvent event, CampaignGraph graph,
        Map<String, Map<String, UserCampaignState>> journey) {
        return graph != null
            && journey.values().stream().anyMatch(completed -> answersSegmentCheck(event, graph, completed));
    }

    @Override
    public void onTimer(long timestamp, OnTimerContext context, Collector<UserCampaignState> out) throws Exception {
        startGraphLoadGrace(context.currentProcessingTime());
        ReadOnlyBroadcastState<String, CampaignGraph> graphs = context.getBroadcastState(graphStateDescriptor);
        Map<String, Map<String, UserCampaignState>> journey = entrySnapshot();
        retryPendingMatches(graphs, journey, out, context::output);

        // The watermark has passed every trigger at or before this time. One
        // whose path to the root is in the graph cannot apply any more. One whose
        // path is missing waits for its graph until its graph-load deadline,
        // which gets its own timer, since a node deleted after the trigger was
        // buffered must not leave it waiting for good. The deadline also waits
        // for the start grace, which a processing-time timer ends.
        long watermark = context.timeDomain() == TimeDomain.EVENT_TIME
            ? timestamp
            : context.timerService().currentWatermark();
        boolean graceOver = context.timerService().currentProcessingTime() >= graphLoadGraceEnds;
        for (Long eventTime : pendingTimestamps()) {
            if (eventTime > watermark) break;
            List<VersionedTrigger> events = pendingByTimestamp.get(eventTime);
            if (events == null) continue;
            ArrayList<VersionedTrigger> waitingForGraph = new ArrayList<>();
            for (VersionedTrigger event : events) {
                boolean deadlinePassed = graphLoadDeadline(eventTime) <= watermark;
                CampaignGraph graph = graphs.get(event.trigger().campaignId());
                if (holds(graph, event)) {
                    finishAtWatermark(event, graph, journey, context::output);
                } else if (deadlinePassed && graceOver) {
                    dropAsUnreachable(event, context::output);
                } else if (deadlinePassed) {
                    waitingForGraph.add(event);
                    context.timerService().registerProcessingTimeTimer(graphLoadGraceEnds);
                } else {
                    waitingForGraph.add(event);
                    context.timerService().registerEventTimeTimer(graphLoadDeadline(eventTime));
                }
            }
            if (waitingForGraph.size() < events.size()) {
                storePending(eventTime, waitingForGraph);
            }
        }
    }

    /**
     * A trigger read before the graph snapshot has loaded waits at least the
     * graph-load allowance in real time after the start. On a fresh start the
     * trigger backlog moves the watermark faster than real time while the
     * snapshot loads, and the CDC source does not say when the snapshot ends.
     * The grace starts with the first record or timer after the start.
     */
    private void startGraphLoadGrace(long processingTime) {
        if (!graphLoadGraceStarted) {
            graphLoadGraceStarted = true;
            graphLoadGraceEnds = processingTime + graphLoadAllowanceMillis;
        }
    }

    /**
     * Applies one {@code campaign_nodes} row. Studio saves a campaign by
     * deleting every node row and inserting each one again, in one transaction,
     * and CDC delivers the rows one at a time. A delete therefore takes the
     * campaign's graph down, and the inserted rows collect in its load until
     * they hold every row of the save. Only then does the graph go live again.
     * A trigger never meets part of a save, and while the graph is down it
     * waits for the graph, so a node never completes before its children
     * arrive. An update changes one whole row, so it applies to a live graph at
     * once.
     */
    @Override
    public void processBroadcastElement(Row update, Context context, Collector<UserCampaignState> out)
        throws Exception {
        startGraphLoadGrace(context.currentProcessingTime());
        BroadcastState<String, CampaignGraph> live = context.getBroadcastState(graphStateDescriptor);
        BroadcastState<String, CampaignGraphLoad> loads = context.getBroadcastState(GRAPH_LOADS);
        String campaignId = update.getFieldAs(CampaignNodesTable.CAMPAIGN_ID);
        String nodeId = update.getFieldAs(CampaignNodesTable.NODE_ID);
        RowKind kind = update.getKind();
        if (kind == RowKind.UPDATE_BEFORE) {
            // The update's after image replaces the node.
            return;
        }
        if (kind == RowKind.DELETE) {
            CampaignGraph takenDown = live.get(campaignId);
            live.remove(campaignId);
            loads.remove(campaignId);
            if (takenDown != null) {
                dropTriggersDecidedAgainst(campaignId, takenDown, context);
            }
            return;
        }
        OptionalLong graphVersion = graphVersion(update);
        if (graphVersion.isEmpty()) return;
        CampaignGraph graph;
        if (kind == RowKind.UPDATE_AFTER && live.contains(campaignId)) {
            graph = applyUpdate(live.get(campaignId), nodeId, GraphNode.fromRow(update))
                .withRowOf(graphVersion.getAsLong());
        } else {
            // An update while the graph is down belongs to the save in progress.
            OptionalInt campaignNodeCount = campaignNodeCount(update);
            if (campaignNodeCount.isEmpty()) return;
            CampaignGraphLoad load = loads.get(campaignId);
            load = (load == null ? CampaignGraphLoad.startingFrom(live.get(campaignId)) : load)
                .insert(nodeId, GraphNode.fromRow(update), graphVersion.getAsLong());
            if (!load.holdsSaveOf(campaignNodeCount.getAsInt())) {
                loads.put(campaignId, load);
                return;
            }
            loads.remove(campaignId);
            graph = load.graph;
        }
        if (graph.size() == 0) {
            live.remove(campaignId);
            return;
        }
        live.put(campaignId, graph);

        String journeySuffix = JourneyTriggerEvent.JOURNEY_KEY_SEPARATOR + campaignId;
        long watermark = context.currentWatermark();
        context.applyToKeyedState(pendingDescriptor, (journeyKey, ignored) -> {
            if (journeyKey.endsWith(journeySuffix)) {
                retryAfterGraphUpdate(live, graph, watermark, context, out);
            }
        });
    }

    /**
     * The first delete row of a change takes the campaign's live graph down.
     * A trigger without a graph version, buffered until then for a node of that
     * graph, was decided against it, and the change may delete the node, or
     * delete the campaign and publish it again under the same ids. Such a
     * trigger must not complete a node of the next graph, so it is dropped as
     * unreachable. A trigger with a version waits for the next graph, which
     * drops it if the graph is newer than the trigger's: a resume writes the
     * same version, and a publish that customer decision applied first writes
     * the trigger's own. A trigger kept for every entry that completed its
     * node in an entry ends without a drop. A trigger for a node the graph does not
     * hold waits
     * for the save that adds it.
     */
    private void dropTriggersDecidedAgainst(String campaignId, CampaignGraph takenDown, Context context)
        throws Exception {
        String journeySuffix = JourneyTriggerEvent.JOURNEY_KEY_SEPARATOR + campaignId;
        context.applyToKeyedState(pendingDescriptor, (journeyKey, pending) -> {
            if (!journeyKey.endsWith(journeySuffix)) return;
            Map<String, Map<String, UserCampaignState>> journey = entrySnapshot();
            for (Long timestamp : sorted(pending.keys())) {
                ArrayList<VersionedTrigger> waiting = new ArrayList<>();
                List<VersionedTrigger> events = pending.get(timestamp);
                for (VersionedTrigger event : events) {
                    if (event.graphVersion() != null || takenDown.node(event.trigger().nodeId()) == null) {
                        waiting.add(event);
                    } else if (!completedInAnyEntry(event.trigger(), journey)) {
                        unreachableEventCounter.inc();
                        context.output(UNREACHABLE_EVENTS, event.trigger());
                    }
                }
                if (waiting.isEmpty()) {
                    pending.remove(timestamp);
                } else if (waiting.size() < events.size()) {
                    pending.put(timestamp, waiting);
                }
            }
        });
    }

    private static CampaignGraph applyUpdate(CampaignGraph live, String nodeId, Optional<GraphNode> node) {
        return node.map(live::upsert).orElseGet(() -> live.remove(nodeId));
    }

    /**
     * The version of the graph that the row's save wrote. The column is
     * {@code NOT NULL}, so a row without it is malformed and is logged and
     * dropped.
     */
    private static OptionalLong graphVersion(Row update) {
        if (update.getField(CampaignNodesTable.GRAPH_VERSION) instanceof Long version) {
            return OptionalLong.of(version);
        }
        LOG
            .warn("Ignoring campaign node {}:{} without a {}", update.getField(CampaignNodesTable.CAMPAIGN_ID),
                update.getField(CampaignNodesTable.NODE_ID), CampaignNodesTable.GRAPH_VERSION);
        return OptionalLong.empty();
    }

    /**
     * The number of nodes in the save that wrote the row. The column is
     * {@code NOT NULL} with a check above 0, so a row without it is malformed
     * and is logged and dropped.
     */
    private static OptionalInt campaignNodeCount(Row update) {
        if (update.getField(CampaignNodesTable.CAMPAIGN_NODE_COUNT) instanceof Integer count && count > 0) {
            return OptionalInt.of(count);
        }
        LOG
            .warn("Ignoring campaign node {}:{} without a {} above 0", update.getField(CampaignNodesTable.CAMPAIGN_ID),
                update.getField(CampaignNodesTable.NODE_ID), CampaignNodesTable.CAMPAIGN_NODE_COUNT);
        return OptionalInt.empty();
    }

    /**
     * Retries a journey's buffered triggers in event-time order after its
     * campaign graph changed. A trigger whose node, or a node above it, is not
     * in the graph yet keeps waiting. A trigger the watermark has passed, whose
     * timer has therefore fired, and that still cannot apply is unreachable.
     */
    private void retryAfterGraphUpdate(ReadOnlyBroadcastState<String, CampaignGraph> graphs, CampaignGraph graph,
        long watermark, Context context, Collector<UserCampaignState> out) throws Exception {
        Map<String, Map<String, UserCampaignState>> journey = entrySnapshot();
        retryPendingMatches(graphs, journey, out, context::output);

        for (Long timestamp : pendingTimestamps()) {
            if (timestamp > watermark) break;
            List<VersionedTrigger> events = pendingByTimestamp.get(timestamp);
            if (events == null) continue;
            ArrayList<VersionedTrigger> waiting = new ArrayList<>();
            for (VersionedTrigger event : events) {
                if (holds(graph, event)) {
                    finishAtWatermark(event, graph, journey, context::output);
                } else {
                    waiting.add(event);
                }
            }
            if (waiting.size() < events.size()) {
                storePending(timestamp, waiting);
            }
        }
    }

    /**
     * Whether the graph holds everything the trigger needs: the graph it was
     * decided against or a later one, its node, and every node above it. A
     * trigger the graph does not hold waits for its graph.
     */
    private static boolean holds(CampaignGraph graph, VersionedTrigger trigger) {
        return graph != null && !decidedAgainstUnloadedGraph(trigger, graph)
            && hasPathToRoot(graph, trigger.trigger().nodeId());
    }

    /**
     * A trigger decided against an older graph than the live one, which a
     * later publish replaced. It names its node by id only, and the node may
     * have been deleted, or deleted and published again under the same id, so
     * it must not complete a node of this graph (JEX-FR-12). A trigger without
     * a version, written before producers set it, is never older.
     */
    private static boolean decidedAgainstReplacedGraph(VersionedTrigger trigger, CampaignGraph graph) {
        return graph != null && trigger.graphVersion() != null && trigger.graphVersion() < graph.getGraphVersion();
    }

    /**
     * A trigger decided against a newer graph than the live one: customer
     * decision read a publish that has not gone live here yet. It waits for
     * that graph, as a trigger whose graph has not arrived does.
     */
    private static boolean decidedAgainstUnloadedGraph(VersionedTrigger trigger, CampaignGraph graph) {
        return trigger.graphVersion() != null && trigger.graphVersion() > graph.getGraphVersion();
    }

    private static boolean hasPathToRoot(CampaignGraph graph, String nodeId) {
        GraphNode node = graph == null ? null : graph.node(nodeId);
        // The depth bound ends the walk on a cycle of parent ids.
        for (int depth = 0; node != null && depth <= graph.size(); depth++) {
            if (node.parentNodeId() == null) return true;
            node = graph.node(node.parentNodeId());
        }
        return false;
    }

    private void storePending(long timestamp, List<VersionedTrigger> events) throws Exception {
        if (events.isEmpty()) {
            pendingByTimestamp.remove(timestamp);
        } else {
            pendingByTimestamp.put(timestamp, events);
        }
    }

    /**
     * Buffers a trigger unless the same trigger is buffered already, or that
     * would put its entry's buffer over the limit. A trigger that names no
     * entry counts against the triggers that name none. Producers deliver at
     * least once, so a duplicate is not buffered or counted again.
     */
    private void bufferUntilWatermark(VersionedTrigger trigger, ReadOnlyContext context) throws Exception {
        bufferUntilWatermark(trigger, false, context);
    }

    /**
     * A trigger that already applied to an entry is not reported at the state
     * limit when it cannot also wait for later entries, since it was not
     * dropped.
     */
    private void bufferUntilWatermark(VersionedTrigger trigger, boolean applied, ReadOnlyContext context)
        throws Exception {
        List<VersionedTrigger> buffered = pendingByTimestamp.get(trigger.eventTimestamp());
        if (buffered != null && buffered.contains(trigger)) return;
        if (overBufferLimit(trigger)) {
            if (applied) return;
            stateLimitEventCounter.inc();
            context.output(STATE_LIMIT_EVENTS, trigger.trigger());
            return;
        }
        buffer(trigger);
        context.timerService().registerEventTimeTimer(trigger.eventTimestamp());
    }

    private void buffer(VersionedTrigger trigger) throws Exception {
        List<VersionedTrigger> buffered = pendingByTimestamp.get(trigger.eventTimestamp());
        ArrayList<VersionedTrigger> events = buffered == null ? new ArrayList<>() : new ArrayList<>(buffered);
        events.add(trigger);
        pendingByTimestamp.put(trigger.eventTimestamp(), events);
    }

    /**
     * The event time after which a trigger stops waiting for its node, or a node
     * above it, to arrive. A node that has not arrived by then was most likely
     * deleted.
     */
    private long graphLoadDeadline(long eventTime) {
        return eventTime + graphLoadAllowanceMillis;
    }

    /**
     * The journey key's entries, each with its completed nodes by node id, in
     * entry id order. The maps are copies the caller may change, and an entry
     * the caller then stores is the map the caller keeps changing, so it must
     * store it again after each change.
     */
    private Map<String, Map<String, UserCampaignState>> entrySnapshot() throws Exception {
        Map<String, Map<String, UserCampaignState>> journey = new TreeMap<>();
        for (Map.Entry<String, Map<String, UserCampaignState>> entry : entries.entries()) {
            journey.put(entry.getKey(), new HashMap<>(entry.getValue()));
        }
        return journey;
    }

    private boolean overBufferLimit(VersionedTrigger trigger) throws Exception {
        int count = 0;
        long bytes = estimatedBytes(trigger);
        for (List<VersionedTrigger> events : pendingByTimestamp.values()) {
            for (VersionedTrigger event : events) {
                if (!Objects.equals(event.entryId(), trigger.entryId())) continue;
                count++;
                bytes += estimatedBytes(event);
                if (count >= maxPendingMatchesPerJourney || bytes > maxPendingBytesPerJourney) return true;
            }
        }
        return count >= maxPendingMatchesPerJourney || bytes > maxPendingBytesPerJourney;
    }

    static long estimatedBytes(VersionedTrigger trigger) {
        JourneyTriggerEvent event = trigger.trigger();
        long bytes = 128L;
        bytes += utf8Bytes(trigger.entryId());
        bytes += utf8Bytes(event.eventId());
        bytes += utf8Bytes(event.canonId());
        bytes += utf8Bytes(event.domainUserId());
        bytes += utf8Bytes(event.networkUserId());
        bytes += utf8Bytes(event.userId());
        bytes += utf8Bytes(event.campaignId());
        bytes += utf8Bytes(event.nodeId());
        bytes += utf8Bytes(event.branch());
        bytes += utf8Bytes(event.eventName());
        bytes += utf8Bytes(event.contextJson());
        return bytes;
    }

    private static int utf8Bytes(String value) {
        return value == null ? 0 : value.getBytes(StandardCharsets.UTF_8).length;
    }

    /**
     * A late segment trigger from before its parent's completion, for a segment
     * the entry waits at, still reports a metric change that the segment's check
     * may have missed. Its parent has completed, so the change is checked again at
     * the parent's completion time instead of being dropped. The trigger itself
     * completes nothing, so only a {@code recheck} from the engine is used.
     */
    private Optional<SegmentCheck> lateSegmentRecheck(JourneyTriggerEvent event, String entryId,
        CampaignGraph graph, Map<String, UserCampaignState> completed) {
        GraphNode node = graph.node(event.nodeId());
        if (node == null || node.nodeType() != NodeType.segment) return Optional.empty();
        // A copy, since a late trigger must complete nothing.
        TransitionEngine.Evaluation evaluation = engine.evaluate(event, entryId, graph, new HashMap<>(completed));
        return evaluation.status() == TransitionEngine.Status.IGNORED
            ? evaluation.segmentChecks().stream().findFirst()
            : Optional.empty();
    }

    /**
     * Customer decision answers a segment check with a {@code yes} at the time the
     * segment's parent completed, which the watermark may have passed while the
     * check went to customer decision and back. A trigger for a segment at exactly
     * its parent's completion time in the entry is such an answer, or a metric
     * change by the event that completed the parent. Either way its parent has
     * completed, so it applies at once, and it is never late. No field in the
     * trigger marks the answer, since both apply the same way.
     */
    private static boolean answersSegmentCheck(JourneyTriggerEvent event, CampaignGraph graph,
        Map<String, UserCampaignState> completed) {
        GraphNode node = graph.node(event.nodeId());
        if (node == null || node.nodeType() != NodeType.segment || node.parentNodeId() == null) {
            return false;
        }
        UserCampaignState parent = completed.get(node.parentNodeId());
        return parent != null && parent.eventTimestamp() == event.eventTimestamp();
    }

    /**
     * A watch's timer emits its deadline as a trigger, with the deadline as event
     * time. After the timer flow was down past the deadline, that time is behind
     * the watermark, and the timeout must still apply (JEX-NFR-05). Customer
     * decision completes a watch only on {@code success}.
     */
    private static boolean isWatchDeadline(JourneyTriggerEvent event, CampaignGraph graph) {
        GraphNode node = graph == null ? null : graph.node(event.nodeId());
        return node != null && node.nodeType() == NodeType.watch
            && (Branch.timeout.name().equals(event.branch()) || Branch.next.name().equals(event.branch()));
    }

    /**
     * Retries the journey's buffered triggers in event-time order. Map state
     * iterates in hash order on the heap backend, so the keys are sorted here.
     * A trigger kept for every entry stays buffered until the watermark passes
     * it.
     */
    private void retryPendingMatches(ReadOnlyBroadcastState<String, CampaignGraph> graphs,
        Map<String, Map<String, UserCampaignState>> journey, Collector<UserCampaignState> out,
        SideOutputs outputs) throws Exception {
        ArrayList<Long> timestamps = pendingTimestamps();
        boolean applied;
        do {
            applied = false;
            for (Long timestamp : timestamps) {
                List<VersionedTrigger> events = pendingByTimestamp.get(timestamp);
                if (events == null) continue;
                ArrayList<VersionedTrigger> waiting = new ArrayList<>();
                for (VersionedTrigger event : events) {
                    CampaignGraph graph = graphs.get(event.trigger().campaignId());
                    if (decidedAgainstReplacedGraph(event, graph)) {
                        dropAsUnreachable(event, outputs);
                        continue;
                    }
                    if (!readyFor(event, graph)) {
                        waiting.add(event);
                        continue;
                    }
                    boolean everyEntry = appliesToEveryEntry(event, graph);
                    if (everyEntry) {
                        waiting.add(event);
                    }
                    for (String entryId : targets(event, graph, journey.keySet())) {
                        Map<String, UserCampaignState> completed = journey.getOrDefault(entryId, new HashMap<>());
                        TransitionEngine.Evaluation evaluation = engine
                            .evaluate(event.trigger(), entryId, graph, completed);
                        if (evaluation.status() == TransitionEngine.Status.DEFERRED) {
                            if (!everyEntry) waiting.add(event);
                        } else if (evaluation.status() == TransitionEngine.Status.APPLIED) {
                            applied = true;
                            emitAndRemember(entryId, completed, evaluation, journey, out, outputs);
                        } else if (evaluation.status() == TransitionEngine.Status.WRONG_BRANCH && !everyEntry) {
                            dropOnWrongBranch(event.trigger(), outputs);
                        }
                        // A buffered segment trigger from before its parent asks for no
                        // second check: customer decision counted its metric change before
                        // it sent the trigger, so the check sent when the parent completed
                        // already sees it.
                    }
                }
                if (!waiting.equals(events)) {
                    storePending(timestamp, waiting);
                }
            }
        } while (applied);
    }

    private ArrayList<Long> pendingTimestamps() throws Exception {
        return sorted(pendingByTimestamp.keys());
    }

    private static ArrayList<Long> sorted(Iterable<Long> keys) {
        ArrayList<Long> timestamps = new ArrayList<>();
        for (Long timestamp : keys) {
            timestamps.add(timestamp);
        }
        Collections.sort(timestamps);
        return timestamps;
    }

    /**
     * Keeps an entry's completed nodes, which the evaluation added to, and emits
     * the nodes it completed. An entry is kept only once a node completed in it.
     */
    private void emitAndRemember(String entryId, Map<String, UserCampaignState> completed,
        TransitionEngine.Evaluation evaluation, Map<String, Map<String, UserCampaignState>> journey,
        Collector<UserCampaignState> out, SideOutputs outputs) throws Exception {
        journey.put(entryId, completed);
        entries.put(entryId, completed);
        evaluation.transitions().forEach(out::collect);
        evaluation.segmentChecks().forEach(check -> outputs.output(SEGMENT_CHECKS, check));
    }

    private void dropAsLate(JourneyTriggerEvent event, SideOutputs outputs) {
        lateEventCounter.inc();
        outputs.output(LATE_EVENTS, event);
    }

    private void dropAsUnreachable(VersionedTrigger trigger, SideOutputs outputs) {
        unreachableEventCounter.inc();
        outputs.output(UNREACHABLE_EVENTS, trigger.trigger());
    }

    private void dropOnWrongBranch(JourneyTriggerEvent event, SideOutputs outputs) {
        wrongBranchEventCounter.inc();
        outputs.output(WRONG_BRANCH_EVENTS, event);
    }

    /** The side outputs of the context that runs the function. */
    private interface SideOutputs {
        <X> void output(OutputTag<X> tag, X value);
    }
}
