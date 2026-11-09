package com.cdp.platform.jobs.statemachine;

import java.time.Duration;
import java.util.Properties;

import org.apache.flink.api.common.eventtime.WatermarkGenerator;
import org.apache.flink.api.common.eventtime.WatermarkOutput;
import org.apache.flink.api.common.eventtime.WatermarkStrategy;
import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.configuration.Configuration;
import org.apache.flink.connector.base.DeliveryGuarantee;
import org.apache.flink.connector.kafka.sink.KafkaRecordSerializationSchema;
import org.apache.flink.connector.kafka.sink.KafkaSink;
import org.apache.flink.connector.kafka.source.KafkaSource;
import org.apache.flink.connector.kafka.source.enumerator.initializer.OffsetsInitializer;
import org.apache.flink.streaming.api.datastream.BroadcastStream;
import org.apache.flink.streaming.api.datastream.CustomSinkOperatorUidHashes;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.datastream.SingleOutputStreamOperator;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.table.api.bridge.java.StreamTableEnvironment;
import org.apache.flink.types.Row;

import com.cdp.platform.jobs.statemachine.model.CampaignGraph;
import com.cdp.platform.jobs.statemachine.transforms.JourneyStateMachineFunction;
import com.cdp.platform.jobs.statemachine.transforms.TriggerParser;
import com.cdp.platform.shared.config.DatabaseConfig;
import com.cdp.platform.shared.config.EnvironmentSettings;
import com.cdp.platform.shared.config.KafkaSecurityConfig;
import com.cdp.platform.shared.db.repositories.CampaignNodeRepository;
import com.cdp.platform.shared.db.repositories.UserCampaignStateTransitionRepository;
import com.cdp.platform.shared.models.SegmentCheck;
import com.cdp.platform.shared.models.VersionedTrigger;
import com.cdp.platform.shared.models.db.UserCampaignState;
import com.cdp.platform.shared.models.source.KafkaSourceConfig;
import com.cdp.platform.shared.utils.JsonSerializationSchema;
import com.cdp.platform.shared.utils.KeySerializationSchema;

import org.apache.kafka.clients.consumer.OffsetResetStrategy;

/**
 * Event-time journey state machine: Kafka matches -> keyed BFS state ->
 * PostgreSQL projection.
 */
public final class StateMachineJob {

    private static final String JOB_NAME = "campaign-state-machine-job";
    private static final String JOURNEY_TRIGGER_SOURCE = "state_machine_journey_triggers";
    private static final String JOURNEY_TRIGGER_SOURCE_UID = "journey-trigger-source";
    private static final String CAMPAIGN_NODE_TABLE = "state_machine_campaign_nodes_cdc";
    private static final String CAMPAIGN_NODE_SLOT = "flink_state_machine_nodes_slot";
    private static final String JOURNEY_STATE_MACHINE_UID = "journey-state-machine";
    private static final String SEGMENT_CHECK_SINK_UID = "segment-check-sink";
    private static final String TRANSITION_SINK_UID = "transition-sink";

    private StateMachineJob() {
    }

    public static void main(String[] args) throws Exception {
        buildPipeline(DatabaseConfig.fromEnvironment(), new Configuration()).execute(JOB_NAME);
    }

