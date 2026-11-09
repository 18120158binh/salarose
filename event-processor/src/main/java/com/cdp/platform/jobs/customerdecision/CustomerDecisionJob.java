package com.cdp.platform.jobs.customerdecision;

import java.util.Properties;
import java.util.concurrent.TimeUnit;

import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.typeinfo.TypeHint;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.configuration.Configuration;
import org.apache.flink.configuration.StateBackendOptions;
import org.apache.flink.connector.base.DeliveryGuarantee;
import org.apache.flink.connector.kafka.sink.KafkaRecordSerializationSchema;
import org.apache.flink.connector.kafka.sink.KafkaSink;
import org.apache.flink.streaming.api.datastream.AsyncDataStream;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.datastream.SingleOutputStreamOperator;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.table.api.Schema;
import org.apache.flink.table.api.TableDescriptor;
import org.apache.flink.table.api.bridge.java.StreamTableEnvironment;
import org.apache.flink.types.Either;
import org.apache.flink.types.Row;
import org.apache.flink.util.Collector;

import com.cdp.platform.jobs.customerdecision.transforms.CustomerBehaviorOperator;
import com.cdp.platform.jobs.customerdecision.transforms.CustomerBehaviorProcessFunction;
import com.cdp.platform.jobs.customerdecision.transforms.Decision;
import com.cdp.platform.jobs.customerdecision.transforms.DecisionOrderFunction;
import com.cdp.platform.jobs.customerdecision.transforms.ProfileLookupFunction;
import com.cdp.platform.shared.config.DatabaseConfig;
import com.cdp.platform.shared.config.KafkaSecurityConfig;
import com.cdp.platform.shared.db.repositories.CampaignNodeRepository;
import com.cdp.platform.shared.db.repositories.CampaignRepository;
import com.cdp.platform.shared.db.repositories.SegmentRepository;
import com.cdp.platform.shared.db.repositories.UserMetricDefinitionRepository;
import com.cdp.platform.shared.models.CustomerProfileMutationEvent;
import com.cdp.platform.shared.models.Event;
import com.cdp.platform.shared.models.ParsedEvent;
import com.cdp.platform.shared.models.SegmentCheck;
import com.cdp.platform.shared.models.VersionedTrigger;
import com.cdp.platform.shared.models.db.Campaign;
import com.cdp.platform.shared.models.db.CampaignNode;
import com.cdp.platform.shared.models.db.MetricConfig;
import com.cdp.platform.shared.models.source.KafkaSourceConfig;
import com.cdp.platform.shared.utils.JsonSerializationSchema;
import com.cdp.platform.shared.utils.KeySerializationSchema;
import com.cdp.platform.shared.utils.TableSources;

import org.apache.kafka.clients.producer.ProducerConfig;

/**
 * Applies each customer event to behavior state and evaluates journey rules.
 */
public final class CustomerDecisionJob {

    private static final String JOB_NAME = "customer-decision-job";
    /**
     * An event's time: the collector's, else the event's own when ingestion
     * published no collector time. An event with neither has no
     * event_timestamp, so step 1 drops it. It takes time 0, so that it reaches
     * step 1 without failing the job and without moving the watermark.
     */
    static final String ROWTIME = "TO_TIMESTAMP_LTZ(COALESCE(collector_timestamp, event_timestamp, 0), 3)";
    private static final String EVENT_TABLE = "decision_parsed_events";
    private static final String SEGMENT_CHECK_TABLE = "decision_segment_checks";
    private static final String METRIC_DEFINITION_TABLE = "decision_metric_definitions";
    private static final String CAMPAIGN_TABLE = "decision_campaigns";
    private static final String CAMPAIGN_NODE_TABLE = "decision_campaign_nodes";
    private static final String SEGMENT_TABLE = "decision_segments";

    private CustomerDecisionJob() {
    }

    public static void main(String[] args) throws Exception {
        buildPipeline(DatabaseConfig.fromEnvironment(), new Configuration()).execute(JOB_NAME);
    }

