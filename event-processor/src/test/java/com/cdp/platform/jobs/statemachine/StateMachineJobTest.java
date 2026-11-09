package com.cdp.platform.jobs.statemachine;

import java.time.Duration;
import java.util.List;

import org.apache.flink.api.common.eventtime.WatermarkStrategy;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.streaming.api.functions.source.legacy.SourceFunction;
import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;
import org.apache.flink.util.CloseableIterator;
import org.apache.flink.util.function.SerializableSupplier;

import com.cdp.platform.jobs.statemachine.transforms.JourneyStateMachineFunction;
import com.cdp.platform.shared.models.JourneyTriggerEvent;
import com.cdp.platform.shared.models.VersionedTrigger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;

import org.junit.jupiter.api.Test;

/**
 * Runs the state machine's wiring on a local cluster. Both inputs stay open,
 * like the Kafka trigger topic and the {@code campaign_nodes} CDC stream, and
 * the node stream emits no watermark, like the CDC table.
 */
class StateMachineJobTest {

    private static final long T_10_00 = 1_760_346_000_000L;
    private static final long MINUTE = 60_000L;
    private static final String[] NODE_COLUMNS = {"campaign_id", "node_id", "node_type", "parent_node_id",
        "parent_branch", "trigger_json", "conditions_json", "action_json", "goal_id", "paths_json",
        "campaign_node_count", "graph_version"};

    @Test
    void theTriggerWatermarkReleasesABufferedTriggerWhileTheGraphStreamStaysOpen() throws Exception {
        StreamExecutionEnvironment environment = StreamExecutionEnvironment.getExecutionEnvironment();
        environment.setParallelism(1);

        DataStream<VersionedTrigger> triggers = environment
            .addSource(new OpenSource<>(StateMachineJobTest::triggers), TypeInformation.of(VersionedTrigger.class))
            .assignTimestampsAndWatermarks(WatermarkStrategy
                .<VersionedTrigger>forBoundedOutOfOrderness(Duration.ofMinutes(10))
                .withTimestampAssigner((trigger, recordTimestamp) -> trigger.eventTimestamp()));
        DataStream<Row> nodeUpdates = environment
            .addSource(new OpenSource<>(StateMachineJobTest::nodeRows),
                Types
                    .ROW_NAMED(NODE_COLUMNS, Types.STRING, Types.STRING, Types.STRING, Types.STRING, Types.STRING,
                        Types.STRING, Types.STRING, Types.STRING, Types.STRING, Types.STRING, Types.INT, Types.LONG));

        DataStream<JourneyTriggerEvent> unreachable = StateMachineJob
            .journeyTransitions(triggers, nodeUpdates, 1000, 4_194_304L, 7_776_000_000L, 300_000L)
            .getSideOutput(JourneyStateMachineFunction.UNREACHABLE_EVENTS);

        try (CloseableIterator<JourneyTriggerEvent> dropped = unreachable.executeAndCollect()) {
            JourneyTriggerEvent first = assertTimeoutPreemptively(Duration.ofSeconds(20), dropped::next,
                "the buffered trigger was never released, although the trigger watermark passed it");
            assertEquals("canon-1/n2_vip", first.canonId() + "/" + first.nodeId());
        }
    }

    /**
     * The parent of canon-1's {@code n2_vip} never completes, so its trigger is
     * buffered. Another person's trigger 29 minutes later moves the trigger
     * watermark past it.
     */
    private static List<VersionedTrigger> triggers() {
        return List
            .of(trigger("canon-1", "campaign-1", "n2_vip", "next", T_10_00 + MINUTE),
                trigger("canon-2", "campaign-1", "n1_view", "next", T_10_00 + 30 * MINUTE));
    }

    /**
     * The graph arrives one row at a time, parent first as studio saves it, and
     * canon-1's trigger can reach the state machine before, between, or after
     * the rows. In each case it waits for {@code n2_vip}, then for the
     * watermark.
     */
    private static List<Row> nodeRows() {
        return List.of(nodeRow("n1_view", "setup", null, null), nodeRow("n2_vip", "check", "n1_view", "next"));
    }

    private static VersionedTrigger trigger(String canonId, String campaignId, String nodeId, String branch,
        long eventTimestamp) {
        return new VersionedTrigger(new JourneyTriggerEvent(canonId, "domain-1", null, "user-1", campaignId, nodeId,
            branch, "event", eventTimestamp, "{}"), 1L);
    }

    private static Row nodeRow(String nodeId, String nodeType, String parentNodeId, String parentBranch) {
        Row row = Row.withNames(RowKind.INSERT);
        for (String column : NODE_COLUMNS) {
            row.setField(column, null);
        }
        row.setField("campaign_id", "campaign-1");
        row.setField("node_id", nodeId);
        row.setField("node_type", nodeType);
        row.setField("parent_node_id", parentNodeId);
        row.setField("parent_branch", parentBranch);
        row.setField("campaign_node_count", 2);
        row.setField("graph_version", 1L);
        return row;
    }

    /** Emits its elements, then stays open without a watermark until cancelled. */
    private static final class OpenSource<T> implements SourceFunction<T> {
        private final SerializableSupplier<List<T>> elements;
        private volatile boolean running = true;

        private OpenSource(SerializableSupplier<List<T>> elements) {
            this.elements = elements;
        }

        @Override
        public void run(SourceContext<T> context) throws Exception {
            for (T element : elements.get()) {
                context.collect(element);
            }
            while (running) {
                Thread.sleep(50);
            }
        }

        @Override
        public void cancel() {
            running = false;
        }
    }
}
