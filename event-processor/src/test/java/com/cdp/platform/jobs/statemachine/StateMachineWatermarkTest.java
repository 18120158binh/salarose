package com.cdp.platform.jobs.statemachine;

import java.util.List;
import java.util.Queue;

import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.streaming.api.watermark.Watermark;
import org.apache.flink.streaming.runtime.operators.TimestampsAndWatermarksOperatorFactory;
import org.apache.flink.streaming.runtime.streamrecord.StreamRecord;
import org.apache.flink.streaming.runtime.watermarkstatus.WatermarkStatus;
import org.apache.flink.streaming.util.KeyedBroadcastOperatorTestHarness;
import org.apache.flink.streaming.util.OneInputStreamOperatorTestHarness;
import org.apache.flink.streaming.util.ProcessFunctionTestHarnesses;
import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;

import com.cdp.platform.jobs.statemachine.model.CampaignGraph;
import com.cdp.platform.jobs.statemachine.transforms.JourneyStateMachineFunction;
import com.cdp.platform.shared.models.JourneyTriggerEvent;
import com.cdp.platform.shared.models.VersionedTrigger;
import com.cdp.platform.shared.models.db.UserCampaignState;

import static org.junit.jupiter.api.Assertions.assertAll;
import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * The campaign graph stream runs through the job's watermark operator into the
 * state machine, as in the job graph. The trigger input goes idle the way the
 * Kafka source does after the idle timeout.
 */
class StateMachineWatermarkTest {

    private static final long T_10_00 = 1_760_346_000_000L;
    private static final long MINUTE = 60_000L;
    private static final long WATERMARK_INTERVAL_MS = 200L;
    private static final String[] NODE_COLUMNS = {"campaign_id", "node_id", "node_type", "parent_node_id",
        "parent_branch", "trigger_json", "conditions_json", "action_json", "goal_id", "paths_json",
        "campaign_node_count", "graph_version"};
    private static final TypeInformation<Row> NODE_ROW = Types
        .ROW_NAMED(NODE_COLUMNS, Types.STRING, Types.STRING, Types.STRING, Types.STRING, Types.STRING, Types.STRING,
            Types.STRING, Types.STRING, Types.STRING, Types.STRING, Types.INT, Types.LONG);
    private static final MapStateDescriptor<String, CampaignGraph> GRAPHS = new MapStateDescriptor<>(
        "campaign-journey-graphs", Types.STRING, TypeInformation.of(CampaignGraph.class));

    private OneInputStreamOperatorTestHarness<Row, Row> graphWatermarks;
    private KeyedBroadcastOperatorTestHarness<String, VersionedTrigger, Row, UserCampaignState> stateMachine;

    @BeforeEach
    void loadTheGraphWithTheTriggerWatermarkAt0955() throws Exception {
        graphWatermarks = new OneInputStreamOperatorTestHarness<>(
            new TimestampsAndWatermarksOperatorFactory<>(StateMachineJob.graphUpdateWatermarks(), true));
        graphWatermarks.getExecutionConfig().setAutoWatermarkInterval(WATERMARK_INTERVAL_MS);
        graphWatermarks.setup(NODE_ROW.createSerializer(graphWatermarks.getExecutionConfig().getSerializerConfig()));
        graphWatermarks.open();
        stateMachine = ProcessFunctionTestHarnesses
            .forKeyedBroadcastProcessFunction(new JourneyStateMachineFunction(GRAPHS, 1000, 4_194_304L,
                7_776_000_000L, 300_000L), VersionedTrigger::journeyKey, Types.STRING, GRAPHS,
                JourneyStateMachineFunction.GRAPH_LOADS);

        graphWatermarks.processElement(row("n1_view", "setup", null, null), 0L);
        graphWatermarks.processElement(row("n2_vip", "check", "n1_view", "next"), 0L);
        graphWatermarks.setProcessingTime(WATERMARK_INTERVAL_MS);
        pipeGraphStream();
        stateMachine.processWatermark(new Watermark(T_10_00 - 5 * MINUTE));
    }

    @AfterEach
    void close() throws Exception {
        stateMachine.close();
        graphWatermarks.close();
    }

    @Test
    void whenBothInputsAreIdleTheWatermarkHoldsAndNothingIsDropped() throws Exception {
        apply(trigger("canon-1", "n2_vip", "yes", T_10_00 + MINUTE));

        triggerInput(WatermarkStatus.IDLE);
        graphWatermarks.setProcessingTime(2 * WATERMARK_INTERVAL_MS);
        pipeGraphStream();

        assertAll(() -> assertEquals(T_10_00 - 5 * MINUTE, operatorWatermark()),
            () -> assertEquals(List.of(), unreachable()));
    }

    @Test
    void anHourLaterTheTriggerWatermarkAloneReleasesTheBuffer() throws Exception {
        JourneyTriggerEvent waiting = trigger("canon-1", "n2_vip", "yes", T_10_00 + MINUTE);
        apply(waiting);
        triggerInput(WatermarkStatus.IDLE);

        triggerInput(WatermarkStatus.ACTIVE);
        apply(trigger("canon-2", "n1_view", "next", T_10_00 + 60 * MINUTE));
        stateMachine.processWatermark(new Watermark(T_10_00 + 50 * MINUTE));

        assertEquals(List.of(), late());
        assertEquals(List.of("canon-2/n1_view/next"), transitions());
        assertEquals(List.of(waiting), unreachable());
        assertEquals(T_10_00 + 50 * MINUTE, operatorWatermark());
    }