    /**
     * Builds the job graph without connecting to Kafka or Postgres. The settings
     * apply to the job on top of the cluster's configuration.
     */
    static StreamExecutionEnvironment buildPipeline(DatabaseConfig databaseConfig, Configuration settings) {
        String kafkaBrokers = System
            .getenv()
            .getOrDefault("CUSTOMER_DECISION_KAFKA_BROKERS",
                System.getenv().getOrDefault("KAFKA_BROKERS", "redpanda:29092"));
        String groupId = System
            .getenv()
            .getOrDefault("CUSTOMER_DECISION_GROUP_ID",
                System.getenv().getOrDefault("KAFKA_GROUP_ID", "customer-decision-events"));
        String parsedTopic = System.getenv().getOrDefault("KAFKA_EVENT_PARSED_TOPIC", "snowplow-parsed");
        String profileTopic = System
            .getenv()
            .getOrDefault("KAFKA_PROFILE_MUTATION_TOPIC", "customer-profile-mutations");
        String matchedEventsTopic = System
            .getenv()
            .getOrDefault("KAFKA_CAMPAIGN_MATCHED_TOPIC", "journey-engine-matched-events");
        String segmentCheckTopic = System
            .getenv()
            .getOrDefault("KAFKA_SEGMENT_CHECK_TOPIC", "journey-engine-segment-checks");

        KafkaSecurityConfig kafkaSecurity = KafkaSecurityConfig.fromEnvironment("CUSTOMER_DECISION_");

        KafkaSourceConfig sourceConfig = KafkaSourceConfig.of(kafkaBrokers, groupId, parsedTopic, kafkaSecurity);

        CustomerDecisionSettings jobSettings = CustomerDecisionSettings.from(System::getenv);

        // Heap state is not allowed for this job. A job setting overrides the
        // cluster's state backend.
        Configuration configuration = new Configuration(settings);
        configuration.set(StateBackendOptions.STATE_BACKEND, "rocksdb");
        StreamExecutionEnvironment environment = StreamExecutionEnvironment.getExecutionEnvironment(configuration);
        StreamTableEnvironment tables = StreamTableEnvironment.create(environment);
        configureCheckpointing(environment, tables, jobSettings.checkpointIntervalMs());

        tables.createTemporaryTable(EVENT_TABLE, parsedEventsTable(sourceConfig));
        DataStream<Event> events = parsedEvents(tables, EVENT_TABLE);
        TableSources.identify(events, "parsed-events-source");
        DataStream<MetricConfig> metricDefinitions = UserMetricDefinitionRepository
            .changelog(tables, databaseConfig, METRIC_DEFINITION_TABLE, "flink_decision_metric_defs_slot");
        TableSources.identify(metricDefinitions, "metric-definitions-source");
        MapStateDescriptor<String, MetricConfig> metricState = new MapStateDescriptor<>(
            "metric-config-broadcast-state", String.class, MetricConfig.class);

        tables
            .createTemporaryTable(SEGMENT_CHECK_TABLE, segmentChecksTable(KafkaSourceConfig
                .of(sourceConfig.brokers(), sourceConfig.groupId(), segmentCheckTopic, sourceConfig.security())));
        DataStream<SegmentCheck> segmentChecks = tables
            .toDataStream(tables.from(SEGMENT_CHECK_TABLE))
            .flatMap((Row row, Collector<SegmentCheck> out) -> SegmentCheck.fromRow(row).ifPresent(out::collect))
            .returns(TypeInformation.of(SegmentCheck.class))
            .name("Validated Segment Checks")
            .uid("validate-segment-checks");
        TableSources.identify(segmentChecks, "segment-checks-source");

        TypeInformation<Either<Event, SegmentCheck>> inputType = TypeInformation
            .of(new TypeHint<Either<Event, SegmentCheck>>() {
            });
        // Each wrap is its own lambda. javac deserializes every use of one method
        // reference in a class with the casts of its first use, so Either::Left
        // here and below would cast a campaign row to an Event.
        DataStream<Either<Event, SegmentCheck>> inputs = events
            .map(event -> Either.<Event, SegmentCheck>Left(event))
            .returns(inputType)
            .uid("event-inputs")
            .union(segmentChecks
                .map(check -> Either.<Event, SegmentCheck>Right(check))
                .returns(inputType)
                .uid("segment-check-inputs"));

        DataStream<Row> campaigns = CampaignRepository
            .changelog(tables, databaseConfig, CAMPAIGN_TABLE, "flink_decision_campaigns_slot");
        DataStream<Row> campaignNodes = CampaignNodeRepository
            .changelog(tables, databaseConfig, CAMPAIGN_NODE_TABLE, "flink_decision_campaign_nodes_slot");
        TableSources.identify(campaigns, "campaigns-source");
        TableSources.identify(campaignNodes, "campaign-nodes-source");

        MapStateDescriptor<String, Campaign> campaignState = new MapStateDescriptor<>("campaigns",
            String.class, Campaign.class);
        MapStateDescriptor<String, CampaignNode> nodeState = new MapStateDescriptor<>("campaign-nodes",
            String.class, CampaignNode.class);
        TypeInformation<Either<Row, Row>> updateType = TypeInformation
            .of(new TypeHint<Either<Row, Row>>() {
            });
        DataStream<Either<Row, Row>> campaignUpdates = campaigns
            .map(campaign -> Either.<Row, Row>Left(campaign))
            .returns(updateType)
            .uid("campaign-updates")
            .setParallelism(1);
        DataStream<Either<Row, Row>> nodeUpdates = campaignNodes
            .map(node -> Either.<Row, Row>Right(node))
            .returns(updateType)
            .uid("campaign-node-updates")
            .setParallelism(1);
        DataStream<Either<Row, Row>> ruleUpdates = campaignUpdates.union(nodeUpdates);

        DataStream<Row> segments = SegmentRepository
            .changelog(tables, databaseConfig, SEGMENT_TABLE, "flink_decision_segments_slot");
        TableSources.identify(segments, "segments-source");

        // The rules, the metric definitions, and the segments reach one operator on
        // one broadcast input. It is the job's only copy of them.
        TypeInformation<Either<Either<MetricConfig, Row>, Either<Row, Row>>> behaviorUpdateType = TypeInformation
            .of(new TypeHint<Either<Either<MetricConfig, Row>, Either<Row, Row>>>() {
            });
        DataStream<Either<Either<MetricConfig, Row>, Either<Row, Row>>> behaviorUpdates = metricDefinitions
            .map(definition -> Either
                .<Either<MetricConfig, Row>, Either<Row, Row>>Left(Either.<MetricConfig, Row>Left(definition)))
            .returns(behaviorUpdateType)
            .uid("metric-definition-updates")
            .setParallelism(1)
            .union(ruleUpdates
                .map(rule -> Either.<Either<MetricConfig, Row>, Either<Row, Row>>Right(rule))
                .returns(behaviorUpdateType)
                .uid("behavior-rule-updates")
                .setParallelism(1))
            .union(segments
                .map(segment -> Either
                    .<Either<MetricConfig, Row>, Either<Row, Row>>Left(Either.<MetricConfig, Row>Right(segment)))
                .returns(behaviorUpdateType)
                .uid("segment-updates")
                .setParallelism(1))
            .broadcast();

        SingleOutputStreamOperator<Decision> decisions = inputs
            .keyBy(CustomerBehaviorProcessFunction::canonIdOf, Types.STRING)
            .connect(behaviorUpdates)
            .transform("Apply Behavior State and Decide Rules", TypeInformation.of(Decision.class),
                new CustomerBehaviorOperator(new CustomerBehaviorProcessFunction(databaseConfig, metricState,
                    campaignState, nodeState,
                    jobSettings.stateRetentionDays(),
                    jobSettings.maxOutOfOrdernessMs(),
                    jobSettings.maxMetricsPerCustomer(),
                    jobSettings.maxStringValueBytes(),
                    jobSettings.maxEventContextBytes()), metricState, campaignState, nodeState))
            .uid("apply-behavior-state");

        DataStream<CustomerProfileMutationEvent> mutationEvents = decisions
            .getSideOutput(CustomerBehaviorProcessFunction.MUTATIONS);

        // The lookup is unordered, so one slow lookup holds up no one else. The
        // keyed operator after it puts each person's decisions back in order.
        DataStream<Decision> withProfiles = AsyncDataStream
            .unorderedWait(
                decisions.getSideOutput(CustomerBehaviorProcessFunction.NEEDS_PROFILE),
                new ProfileLookupFunction(databaseConfig, jobSettings.profileLookup()),
                jobSettings.lookupTimeoutMs(),
                TimeUnit.MILLISECONDS,
                jobSettings.lookupCapacity())
            .name("Async Profile Lookup")
            .uid("profile-field-lookup");

        SingleOutputStreamOperator<VersionedTrigger> triggers = decisions
            .union(withProfiles)
            .keyBy(decision -> decision.event().canonId(), Types.STRING)
            .process(new DecisionOrderFunction(jobSettings.stateRetentionDays()))
            .name("Release Triggers in Order")
            .uid("release-triggers-in-order");

        mutationEvents
            .sinkTo(createProfileMutationSink(sourceConfig.brokers(), profileTopic,
                sourceConfig.security()))
            .uid("profile-mutation-sink");
        triggers
            .sinkTo(createTriggerSink(sourceConfig.brokers(), matchedEventsTopic,
                sourceConfig.security()))
            .uid("trigger-sink");
        return environment;
    }