    /**
     * Builds the job graph without connecting to Kafka or Postgres. The settings
     * apply to the job on top of the cluster's configuration.
     */
    static StreamExecutionEnvironment buildPipeline(DatabaseConfig databaseConfig, Configuration settings) {
        EnvironmentSettings env = EnvironmentSettings.system();
        KafkaSecurityConfig kafkaSecurity = KafkaSecurityConfig.fromEnvironment("STATE_MACHINE_");
        KafkaSourceConfig triggerSource = KafkaSourceConfig
            .of(env.kafkaBrokers("STATE_MACHINE_"),
                env.string("STATE_MACHINE_GROUP_ID", env.string("KAFKA_GROUP_ID", "campaign-state-machine-group")),
                env.journeyTriggerTopic(), kafkaSecurity);
        String segmentCheckTopic = env.string("KAFKA_SEGMENT_CHECK_TOPIC", "journey-engine-segment-checks");

        long maxOutOfOrderness = env.positiveLong("STATE_MACHINE_MAX_OUT_OF_ORDERNESS_MS", 600_000L);
        long idleTimeout = env.positiveLong("STATE_MACHINE_SOURCE_IDLE_TIMEOUT_MS", 60_000L);
        int maxMatches = env.positiveInt("STATE_MACHINE_MAX_PENDING_MATCHES_PER_JOURNEY", 1000);
        long maxBytes = env.positiveLong("STATE_MACHINE_MAX_PENDING_BYTES_PER_JOURNEY", 4_194_304L);
        long ttl = env.positiveLong("STATE_MACHINE_JOURNEY_STATE_TTL_MS", 7_776_000_000L);
        long graphLoadAllowance = env.positiveLong("STATE_MACHINE_GRAPH_LOAD_ALLOWANCE_MS", 300_000L);
        String checkpointInterval = env.string("CHECKPOINT_INTERVAL", "30s");

        StreamExecutionEnvironment environment = StreamExecutionEnvironment.getExecutionEnvironment(settings);
        StreamTableEnvironment tableEnvironment = StreamTableEnvironment.create(environment);
        configureCheckpointing(tableEnvironment, checkpointInterval, env.string("CHECKPOINT_MIN_PAUSE", "10s"));

        KafkaSource<VersionedTrigger> triggerKafkaSource = KafkaSource
            .<VersionedTrigger>builder()
            .setBootstrapServers(triggerSource.brokers())
            .setTopics(triggerSource.topics())
            .setGroupId(triggerSource.groupId())
            .setStartingOffsets(OffsetsInitializer.committedOffsets(OffsetResetStrategy.EARLIEST))
            .setValueOnlyDeserializer(new TriggerParser())
            .setProperties(triggerSource.toProperties())
            .build();
        // The id Flink generated for the trigger table's source, so the offsets
        // restore from a savepoint taken while the topic was read as a table.
        DataStream<VersionedTrigger> journeyTriggers = environment
            .fromSource(triggerKafkaSource, triggerWatermarks(maxOutOfOrderness, idleTimeout), JOURNEY_TRIGGER_SOURCE)
            .uid(JOURNEY_TRIGGER_SOURCE_UID)
            .setUidHash("cbc357ccb763df2852fee8c4fc7d55f2");
        DataStream<Row> nodeUpdates = CampaignNodeRepository
            .graphChangelog(tableEnvironment, databaseConfig, CAMPAIGN_NODE_TABLE, CAMPAIGN_NODE_SLOT);

        SingleOutputStreamOperator<UserCampaignState> transitions = journeyTransitions(journeyTriggers, nodeUpdates,
            maxMatches, maxBytes, ttl, graphLoadAllowance);

        // The transitions sink had no uid, and the segment check sink moved the id
        // Flink generated for its committer. These are the ids from before, so a
        // savepoint taken then restores into this sink.
        UserCampaignStateTransitionRepository
            .attach(transitions, databaseConfig, TRANSITION_SINK_UID, CustomSinkOperatorUidHashes
                .builder()
                .setWriterUidHash("99bf186e8bb5d3054d391ce0ef242107")
                .setCommitterUidHash("43afce22915d2b59ca28b835a428866d")
                .build());
        transitions
            .getSideOutput(JourneyStateMachineFunction.SEGMENT_CHECKS)
            .sinkTo(createSegmentCheckSink(triggerSource.brokers(), segmentCheckTopic, kafkaSecurity))
            .name("Segment Check Sink")
            .uid(SEGMENT_CHECK_SINK_UID);
        return environment;
    }

