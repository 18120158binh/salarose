package com.cdp.platform.jobs.customerdecision.transforms;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

import org.apache.flink.api.common.functions.DefaultOpenContext;
import org.apache.flink.api.common.serialization.SerializerConfigImpl;
import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.typeinfo.TypeHint;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.api.common.typeutils.TypeSerializer;
import org.apache.flink.core.memory.DataInputDeserializer;
import org.apache.flink.core.memory.DataOutputSerializer;
import org.apache.flink.state.rocksdb.EmbeddedRocksDBStateBackend;
import org.apache.flink.streaming.api.functions.async.CollectionSupplier;
import org.apache.flink.streaming.api.functions.async.ResultFuture;
import org.apache.flink.streaming.runtime.streamrecord.StreamRecord;
import org.apache.flink.streaming.runtime.tasks.mailbox.Mail;
import org.apache.flink.streaming.runtime.tasks.mailbox.TaskMailbox;
import org.apache.flink.streaming.util.KeyedBroadcastOperatorTestHarness;
import org.apache.flink.streaming.util.KeyedOneInputStreamOperatorTestHarness;
import org.apache.flink.streaming.util.ProcessFunctionTestHarnesses;
import org.apache.flink.types.Either;
import org.apache.flink.types.Row;

import com.cdp.platform.shared.db.repositories.UnreachableDatabase;
import com.cdp.platform.shared.db.repositories.UserMetricRepository;
import com.cdp.platform.shared.models.CustomerProfileMutationEvent;
import com.cdp.platform.shared.models.Event;
import com.cdp.platform.shared.models.SegmentCheck;
import com.cdp.platform.shared.models.VersionedTrigger;
import com.cdp.platform.shared.models.db.Campaign;
import com.cdp.platform.shared.models.db.CampaignNode;
import com.cdp.platform.shared.models.db.MetricConfig;

/**
 * The operators of customer decision in job order: the metric update and rule
 * decisions with keyed state in RocksDB, the profile lookup, and the operator
 * that releases each person's triggers in order. Each record between two
 * operators goes through its serializer, as on the network. A
 * {@code user_metrics} read runs on the behavior operator's pool and returns
 * through its mailbox, as in the job.
 */
final class DecisionPipeline implements AutoCloseable {

    static final MapStateDescriptor<String, MetricConfig> DEFINITIONS = new MapStateDescriptor<>(
        "metric-config-broadcast-state", String.class, MetricConfig.class);
    static final MapStateDescriptor<String, Campaign> CAMPAIGNS = new MapStateDescriptor<>("campaigns",
        String.class, Campaign.class);
    static final MapStateDescriptor<String, CampaignNode> NODES = new MapStateDescriptor<>("campaign-nodes",
        String.class, CampaignNode.class);
    private static final Duration READ_DEADLINE = Duration.ofSeconds(5);
    private static final TypeInformation<Either<Event, SegmentCheck>> INPUT = TypeInformation
        .of(new TypeHint<Either<Event, SegmentCheck>>() {
        });

    private final CustomerBehaviorOperator operator;
    private final KeyedBroadcastOperatorTestHarness<String, Either<Event, SegmentCheck>, Either<Either<MetricConfig, Row>, Either<Row, Row>>, Decision> behavior;
    private final KeyedOneInputStreamOperatorTestHarness<String, Decision, VersionedTrigger> order;
    private final ProfileLookupFunction lookup;
    private final List<Decision> heldLookups = new ArrayList<>();
    private final List<Decision> lookedUp = new ArrayList<>();
    private boolean holdLookups;

    /**
     * Reads stored series through the repository, or reads nothing when it is
     * null. Looks profiles up in the store.
     */
    DecisionPipeline(UserMetricRepository storedMetrics, ProfileLookupFunction.ProfileStore profiles)
        throws Exception {
        operator = new CustomerBehaviorOperator(new WithRepository(storedMetrics), DEFINITIONS, CAMPAIGNS, NODES);
        behavior = new KeyedBroadcastOperatorTestHarness<>(operator, CustomerBehaviorProcessFunction::canonIdOf,
            Types.STRING, 128, 1, 0);
        behavior.setStateBackend(new EmbeddedRocksDBStateBackend());
        behavior.open();
        order = ProcessFunctionTestHarnesses
            .forKeyedProcessFunction(new DecisionOrderFunction(31),
                decision -> decision.event().canonId(), Types.STRING);
        lookup = new ProfileLookupFunction(() -> profiles);
        lookup.open(DefaultOpenContext.INSTANCE);
    }

    void definition(MetricConfig definition) throws Exception {
        behavior.processBroadcastElement(Either.Left(Either.Left(definition)), 0L);
    }

    /** Applies a {@code segments} row, as the segments source sends it. */
    void segment(Row row) throws Exception {
        behavior.processBroadcastElement(Either.Left(Either.Right(row)), 0L);
    }

    void rules(Either<Row, Row> update) throws Exception {
        behavior.processBroadcastElement(Either.Right(update), 0L);
    }