    /** The parsed-events table as the job reads it from Kafka. */
    static TableDescriptor parsedEventsTable(KafkaSourceConfig sourceConfig) {
        Schema consumerSchema = Schema
            .newBuilder()
            .fromSchema(ParsedEvent.schema())
            .columnByExpression("rowtime", ROWTIME)
            .watermark("rowtime", "rowtime - INTERVAL '10' MINUTE")
            .build();

        // A message that does not parse is skipped, and a field of the wrong type
        // reads as null. The streaming JSON parser emits a null row for a truncated
        // object, which fails the job, so the tree parser decodes instead.
        return sourceConfig
            .createTableDescriptorBuilder(consumerSchema)
            .option("properties.auto.offset.reset", "latest")
            .option("format", "json")
            .option("json.ignore-parse-errors", "true")
            .option("json.decode.json-parser.enabled", "false")
            .build();
    }

    /** The segment check table as the job reads it from Kafka. */
    static TableDescriptor segmentChecksTable(KafkaSourceConfig sourceConfig) {
        // A new consumer group reads the checks from the earliest offset, so the
        // checks sent before this job first reads the topic are not lost. A message
        // that does not parse is skipped. The streaming JSON parser emits a null row
        // for a truncated object, which fails the job, so the tree parser decodes
        // instead.
        return sourceConfig
            .createTableDescriptorBuilder(SegmentCheck.schema())
            .option("properties.auto.offset.reset", "earliest")
            .option("format", "json")
            .option("json.fail-on-missing-field", "false")
            .option("json.ignore-parse-errors", "true")
            .option("json.decode.json-parser.enabled", "false")
            .build();
    }