    static SingleOutputStreamOperator<UserCampaignState> journeyTransitions(
        DataStream<VersionedTrigger> journeyTriggers, DataStream<Row> nodeUpdates, int maxMatches, long maxBytes,
        long ttl, long graphLoadAllowance) {
        MapStateDescriptor<String, CampaignGraph> graphState = new MapStateDescriptor<>("campaign-journey-graphs",
            Types.STRING, TypeInformation.of(CampaignGraph.class));
        BroadcastStream<Row> graphUpdates = nodeUpdates
            .assignTimestampsAndWatermarks(graphUpdateWatermarks())
            .name("Campaign Graph Watermark")
            .broadcast(graphState, JourneyStateMachineFunction.GRAPH_LOADS);

        return journeyTriggers
            .keyBy(VersionedTrigger::journeyKey)
            .connect(graphUpdates)
            .process(new JourneyStateMachineFunction(graphState, maxMatches, maxBytes, ttl, graphLoadAllowance))
            .returns(TypeInformation.of(UserCampaignState.class))
            .name("Immediate Keyed Journey BFS")
            .uid(JOURNEY_STATE_MACHINE_UID);
    }

    /**
     * Customer decision keeps a person's metrics keyed by {@code canon_id}, so a
     * check is keyed by it too.
     */
    private static KafkaSink<SegmentCheck> createSegmentCheckSink(String brokers, String topic,
        KafkaSecurityConfig security) {
        Properties properties = security.clientProperties();
        KafkaRecordSerializationSchema<SegmentCheck> serializer = KafkaRecordSerializationSchema
            .<SegmentCheck>builder()
            .setTopic(topic)
            .setKeySerializationSchema(new KeySerializationSchema<>(SegmentCheck.class, SegmentCheck::canonId))
            .setValueSerializationSchema(new JsonSerializationSchema<>(SegmentCheck.class))
            .build();

        return KafkaSink
            .<SegmentCheck>builder()
            .setBootstrapServers(brokers)
            .setKafkaProducerConfig(properties)
            .setRecordSerializer(serializer)
            .setDeliveryGuarantee(DeliveryGuarantee.AT_LEAST_ONCE)
            .build();
    }

    static WatermarkStrategy<Row> graphUpdateWatermarks() {
        return WatermarkStrategy.forGenerator(context -> new GraphUpdateWatermarks());
    }

    /**
     * Node rows have no event time, and the CDC source emits no watermark. The
     * graph input is marked idle, so Flink leaves it out of the state machine's
     * watermark and the trigger watermark alone drives the late check and the
     * buffer timers. It must never emit a watermark: when the trigger input is
     * idle too, Flink takes the largest watermark of all inputs.
     */
    private static final class GraphUpdateWatermarks implements WatermarkGenerator<Row> {
        @Override
        public void onEvent(Row update, long eventTimestamp, WatermarkOutput output) {
        }

        @Override
        public void onPeriodicEmit(WatermarkOutput output) {
            output.markIdle();
        }
    }

    private static void configureCheckpointing(StreamTableEnvironment tableEnvironment, String checkpointInterval,
        String minPause) {
        var flinkConfig = tableEnvironment.getConfig().getConfiguration();
        flinkConfig.setString("execution.checkpointing.interval", checkpointInterval);
        flinkConfig.setString("execution.checkpointing.min-pause", minPause);
        flinkConfig.setString("execution.checkpointing.max-concurrent-checkpoints", "1");
    }

    /**
     * The watermark of each trigger partition is its latest event time less the
     * allowed out-of-orderness in whole seconds, at least one second, as the SQL
     * watermark of the trigger table was. The bounded out-of-orderness strategy
     * takes 1 ms more off, so the bound is 1 ms less. A partition with no trigger
     * for the idle timeout stops holding the watermark back.
     */
    static WatermarkStrategy<VersionedTrigger> triggerWatermarks(long maxOutOfOrdernessMs, long idleTimeoutMs) {
        long outOfOrdernessMs = Math.max(1, maxOutOfOrdernessMs / 1000) * 1000;
        return WatermarkStrategy
            .<VersionedTrigger>forBoundedOutOfOrderness(Duration.ofMillis(outOfOrdernessMs - 1))
            .withTimestampAssigner((trigger, kafkaTimestamp) -> trigger.eventTimestamp())
            .withIdleness(Duration.ofMillis(idleTimeoutMs));
    }
}
