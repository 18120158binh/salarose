package com.cdp.platform.jobs.customerdecision.transforms;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.LongSupplier;

import org.apache.flink.api.common.functions.OpenContext;
import org.apache.flink.api.common.state.MapState;
import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.state.ReadOnlyBroadcastState;
import org.apache.flink.api.common.state.StateTtlConfig;
import org.apache.flink.api.common.state.ValueState;
import org.apache.flink.api.common.state.ValueStateDescriptor;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.metrics.Counter;
import org.apache.flink.streaming.api.functions.co.KeyedBroadcastProcessFunction;
import org.apache.flink.types.Either;
import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;
import org.apache.flink.util.Collector;
import org.apache.flink.util.OutputTag;

import com.cdp.platform.shared.config.DatabaseConfig;
import com.cdp.platform.shared.db.repositories.CampaignsTable;
import com.cdp.platform.shared.db.repositories.SegmentsTable;
import com.cdp.platform.shared.db.repositories.UserMetricRepository;
import com.cdp.platform.shared.models.CustomerProfileMutationEvent;
import com.cdp.platform.shared.models.Event;
import com.cdp.platform.shared.models.MetricSeries;
import com.cdp.platform.shared.models.SegmentCheck;
import com.cdp.platform.shared.models.db.Campaign;
import com.cdp.platform.shared.models.db.CampaignNode;
import com.cdp.platform.shared.models.db.MetricConfig;
import com.cdp.platform.shared.models.db.Segment;
import com.cdp.platform.shared.models.node.MetricPredicate;
import com.cdp.platform.shared.models.node.PersonConditions;
import com.cdp.platform.shared.models.node.Predicate;
import com.cdp.platform.shared.models.node.SegmentMembership;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Counts each person's events into their metric series, and sends each
 * mutation on {@link #MUTATIONS}. Then selects the rules that may fire on the
 * event through a {@link RuleIndex}, or the segment of a segment check, and
 * decides each of them against the series in state. A rule whose metric
 * condition fails is dropped here, so its profile is never looked up. Each
 * input that leaves a rule standing emits one {@link Decision}, numbered in the
 * person's order. A decision with a rule that still waits for the profile
 * leaves on {@link #NEEDS_PROFILE}.
 *
 * <p>
 * The broadcast input carries what conditions name on the left, the metric
 * definitions and the segment rows, and the campaign and node rows on the
 * right. This is the job's only copy of the rules and the segments, so every
 * rule decided for one input comes from the version held when the input
 * arrived.
 */
public class CustomerBehaviorProcessFunction
    extends
        KeyedBroadcastProcessFunction<String, Either<Event, SegmentCheck>, Either<Either<MetricConfig, Row>, Either<Row, Row>>, Decision> {

    /**
     * Each mutation, for the profile writer. A side output, so the operator that
     * writes it receives the mutation without the candidates.
     */
    public static final OutputTag<CustomerProfileMutationEvent> MUTATIONS = new OutputTag<>("profile-mutations",
        TypeInformation.of(CustomerProfileMutationEvent.class));

    /** Each decision with a rule that waits for the profile. */
    public static final OutputTag<Decision> NEEDS_PROFILE = new OutputTag<>("needs-profile",
        TypeInformation.of(Decision.class));

    /**
     * The segments by id. A savepoint from before segments holds none, and the
     * segments source, new with it, reads every row at its first start.
     */
    public static final MapStateDescriptor<String, Segment> SEGMENTS = new MapStateDescriptor<>("segments",
        String.class, Segment.class);

    private static final long serialVersionUID = 1L;
    private static final Logger LOG = LoggerFactory.getLogger(CustomerBehaviorProcessFunction.class);
    private static final int REMEMBERED_EVENT_IDS = 512;
    /** The most state miss reads that run at once on one subtask. */
    static final int STATE_MISS_READS = 5;
    private final DatabaseConfig database;
    private final MapStateDescriptor<String, MetricConfig> configStateDescriptor;
    private final MapStateDescriptor<String, Campaign> campaignStateDescriptor;
    private final MapStateDescriptor<String, CampaignNode> nodeStateDescriptor;
    private final long stateRetentionDays;
    private final long allowedOutOfOrdernessMs;
    private final int maxMetricsPerCustomer;
    private final int maxStringValueBytes;
    private final int maxEventContextBytes;

    // MapState per user canon_id: metric_id -> MetricSeries
    private transient MapState<String, MetricSeries> metricState;
    // event_id -> event time. Nothing reads the time. It keeps the type that
    // savepoints from before the slots hold.
    private transient MapState<String, Long> recentEventIdsState;
    // slot -> event_id, in the order the ids were accepted.
    private transient MapState<Integer, String> recentEventIdSlots;
    private transient ValueState<Integer> nextEventIdSlot;
    private transient ValueState<Long> behaviorVersionState;
    // The sequence of the person's last decision.
    private transient ValueState<Long> decisionSequenceState;
    private transient MetricsConditionEvaluator metricsEvaluator;
    private transient UserMetricRepository metricRepository;
    private transient Map<String, Set<String>> definitionIdsByEventName;
    private transient boolean definitionIndexInitialized;
    private transient Counter metricStateLimitCounter;
    private transient Counter metricValueLimitCounter;
    private transient Counter eventContextLimitCounter;
    private transient Counter invalidParsedEventCounter;
    private transient Counter unknownSegmentCounter;
    // The rows read for the event being processed, when its state missed.
    private transient StateMissRead.Stored stored;
    /**
     * Built from the broadcast state on the first input after a start or restore.
     */
    private transient RuleIndex rules;

    /** The job checks each setting when it reads it. */
    public CustomerBehaviorProcessFunction(DatabaseConfig database,
        MapStateDescriptor<String, MetricConfig> configStateDescriptor,
        MapStateDescriptor<String, Campaign> campaignStateDescriptor,
        MapStateDescriptor<String, CampaignNode> nodeStateDescriptor, long stateRetentionDays,
        long allowedOutOfOrdernessMs, int maxMetricsPerCustomer, int maxStringValueBytes, int maxEventContextBytes) {
        this.database = database;
        this.configStateDescriptor = configStateDescriptor;
        this.campaignStateDescriptor = campaignStateDescriptor;
        this.nodeStateDescriptor = nodeStateDescriptor;
        this.stateRetentionDays = stateRetentionDays;
        this.allowedOutOfOrdernessMs = allowedOutOfOrdernessMs;
        this.maxMetricsPerCustomer = maxMetricsPerCustomer;
        this.maxStringValueBytes = maxStringValueBytes;
        this.maxEventContextBytes = maxEventContextBytes;
    }

    @Override
    public void open(OpenContext openContext) throws Exception {
        super.open(openContext);

        metricRepository = openMetricRepository();

        StateTtlConfig ttlConfig = StateTtlConfig
            .newBuilder(Duration.ofDays(stateRetentionDays))
            .setUpdateType(StateTtlConfig.UpdateType.OnCreateAndWrite)
            .setStateVisibility(StateTtlConfig.StateVisibility.NeverReturnExpired)
            .cleanupInRocksdbCompactFilter(1000)
            .build();

        MapStateDescriptor<String, MetricSeries> descriptor = new MapStateDescriptor<>("user-metric-series-state",
            String.class, MetricSeries.class);
        descriptor.enableTimeToLive(ttlConfig);

        metricState = getRuntimeContext().getMapState(descriptor);
        definitionIdsByEventName = new HashMap<>();
        MapStateDescriptor<String, Long> recentEventIdsDescriptor = new MapStateDescriptor<>("recent-user-event-ids",
            String.class, Long.class);
        recentEventIdsDescriptor.enableTimeToLive(ttlConfig);
        recentEventIdsState = getRuntimeContext().getMapState(recentEventIdsDescriptor);
        MapStateDescriptor<Integer, String> recentEventIdSlotsDescriptor = new MapStateDescriptor<>(
            "recent-user-event-id-slots", Integer.class, String.class);
        recentEventIdSlotsDescriptor.enableTimeToLive(ttlConfig);
        recentEventIdSlots = getRuntimeContext().getMapState(recentEventIdSlotsDescriptor);
        ValueStateDescriptor<Integer> nextEventIdSlotDescriptor = new ValueStateDescriptor<>(
            "recent-user-event-id-next-slot", Integer.class);
        nextEventIdSlotDescriptor.enableTimeToLive(ttlConfig);
        nextEventIdSlot = getRuntimeContext().getState(nextEventIdSlotDescriptor);
        ValueStateDescriptor<Long> behaviorVersionDescriptor = new ValueStateDescriptor<>("user-behavior-version",
            Long.class);
        behaviorVersionDescriptor.enableTimeToLive(ttlConfig);
        behaviorVersionState = getRuntimeContext().getState(behaviorVersionDescriptor);
        ValueStateDescriptor<Long> decisionSequenceDescriptor = new ValueStateDescriptor<>("decision-sequence",
            Long.class);
        decisionSequenceDescriptor.enableTimeToLive(ttlConfig);
        decisionSequenceState = getRuntimeContext().getState(decisionSequenceDescriptor);
        metricsEvaluator = new MetricsConditionEvaluator();
        metricStateLimitCounter = getRuntimeContext().getMetricGroup().counter("metricStateLimitExceeded");
        metricValueLimitCounter = getRuntimeContext().getMetricGroup().counter("metricStringValueLimitExceeded");
        eventContextLimitCounter = getRuntimeContext().getMetricGroup().counter("eventContextLimitExceeded");
        invalidParsedEventCounter = getRuntimeContext().getMetricGroup().counter("invalidParsedEvents");
        unknownSegmentCounter = getRuntimeContext().getMetricGroup().counter("unknownSegmentConditions");
    }

    /** The store read on a state miss. Tests replace it to run without Postgres. */
    UserMetricRepository openMetricRepository() {
        return UserMetricRepository.open(database, STATE_MISS_READS);
    }

    @Override
    public void close() throws Exception {
        if (metricRepository != null) metricRepository.close();
        super.close();
    }

    /**
     * What the input needs from {@code user_metrics} before it can be processed,
     * or null when state holds everything it needs: the series it updates, the
     * series its candidate rules reference, and the behavior version when it
     * updates a series. Reads the current person's state and changes nothing.
     * Without a repository there are no stored rows, so nothing is read.
     */
    StateMissRead stateMiss(Either<Event, SegmentCheck> input, ReadOnlyBroadcastState<String, MetricConfig> configs,
        ReadOnlyBroadcastState<String, CampaignNode> nodes, ReadOnlyBroadcastState<String, Campaign> campaigns,
        ReadOnlyBroadcastState<String, Segment> segments) throws Exception {
        if (metricRepository == null) return null;
        RuleIndex index = rules(nodes, campaigns, segments);
        Map<String, String> missing = new HashMap<>();
        boolean versionMissing = false;
        if (input.isRight()) {
            addMissing(index.selectArrival(input.right()).metricIds(), configs, missing);
        } else {
            Event event = input.left();
            if (!accepts(event) || recentEventIdsState.contains(event.eventId())) return null;
            List<MetricConfig> matched = matchedDefinitions(event, configs);
            if (metricStateCount() < maxMetricsPerCustomer) {
                for (MetricConfig config : matched) {
                    if (!metricState.contains(config.id())) missing.put(config.id(), config.valueType());
                }
            }
            // Which series the event changes is known only once it is counted, so
            // the rules that any counted series could select are read for.
            Set<String> counted = new HashSet<>();
            matched.forEach(config -> counted.add(config.id()));
            addMissing(index.select(event, counted).metricIds(), configs, missing);
            versionMissing = !matched.isEmpty() && behaviorVersionState.value() == null;
        }
        if (missing.isEmpty() && !versionMissing) return null;
        return new StateMissRead(canonIdOf(input), missing, versionMissing);
    }

    private void addMissing(Set<String> metricIds, ReadOnlyBroadcastState<String, MetricConfig> configs,
        Map<String, String> missing) throws Exception {
        for (String metricId : metricIds) {
            if (missing.containsKey(metricId) || metricState.contains(metricId)) continue;
            MetricConfig config = configs.get(metricId);
            missing.put(metricId, config == null ? null : config.valueType());
        }
    }

    /**
     * Reads what a state miss needs. Runs off the subtask thread, so it touches
     * no state.
     */
    StateMissRead.Stored read(StateMissRead miss) {
        return miss.read(metricRepository);
    }

    /** The rows read for the next input to process, or null when none were. */
    void useStored(StateMissRead.Stored rows) {
        stored = rows;
    }

    /**
     * Remembers the id in the next slot of a ring of 512, and forgets the id that
     * held the slot, which was accepted 512 events earlier. Ids remembered before
     * the ring existed are in no slot. They expire with the state TTL.
     */
    private void rememberEvent(String eventId, long eventTimestamp) throws Exception {
        Integer next = nextEventIdSlot.value();
        int slot = next == null ? 0 : next;
        String forgotten = recentEventIdSlots.get(slot);
        if (forgotten != null) recentEventIdsState.remove(forgotten);
        recentEventIdsState.put(eventId, eventTimestamp);
        recentEventIdSlots.put(slot, eventId);
        nextEventIdSlot.update((slot + 1) % REMEMBERED_EVENT_IDS);
    }

    /** The person an input belongs to, which keys this function's state. */
    public static String canonIdOf(Either<Event, SegmentCheck> input) {
        return input.isLeft() ? input.left().canonId() : input.right().canonId();
    }

    @Override
    public void processElement(Either<Event, SegmentCheck> input, ReadOnlyContext ctx,
        Collector<Decision> out) throws Exception {
        restoreStored();
        if (input.isRight()) {
            SegmentCheck check = input.right();
            decide(parentTrigger(check), rules(ctx).selectArrival(check), ctx, out);
            return;
        }
        processEvent(input.left(), ctx, out);
    }

    /**
     * Puts the series read for this input into state, so the person's next inputs
     * do not read them again. A series the person has no row for goes in empty.
     * Past the limit of metrics per person, a read series is used for this input
     * only.
     */
    private void restoreStored() throws Exception {
        if (stored == null) return;
        for (Map.Entry<String, MetricSeries> series : stored.series().entrySet()) {
            if (metricState.contains(series.getKey())) continue;
            if (metricStateCount() >= maxMetricsPerCustomer) {
                metricStateLimitCounter.inc();
                return;
            }
            metricState.put(series.getKey(), series.getValue());
        }
    }

    private boolean accepts(Event event) {
        return hasRequiredFields(event) && !exceedsContextLimit(event);
    }

    private static boolean hasRequiredFields(Event event) {
        return event != null && event.canonId() != null && event.eventName() != null && event.eventId() != null
            && !event.eventId().isBlank() && event.eventTimestamp() != null;
    }

    private boolean exceedsContextLimit(Event event) {
        return event.eventJson() != null
            && event.eventJson().getBytes(StandardCharsets.UTF_8).length > maxEventContextBytes;
    }

    private List<MetricConfig> matchedDefinitions(Event event, ReadOnlyBroadcastState<String, MetricConfig> configs)
        throws Exception {
        ensureDefinitionIndex(configs);
        List<MetricConfig> matched = new ArrayList<>();
        for (String candidateId : definitionIdsByEventName
            .getOrDefault(normalizeEventName(event.eventName()), Set.of())) {
            MetricConfig config = configs.get(candidateId);
            if (config != null && config.enabled() && config.matches(event)) matched.add(config);
        }
        return matched;
    }

    private void processEvent(Event event, ReadOnlyContext ctx, Collector<Decision> out) throws Exception {
        if (!hasRequiredFields(event)) {
            invalidParsedEventCounter.inc();
            return;
        }
        if (exceedsContextLimit(event)) {
            eventContextLimitCounter.inc();
            return;
        }

        if (recentEventIdsState.contains(event.eventId())) {
            return;
        }

        ReadOnlyBroadcastState<String, MetricConfig> activeConfigs = ctx
            .getBroadcastState(configStateDescriptor);

        long eventTime = event.eventTimestamp();
        rememberEvent(event.eventId(), eventTime);
        Long storedBehaviorVersion = behaviorVersionState.value();
        List<MetricConfig> matched = matchedDefinitions(event, activeConfigs);
        // An event that no definition counts changes no series, so it needs no version.
        long behaviorVersion = matched.isEmpty()
            ? 0
            : nextBehaviorVersion(storedBehaviorVersion, this::lastStoredBehaviorVersion);
        List<MetricSeries> replacements = new ArrayList<>();

        for (MetricConfig config : matched) {
            MetricSeries current = metricState.get(config.id());
            if (current == null) {
                if (metricStateCount() >= maxMetricsPerCustomer) {
                    metricStateLimitCounter.inc();
                    continue;
                }
                current = MetricSeries.empty(config.id(), config.valueType());
            }

            Object value = typedValue(event, config);
            if (value instanceof String stringValue
                && stringValue.getBytes(StandardCharsets.UTF_8).length > maxStringValueBytes) {
                metricValueLimitCounter.inc();
                continue;
            }
            MetricSeries updated = current
                .add(event.eventId(), eventTime, value, config.function(), config.maxRetentionDurationMs(),
                    allowedOutOfOrdernessMs);
            if (updated == null) continue;

            metricState.put(config.id(), updated);
            replacements.add(updated);
        }

        Set<String> changedMetricIds = new HashSet<>();
        if (!replacements.isEmpty()) {
            behaviorVersionState.update(behaviorVersion);
            ctx
                .output(MUTATIONS, new CustomerProfileMutationEvent(1, event.canonId(), behaviorVersion,
                    event.eventId(), eventTime, replacements));
            replacements.forEach(series -> changedMetricIds.add(series.metricId()));
        } else if (storedBehaviorVersion == null && !matched.isEmpty()) {
            // Keep the seed, so the person's next event does not read Postgres again.
            behaviorVersionState.update(behaviorVersion - 1);
        }
        decide(event, rules(ctx).select(event, changedMetricIds), ctx, out);
    }

    /**
     * Decides each candidate on each branch its trigger matched, against the
     * series it references, after this input is counted. A group passes here
     * when one of its behavior conditions holds. The rule fires here when every
     * group passes. It waits for the profile when each group left has a profile
     * condition, and is dropped when a group left has none. A segment membership
     * is decided the same way from the segment's current conditions, so it
     * passes, fails, or leaves its profile conditions to the lookup.
     */
    private void decide(Event event, CandidateSelection candidates, ReadOnlyContext ctx, Collector<Decision> out)
        throws Exception {
        if (!candidates.hasCandidates()) return;

        Map<String, MetricSeries> referenced = new HashMap<>();
        for (String metricId : candidates.metricIds()) {
            MetricSeries series = seriesOf(metricId);
            if (series != null) referenced.put(metricId, series);
        }
        RuleIndex index = rules(ctx);
        long checkTime = event.eventTimestamp();
        List<RuleDecision> decided = new ArrayList<>();
        for (Map.Entry<String, List<String>> candidate : candidates.branches().entrySet()) {
            String ruleKey = candidate.getKey();
            CampaignNode node = index.node(ruleKey);
            for (String branch : candidate.getValue()) {
                Optional<List<MetricPredicate>> behavior = index.behaviorGroups(ruleKey, branch);
                if (behavior.isEmpty()) continue;
                node
                    .conditionsOn(branch)
                    .profileLeft(group -> metricsEvaluator.evaluate(behavior.get().get(group), referenced, checkTime),
                        membership -> segmentLeft(index, membership, referenced, checkTime))
                    .ifPresent(profileLeft -> decided.add(RuleDecision.of(node, branch, profileLeft)));
            }
        }
        if (decided.isEmpty()) return;

        Long last = decisionSequenceState.value();
        long sequence = last == null ? ctx.currentProcessingTime() : last + 1;
        decisionSequenceState.update(sequence);
        Decision decision = Decision.of(event, sequence, last == null, decided);
        if (decision.needsProfile()) {
            ctx.output(NEEDS_PROFILE, decision);
        } else {
            out.collect(decision);
        }
    }

    /**
     * The series in state, else the one read for this input past the limit of
     * metrics per person, else null for an empty series.
     */
    private MetricSeries seriesOf(String metricId) throws Exception {
        MetricSeries series = metricState.get(metricId);
        if (series != null || stored == null) return series;
        return stored.series().get(metricId);
    }

    /**
     * What a segment membership leaves on the profile, in the shape of
     * {@link PersonConditions#profileLeft}. A membership of a segment the job
     * does not hold fails, whether it asks for {@code in} or {@code not_in},
     * because the job cannot tell whether the person is a member.
     */
    private Optional<List<Predicate>> segmentLeft(RuleIndex index, SegmentMembership membership,
        Map<String, MetricSeries> referenced, long checkTime) {
        Optional<Segment> segment = index.segment(membership.segmentId());
        Optional<List<MetricPredicate>> behavior = segment.flatMap(index::segmentBehaviorGroups);
        if (behavior.isEmpty()) {
            unknownSegmentCounter.inc();
            return Optional.empty();
        }
        return membership
            .left(segment
                .get()
                .conditions()
                .profileLeft(group -> metricsEvaluator.evaluate(behavior.get().get(group), referenced, checkTime),
                    nested -> Optional.empty()));
    }

    private RuleIndex rules(ReadOnlyContext ctx) throws Exception {
        return rules(ctx.getBroadcastState(nodeStateDescriptor), ctx.getBroadcastState(campaignStateDescriptor),
            ctx.getBroadcastState(SEGMENTS));
    }

    private RuleIndex rules(ReadOnlyBroadcastState<String, CampaignNode> nodes,
        ReadOnlyBroadcastState<String, Campaign> campaigns, ReadOnlyBroadcastState<String, Segment> segments)
        throws Exception {
        if (rules == null) {
            rules = RuleIndex.of(nodes.immutableEntries(), campaigns.immutableEntries(), segments.immutableEntries());
        }
        return rules;
    }

    /**
     * The event that a segment check stands for: the trigger that completed the
     * segment's parent.
     */
    private static Event parentTrigger(SegmentCheck check) {
        return new Event(check.canonId(), check.domainUserId(), check.networkUserId(), check.userId(),
            check.eventName(), check.eventTimestamp(), null, null, null, null, null, null, check.eventId());
    }

    private long lastStoredBehaviorVersion() {
        return metricRepository == null ? 0 : stored.behaviorVersion().orElseThrow();
    }

    private int metricStateCount() throws Exception {
        int count = 0;
        for (String ignored : metricState.keys()) {
            count++;
            if (count >= maxMetricsPerCustomer) return count;
        }
        return count;
    }

    /**
     * The behavior version for a person's next mutation. The stored version is
     * the counter in state, or null when state has none. On a miss the counter
     * continues from the highest version in the person's rows, so it never goes
     * back after state is lost.
     */
    static long nextBehaviorVersion(Long storedVersion, LongSupplier lastStoredRowVersion) {
        return (storedVersion == null ? lastStoredRowVersion.getAsLong() : storedVersion) + 1;
    }

    /**
     * The event's value for the metric. It is null when the event lacks the
     * attribute, or when its value cannot be read as the metric's type.
     */
    static Object typedValue(Event event, MetricConfig config) {
        String raw = event.propertyValue(config.aggField());
        if (raw == null) return null;
        try {
            return switch (config.type()) {
                case PRESENCE -> null;
                case NUMBER -> numberValue(raw);
                case BOOLEAN -> booleanValue(raw);
                case STRING -> raw;
            };
        } catch (IllegalArgumentException unreadable) {
            LOG
                .warn("Recording metric {} for event {} with no value: the value cannot be read as {}", config.id(),
                    event.eventId(), config.valueType());
            return null;
        }
    }

    private static double numberValue(String raw) {
        double value = Double.parseDouble(raw);
        if (!Double.isFinite(value)) throw new IllegalArgumentException("Not a finite number: " + raw);
        return value;
    }

    private static boolean booleanValue(String raw) {
        if ("true".equalsIgnoreCase(raw)) return true;
        if ("false".equalsIgnoreCase(raw)) return false;
        throw new IllegalArgumentException("Not a boolean: " + raw);
    }

    @Override
    public void processBroadcastElement(Either<Either<MetricConfig, Row>, Either<Row, Row>> update, Context ctx,
        Collector<Decision> out) throws Exception {
        if (update.isRight()) {
            applyRule(update.right(), ctx);
        } else if (update.left().isLeft()) {
            applyDefinition(update.left().left(), ctx);
        } else {
            applySegment(update.left().right(), ctx);
        }
    }

    /**
     * Applies a {@code segments} row from CDC. A segment that is deleted, or
     * whose row does not parse, is removed, so a membership of it fails until a
     * row that parses replaces it. An update's before image is skipped, as for
     * rule rows.
     */
    private void applySegment(Row row, Context ctx) throws Exception {
        if (row.getKind() == RowKind.UPDATE_BEFORE) return;
        var segments = ctx.getBroadcastState(SEGMENTS);
        String segmentId = row.getFieldAs(SegmentsTable.ID);
        Optional<Segment> segment = row.getKind() == RowKind.DELETE ? Optional.empty() : Segment.load(row);
        if (segment.isPresent()) {
            segments.put(segmentId, segment.get());
        } else {
            segments.remove(segmentId);
        }
        if (rules != null) rules.putSegment(segmentId, segment.orElse(null));
    }

    private void applyRule(Either<Row, Row> update, Context ctx) throws Exception {
        var campaignState = ctx.getBroadcastState(campaignStateDescriptor);
        var nodeState = ctx.getBroadcastState(nodeStateDescriptor);
        CampaignBroadcastState.apply(update, campaignState, nodeState);
        if (rules == null) return;
        if (update.isLeft()) {
            String campaignId = update.left().getFieldAs(CampaignsTable.ID);
            rules.putCampaign(campaignId, campaignState.get(campaignId));
        } else {
            String ruleKey = CampaignNode.stateKey(update.right());
            rules.putNode(ruleKey, nodeState.get(ruleKey));
        }
    }

    private void applyDefinition(MetricConfig config, Context ctx) throws Exception {
        if (config == null || config.id() == null) return;

        var state = ctx.getBroadcastState(configStateDescriptor);
        ensureDefinitionIndex(state);
        MetricConfig previous = state.get(config.id());
        removeFromDefinitionIndex(previous);
        if (!config.enabled()) {
            state.remove(config.id());
        } else {
            state.put(config.id(), config);
            addToDefinitionIndex(config);
        }
    }

    /**
     * Builds the index from broadcast state once per operator instance. The index
     * is not checkpointed. After a restore, broadcast state comes back full and the
     * CDC source does not send those definitions again, so the first event or the
     * first definition change, whichever comes first, must index them.
     */
    private void ensureDefinitionIndex(ReadOnlyBroadcastState<String, MetricConfig> configs)
        throws Exception {
        if (definitionIndexInitialized) return;
        definitionIdsByEventName.clear();
        for (Map.Entry<String, MetricConfig> entry : configs.immutableEntries()) {
            addToDefinitionIndex(entry.getValue());
        }
        definitionIndexInitialized = true;
    }

    private void addToDefinitionIndex(MetricConfig config) {
        if (config == null || !config.enabled() || config.id() == null) return;
        String eventName = normalizeEventName(config.eventName());
        definitionIdsByEventName.computeIfAbsent(eventName, ignored -> new LinkedHashSet<>()).add(config.id());
    }

    private void removeFromDefinitionIndex(MetricConfig config) {
        if (config == null || config.id() == null) return;
        String eventName = normalizeEventName(config.eventName());
        Set<String> ids = definitionIdsByEventName.get(eventName);
        if (ids == null) return;
        ids.remove(config.id());
        if (ids.isEmpty()) definitionIdsByEventName.remove(eventName);
    }

    private static String normalizeEventName(String eventName) {
        return eventName == null ? "" : eventName.trim().toLowerCase(Locale.ROOT);
    }
}