    /** The events of a parsed-events table, as step 1 receives them. */
    static DataStream<Event> parsedEvents(StreamTableEnvironment tables, String table) {
        // The stream is keyed by canon_id, so a row without one cannot reach
        // step 1. Step 1 drops and counts the other events it cannot accept.
        return tables
            .toDataStream(tables.sqlQuery("""
                SELECT *
                FROM %s
                WHERE canon_id IS NOT NULL
                """.formatted(table)))
            .map(Event::fromRow)
            .returns(TypeInformation.of(Event.class))
            .name("Validated Parsed Customer Events")
            .uid("validate-parsed-events");
    }

    private static KafkaSink<CustomerProfileMutationEvent> createProfileMutationSink(String brokers, String topic,
        KafkaSecurityConfig security) {
        Properties properties = security.clientProperties();
        properties
            .setProperty(ProducerConfig.MAX_REQUEST_SIZE_CONFIG,
                String.valueOf(CustomerProfileMutationEvent.MAX_MESSAGE_BYTES));
        KafkaRecordSerializationSchema<CustomerProfileMutationEvent> serializer = KafkaRecordSerializationSchema
            .<CustomerProfileMutationEvent>builder()
            .setTopic(topic)
            .setKeySerializationSchema(
                new KeySerializationSchema<>(CustomerProfileMutationEvent.class, CustomerProfileMutationEvent::canonId))
            .setValueSerializationSchema(new JsonSerializationSchema<>(CustomerProfileMutationEvent.class))
            .build();

        return KafkaSink
            .<CustomerProfileMutationEvent>builder()
            .setBootstrapServers(brokers)
            .setKafkaProducerConfig(properties)
            .setRecordSerializer(serializer)
            .setDeliveryGuarantee(DeliveryGuarantee.AT_LEAST_ONCE)
            .build();
    }

    private static KafkaSink<VersionedTrigger> createTriggerSink(String brokers, String topic,
        KafkaSecurityConfig security) {
        Properties properties = security.clientProperties();
        KafkaRecordSerializationSchema<VersionedTrigger> serializer = KafkaRecordSerializationSchema
            .<VersionedTrigger>builder()
            .setTopic(topic)
            .setKeySerializationSchema(
                new KeySerializationSchema<>(VersionedTrigger.class, VersionedTrigger::journeyKey))
            .setValueSerializationSchema(new JsonSerializationSchema<>(VersionedTrigger.class))
            .build();

        return KafkaSink
            .<VersionedTrigger>builder()
            .setBootstrapServers(brokers)
            .setKafkaProducerConfig(properties)
            .setRecordSerializer(serializer)
            .setDeliveryGuarantee(DeliveryGuarantee.AT_LEAST_ONCE)
            .build();
    }

    private static void configureCheckpointing(StreamExecutionEnvironment environment, StreamTableEnvironment tables,
        long millis) {
        environment.enableCheckpointing(millis);
        tables.getConfig().getConfiguration().setString("execution.checkpointing.interval", millis + "ms");
        tables.getConfig().getConfiguration().setString("execution.checkpointing.max-concurrent-checkpoints", "1");
        tables.getConfig().getConfiguration().setString("pipeline.name", JOB_NAME);
    }
}
