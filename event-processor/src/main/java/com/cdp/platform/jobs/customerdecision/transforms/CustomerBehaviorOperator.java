package com.cdp.platform.jobs.customerdecision.transforms;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import org.apache.flink.api.common.operators.MailboxExecutor;
import org.apache.flink.api.common.state.ListState;
import org.apache.flink.api.common.state.ListStateDescriptor;
import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.typeinfo.TypeHint;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.java.tuple.Tuple2;
import org.apache.flink.runtime.state.KeyedStateBackend;
import org.apache.flink.runtime.state.VoidNamespace;
import org.apache.flink.runtime.state.VoidNamespaceSerializer;
import org.apache.flink.streaming.api.operators.co.CoBroadcastWithKeyedOperator;
import org.apache.flink.streaming.api.watermark.Watermark;
import org.apache.flink.streaming.runtime.streamrecord.StreamRecord;
import org.apache.flink.types.Either;
import org.apache.flink.types.Row;
import org.apache.flink.util.concurrent.ExecutorThreadFactory;

import com.cdp.platform.shared.models.Event;
import com.cdp.platform.shared.models.SegmentCheck;
import com.cdp.platform.shared.models.db.Campaign;
import com.cdp.platform.shared.models.db.CampaignNode;
import com.cdp.platform.shared.models.db.MetricConfig;

/**
 * Runs {@link CustomerBehaviorProcessFunction}, and reads {@code user_metrics}
 * on a state miss without holding up the subtask.
 *
 * <p>
 * When an event or a segment check needs rows that the person's state lacks,
 * the operator keeps it in keyed state and reads on a pool of
 * {@link CustomerBehaviorProcessFunction#STATE_MISS_READS} threads. The
 * person's later events and segment checks wait behind it, in order. Everyone
 * else goes on. The read returns through the task's mailbox, so the event and
 * the ones held behind it are processed on the task thread. The watermark stays
 * below the oldest held record. A failed read fails the task, so the job
 * restarts from the last checkpoint and reads again.
 *
 * <p>
 * A read in flight is not checkpointed. The held records are, and after a
 * restore each person with held records reads again.
 */