    /**
     * Runs the input through every operator and returns the triggers that left
     * because of it, in the order they left.
     */
    List<VersionedTrigger> process(Either<Event, SegmentCheck> input, long timestamp) throws Exception {
        order.getOutput().clear();
        behavior.processElement(throughNetwork(input, INPUT), timestamp);
        awaitReads();

        List<Decision> decided = new ArrayList<>();
        for (StreamRecord<Decision> record : drain(behavior.getOutput())) {
            decided.add(record.getValue());
        }
        var needsProfile = behavior.getSideOutput(CustomerBehaviorProcessFunction.NEEDS_PROFILE);
        List<Decision> waiting = new ArrayList<>();
        if (needsProfile != null) {
            needsProfile.forEach(record -> waiting.add(record.getValue()));
            needsProfile.clear();
        }
        if (holdLookups) {
            heldLookups.addAll(waiting);
        } else {
            decided.addAll(lookUp(waiting));
        }
        for (Decision decision : decided) {
            order.processElement(throughNetwork(decision, Decision.class), 0L);
        }
        return order.extractOutputValues();
    }

    List<VersionedTrigger> process(Event event) throws Exception {
        return process(Either.Left(event), event.eventTimestamp());
    }

    /** Holds the profile lookups that later inputs start, until released. */
    void holdLookups() {
        holdLookups = true;
    }

    /**
     * Completes the held lookups and returns the triggers that left because of
     * them, in the order they left.
     */
    List<VersionedTrigger> releaseLookups() throws Exception {
        holdLookups = false;
        order.getOutput().clear();
        List<Decision> found = lookUp(heldLookups);
        heldLookups.clear();
        for (Decision decision : found) {
            order.processElement(throughNetwork(decision, Decision.class), 0L);
        }
        return order.extractOutputValues();
    }

    /** The decisions that wait for a profile, as the lookup receives them. */
    List<Decision> heldLookups() {
        return List.copyOf(heldLookups);
    }

    List<CustomerProfileMutationEvent> mutations() {
        var emitted = behavior.getSideOutput(CustomerBehaviorProcessFunction.MUTATIONS);
        return emitted == null ? List.of() : emitted.stream().map(StreamRecord::getValue).toList();
    }

    @Override
    public void close() throws Exception {
        lookup.close();
        order.close();
        behavior.close();
    }

    private List<Decision> lookUp(Collection<Decision> waiting) throws Exception {
        lookedUp.clear();
        for (Decision decision : waiting) {
            lookup.asyncInvoke(throughNetwork(decision, Decision.class), new Collecting());
        }
        return List.copyOf(lookedUp);
    }

    /** Runs the behavior operator's mail until no person waits for a read. */
    private void awaitReads() throws Exception {
        long deadline = System.nanoTime() + READ_DEADLINE.toNanos();
        while (operator.holdsInputs()) {
            Optional<Mail> mail = behavior.getTaskMailbox().tryTake(TaskMailbox.MIN_PRIORITY);
            if (mail.isPresent()) {
                mail.get().run();
            } else if (System.nanoTime() > deadline) {
                throw new IllegalStateException("A user_metrics read did not return");
            } else {
                Thread.onSpinWait();
            }
        }
    }

    @SuppressWarnings("unchecked")
    private static List<StreamRecord<Decision>> drain(Collection<Object> output) {
        List<StreamRecord<Decision>> records = new ArrayList<>();
        output.removeIf(element -> {
            if (!(element instanceof StreamRecord<?> record)) return false;
            records.add((StreamRecord<Decision>) record);
            return true;
        });
        return records;
    }

    static <T> T throughNetwork(T value, Class<T> type) throws Exception {
        return throughNetwork(value, TypeInformation.of(type));
    }

    static <T> T throughNetwork(T value, TypeInformation<T> type) throws Exception {
        TypeSerializer<T> serializer = type.createSerializer(new SerializerConfigImpl());
        DataOutputSerializer output = new DataOutputSerializer(256);
        serializer.serialize(value, output);
        return serializer.deserialize(new DataInputDeserializer(output.getSharedBuffer(), 0, output.length()));
    }

    /** Collects what the lookup completes with. */
    private final class Collecting implements ResultFuture<Decision> {

        @Override
        public void complete(Collection<Decision> results) {
            lookedUp.addAll(results);
        }

        @Override
        public void complete(CollectionSupplier<Decision> results) {
            try {
                complete(results.get());
            } catch (Exception exception) {
                throw new IllegalStateException(exception);
            }
        }

        @Override
        public void completeExceptionally(Throwable error) {
            throw new IllegalStateException("The profile lookup never fails a decision", error);
        }
    }

    /** Reads stored rows through the given repository, or none without one. */
    private static final class WithRepository extends CustomerBehaviorProcessFunction {

        private static final long serialVersionUID = 1L;
        private final transient UserMetricRepository repository;

        WithRepository(UserMetricRepository repository) {
            super(UnreachableDatabase.CONFIG, DEFINITIONS, CAMPAIGNS, NODES, 31, 600_000L, 128, 4_096, 32_768);
            this.repository = repository;
        }

        @Override
        UserMetricRepository openMetricRepository() {
            return repository;
        }
    }
}