    @Test
    void theTriggerWatermarkReleasesABufferedTriggerWhileTheGraphInputIsIdle() throws Exception {
        JourneyTriggerEvent waiting = trigger("canon-1", "n2_vip", "yes", T_10_00 + MINUTE);
        apply(waiting);
        apply(trigger("canon-2", "n1_view", "next", T_10_00 + 2 * MINUTE));

        stateMachine.processWatermark(new Watermark(T_10_00 + MINUTE));

        assertEquals(List.of("canon-2/n1_view/next"), transitions());
        assertEquals(List.of(waiting), unreachable());
        assertEquals(T_10_00 + MINUTE, operatorWatermark());
    }

    /**
     * The trigger watermark is the latest event time read, less the allowed
     * out-of-orderness in whole seconds and at least one second, as the trigger
     * table's SQL watermark was.
     */
    @Test
    void theTriggerWatermarkTrailsTheLatestEventTimeByTheOutOfOrdernessInWholeSeconds() throws Exception {
        assertAll(
            () -> assertEquals(T_10_00 + MINUTE - 10 * MINUTE,
                triggerWatermark(10 * MINUTE, T_10_00 + MINUTE, T_10_00)),
            () -> assertEquals(T_10_00 - 1_000L, triggerWatermark(1_500L, T_10_00, T_10_00 - MINUTE)),
            () -> assertEquals(T_10_00 - 1_000L, triggerWatermark(10L, T_10_00)));
    }

    private static long triggerWatermark(long maxOutOfOrdernessMs, long... eventTimes) throws Exception {
        try (
            OneInputStreamOperatorTestHarness<VersionedTrigger, VersionedTrigger> triggerWatermarks = new OneInputStreamOperatorTestHarness<>(
                new TimestampsAndWatermarksOperatorFactory<>(
                    StateMachineJob.triggerWatermarks(maxOutOfOrdernessMs, 60_000L), true))) {
            triggerWatermarks.getExecutionConfig().setAutoWatermarkInterval(WATERMARK_INTERVAL_MS);
            triggerWatermarks
                .setup(TypeInformation
                    .of(VersionedTrigger.class)
                    .createSerializer(triggerWatermarks.getExecutionConfig().getSerializerConfig()));
            triggerWatermarks.open();
            for (long eventTime : eventTimes) {
                triggerWatermarks
                    .processElement(new VersionedTrigger(trigger("canon-1", "n1_view", "next", eventTime), null), 0L);
            }
            triggerWatermarks.setProcessingTime(WATERMARK_INTERVAL_MS);
            return triggerWatermarks
                .getOutput()
                .stream()
                .filter(Watermark.class::isInstance)
                .mapToLong(element -> ((Watermark) element).getTimestamp())
                .max()
                .orElse(Long.MIN_VALUE);
        }
    }

    /**
     * Forwards what the graph watermark operator emitted to the state machine's
     * graph input.
     */
    @SuppressWarnings("unchecked")
    private void pipeGraphStream() throws Exception {
        Object element;
        while ((element = graphWatermarks.getOutput().poll()) != null) {
            if (element instanceof StreamRecord<?> record) {
                stateMachine.processBroadcastElement((StreamRecord<Row>) record);
            } else if (element instanceof Watermark watermark) {
                stateMachine.processBroadcastWatermark(watermark);
            } else if (element instanceof WatermarkStatus status) {
                stateMachine.getTwoInputOperator().processWatermarkStatus2(status);
            }
        }
    }

    private void triggerInput(WatermarkStatus status) throws Exception {
        stateMachine.getTwoInputOperator().processWatermarkStatus1(status);
    }

    private void apply(JourneyTriggerEvent trigger) throws Exception {
        stateMachine.processElement(new VersionedTrigger(trigger, null), trigger.eventTimestamp());
    }

    private long operatorWatermark() {
        return stateMachine
            .getOutput()
            .stream()
            .filter(Watermark.class::isInstance)
            .mapToLong(element -> ((Watermark) element).getTimestamp())
            .max()
            .orElse(Long.MIN_VALUE);
    }

    private List<String> transitions() {
        return stateMachine
            .extractOutputValues()
            .stream()
            .map(state -> state.canonId() + "/" + state.nodeId() + "/" + state.branch())
            .toList();
    }

    private List<JourneyTriggerEvent> unreachable() {
        return sideOutput(stateMachine.getSideOutput(JourneyStateMachineFunction.UNREACHABLE_EVENTS));
    }

    private List<JourneyTriggerEvent> late() {
        return sideOutput(stateMachine.getSideOutput(JourneyStateMachineFunction.LATE_EVENTS));
    }

    private static List<JourneyTriggerEvent> sideOutput(Queue<StreamRecord<JourneyTriggerEvent>> records) {
        return records == null ? List.of() : records.stream().map(StreamRecord::getValue).toList();
    }

    private static JourneyTriggerEvent trigger(String canonId, String nodeId, String branch, long eventTimestamp) {
        return new JourneyTriggerEvent(canonId, "domain-1", null, "user-1", "campaign-1", nodeId, branch, "event",
            eventTimestamp, "{}");
    }

    private static Row row(String nodeId, String nodeType, String parentNodeId, String parentBranch) {
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
}