public class CustomerBehaviorOperator
    extends
        CoBroadcastWithKeyedOperator<String, Either<Event, SegmentCheck>, Either<Either<MetricConfig, Row>, Either<Row, Row>>, Decision> {

    private static final long serialVersionUID = 1L;
    // Stored as the time of a record that has none.
    private static final long NO_TIMESTAMP = Long.MIN_VALUE;
    private static final ListStateDescriptor<Tuple2<Either<Event, SegmentCheck>, Long>> HELD = new ListStateDescriptor<>(
        "state-miss-held-inputs", TypeInformation.of(new TypeHint<Tuple2<Either<Event, SegmentCheck>, Long>>() {
        }));

    private final CustomerBehaviorProcessFunction behavior;
    private final MapStateDescriptor<String, MetricConfig> definitions;
    private final MapStateDescriptor<String, Campaign> campaigns;
    private final MapStateDescriptor<String, CampaignNode> nodes;

    private transient MailboxExecutor mailbox;
    private transient ExecutorService reads;
    private transient ListState<Tuple2<Either<Event, SegmentCheck>, Long>> held;
    // The people with held records. Each has one read in flight, or one queued
    // in the mailbox after a restore.
    private transient Set<String> waiting;
    // The times of the held records, with how many hold each.
    private transient TreeMap<Long, Integer> heldTimes;
    private transient long inputWatermark;
    private transient long emittedWatermark;

    public CustomerBehaviorOperator(CustomerBehaviorProcessFunction behavior,
        MapStateDescriptor<String, MetricConfig> definitions, MapStateDescriptor<String, Campaign> campaigns,
        MapStateDescriptor<String, CampaignNode> nodes) {
        super(behavior, List.of(definitions, campaigns, nodes, CustomerBehaviorProcessFunction.SEGMENTS));
        this.behavior = behavior;
        this.definitions = definitions;
        this.campaigns = campaigns;
        this.nodes = nodes;
    }

    @Override
    public void open() throws Exception {
        super.open();
        mailbox = getContainingTask().getMailboxExecutorFactory().createExecutor(getOperatorConfig().getChainIndex());
        reads = Executors
            .newFixedThreadPool(CustomerBehaviorProcessFunction.STATE_MISS_READS,
                new ExecutorThreadFactory("state-miss-reads"));
        held = getPartitionedState(HELD);
        waiting = new HashSet<>();
        heldTimes = new TreeMap<>();
        inputWatermark = Long.MIN_VALUE;
        emittedWatermark = Long.MIN_VALUE;

        List<String> restored = new ArrayList<>();
        KeyedStateBackend<String> keyed = getKeyedStateBackend();
        keyed.applyToAllKeys(VoidNamespace.INSTANCE, VoidNamespaceSerializer.INSTANCE, HELD, (key, inputs) -> {
            restored.add(key);
            for (Tuple2<Either<Event, SegmentCheck>, Long> input : inputs.get()) {
                track(input.f1, 1);
            }
        });
        for (String key : restored) {
            waiting.add(key);
            mailbox.execute(() -> complete(key, null, null), "Resume the held inputs of %s", key);
        }
    }

    @Override
    public void processElement1(StreamRecord<Either<Event, SegmentCheck>> element) throws Exception {
        String key = (String) getCurrentKey();
        if (waiting.contains(key)) {
            held.add(heldInput(element));
            track(timeOf(element), 1);
            return;
        }
        StateMissRead miss = stateMiss(element.getValue());
        if (miss == null) {
            super.processElement1(element);
            return;
        }
        while (waiting.size() >= CustomerBehaviorProcessFunction.STATE_MISS_READS) {
            mailbox.yield();
        }
        // A read that returned while this one waited switched the key.
        setCurrentKey(key);
        held.add(heldInput(element));
        track(timeOf(element), 1);
        startRead(key, miss);
    }

    private void startRead(String key, StateMissRead miss) {
        waiting.add(key);
        CompletableFuture
            .supplyAsync(() -> behavior.read(miss), reads)
            .whenComplete((rows, failure) -> mailbox
                .execute(() -> complete(key, rows, failure), "Apply the state miss read of %s", key));
    }

    /**
     * Processes the person's held records in order, the first with the rows
     * read. Stops at a record that needs rows the read did not return, such as
     * a series of a definition added while it ran, and reads for it.
     */
    private void complete(String key, StateMissRead.Stored rows, Throwable failure) throws Exception {
        waiting.remove(key);
        if (failure != null) {
            Throwable cause = failure instanceof CompletionException ? failure.getCause() : failure;
            if (cause instanceof RuntimeException runtime) throw runtime;
            throw new IllegalStateException("Cannot read the stored metrics of " + key, cause);
        }
        setCurrentKey(key);
        List<Tuple2<Either<Event, SegmentCheck>, Long>> inputs = new ArrayList<>();
        held.get().forEach(inputs::add);
        StateMissRead.Stored unused = rows;
        for (int index = 0; index < inputs.size(); index++) {
            Tuple2<Either<Event, SegmentCheck>, Long> input = inputs.get(index);
            StateMissRead miss = stateMiss(input.f0);
            if (miss != null && (unused == null || !unused.covers(miss))) {
                held.update(inputs.subList(index, inputs.size()));
                startRead(key, miss);
                emitWatermark();
                return;
            }
            behavior.useStored(miss == null ? null : unused);
            try {
                super.processElement1(input.f1 == NO_TIMESTAMP
                    ? new StreamRecord<>(input.f0)
                    : new StreamRecord<>(input.f0, input.f1));
            } finally {
                behavior.useStored(null);
            }
            // The rows answer only the record that waited for them.
            unused = null;
            track(input.f1, -1);
        }
        held.clear();
        emitWatermark();
    }

    private StateMissRead stateMiss(Either<Event, SegmentCheck> input) throws Exception {
        return behavior
            .stateMiss(input, getOperatorStateBackend().getBroadcastState(definitions),
                getOperatorStateBackend().getBroadcastState(nodes),
                getOperatorStateBackend().getBroadcastState(campaigns),
                getOperatorStateBackend().getBroadcastState(CustomerBehaviorProcessFunction.SEGMENTS));
    }

    @Override
    public void processWatermark(Watermark mark) throws Exception {
        inputWatermark = mark.getTimestamp();
        emitWatermark();
    }

    /** Emits the input watermark, held below the oldest held record. */
    private void emitWatermark() throws Exception {
        long watermark = heldTimes.isEmpty() ? inputWatermark : Math.min(inputWatermark, heldTimes.firstKey() - 1);
        if (watermark <= emittedWatermark) return;
        emittedWatermark = watermark;
        super.processWatermark(new Watermark(watermark));
    }

    private void track(long time, int change) {
        if (time == NO_TIMESTAMP) return;
        heldTimes.merge(time, change, (count, delta) -> count + delta == 0 ? null : count + delta);
    }

    /** Whether a person's inputs wait for a read. */
    boolean holdsInputs() {
        return !waiting.isEmpty();
    }

    @Override
    public void finish() throws Exception {
        while (!waiting.isEmpty()) {
            mailbox.yield();
        }
        super.finish();
    }

    @Override
    public void close() throws Exception {
        if (reads != null) reads.shutdownNow();
        super.close();
    }

    private static Tuple2<Either<Event, SegmentCheck>, Long> heldInput(
        StreamRecord<Either<Event, SegmentCheck>> element) {
        return Tuple2.of(element.getValue(), timeOf(element));
    }

    private static long timeOf(StreamRecord<?> element) {
        return element.hasTimestamp() ? element.getTimestamp() : NO_TIMESTAMP;
    }
}
