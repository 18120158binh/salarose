package com.cdp.platform.jobs.businessfanout;

import java.util.Optional;

import org.apache.flink.api.common.eventtime.WatermarkStrategy;
import org.apache.flink.api.common.serialization.SimpleStringSchema;
import org.apache.flink.api.common.typeinfo.TypeHint;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.configuration.Configuration;
import org.apache.flink.configuration.StateBackendOptions;
import org.apache.flink.connector.base.DeliveryGuarantee;
import org.apache.flink.connector.kafka.sink.KafkaRecordSerializationSchema;
import org.apache.flink.connector.kafka.sink.KafkaSink;
import org.apache.flink.connector.kafka.source.KafkaSource;
import org.apache.flink.connector.kafka.source.enumerator.initializer.OffsetsInitializer;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.datastream.SingleOutputStreamOperator;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.table.api.bridge.java.StreamTableEnvironment;
import org.apache.flink.types.Either;
import org.apache.flink.types.Row;
import org.apache.flink.util.Collector;

import com.cdp.platform.shared.config.DatabaseConfig;
import com.cdp.platform.shared.config.EnvironmentSettings;
import com.cdp.platform.shared.config.KafkaSecurityConfig;
import com.cdp.platform.shared.db.repositories.CampaignNodeRepository;
import com.cdp.platform.shared.db.repositories.CampaignRepository;
import com.cdp.platform.shared.models.Event;
import com.cdp.platform.shared.models.SegmentMembershipChange;
import com.cdp.platform.shared.models.source.KafkaSourceConfig;
import com.cdp.platform.shared.utils.JacksonMapper;
import com.cdp.platform.shared.utils.JsonSerializationSchema;
import com.cdp.platform.shared.utils.KeySerializationSchema;
import com.cdp.platform.shared.utils.TableSources;

import com.fasterxml.jackson.databind.JsonNode;
import org.apache.kafka.clients.consumer.OffsetResetStrategy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Turns each business event into one match per person and campaign that it
 * concerns, on {@code business-event-matches}.
 */
public final class BusinessEventFanoutJob {

    private static final Logger LOG = LoggerFactory.getLogger(BusinessEventFanoutJob.class);

    private static final String JOB_NAME = "business-event-fanout-job";
    private static final String PREFIX = "BUSINESS_FANOUT_";
    private static final String CAMPAIGN_TABLE = "fanout_campaigns";
    private static final String CAMPAIGN_NODE_TABLE = "fanout_campaign_nodes";

    private BusinessEventFanoutJob() {
    }

    public static void main(String[] args) throws Exception {
        buildPipeline(DatabaseConfig.fromEnvironment(), new Configuration(), EnvironmentSettings.system())
            .execute(JOB_NAME);
    }

    /** Builds the job graph without connecting to Kafka or Postgres. */
    static StreamExecutionEnvironment buildPipeline(DatabaseConfig database, Configuration settings,
        EnvironmentSettings env) {
        String brokers = env.kafkaBrokers(PREFIX);
        String groupId = env.string(PREFIX + "GROUP_ID", env.string("KAFKA_GROUP_ID", "business-event-fanout"));
        KafkaSecurityConfig security = KafkaSecurityConfig.fromEnvironment(PREFIX);
        String businessTopic = env.string("KAFKA_BUSINESS_EVENT_TOPIC", "business-events");
        String parsedTopic = env.string("KAFKA_EVENT_PARSED_TOPIC", "snowplow-parsed");
        String membershipTopic = env.string("KAFKA_SEGMENT_MEMBERSHIP_TOPIC", "segment-membership-changes");
        String matchTopic = env.string("KAFKA_BUSINESS_EVENT_MATCH_TOPIC", "business-event-matches");

        Configuration configuration = new Configuration(settings);
        configuration.set(StateBackendOptions.STATE_BACKEND, "rocksdb");
        StreamExecutionEnvironment environment = StreamExecutionEnvironment.getExecutionEnvironment(configuration);
        StreamTableEnvironment tables = StreamTableEnvironment.create(environment);
        var checkpointing = tables.getConfig().getConfiguration();
        checkpointing.setString("execution.checkpointing.interval", env.string("CHECKPOINT_INTERVAL", "30s"));
        checkpointing.setString("execution.checkpointing.max-concurrent-checkpoints", "1");
        checkpointing.setString("pipeline.name", JOB_NAME);

        // The API writes business events in transactions, so only committed ones
        // count. A new group starts at the newest event: an old business event is
        // not news, and an old person event must not count as interest (BEF-FR-08).
        DataStream<BusinessEvent> businessEvents = environment
            .fromSource(source(brokers, groupId, businessTopic, security, OffsetResetStrategy.LATEST, true),
                WatermarkStrategy.noWatermarks(), "business-events-source")
            .uid("business-events-source")
            .flatMap((String message, Collector<BusinessEvent> out) -> BusinessEvent
                .parse(message)
                .ifPresent(out::collect))
            .returns(TypeInformation.of(BusinessEvent.class))
            .name("Parse Business Events")
            .uid("parse-business-events")
            .keyBy(BusinessEvent::key, Types.STRING)
            .process(new SeenEventFilter())
            .name("Drop Seen Business Events")
            .uid("drop-seen-business-events");

        DataStream<Event> personEvents = environment
            .fromSource(source(brokers, groupId, parsedTopic, security, OffsetResetStrategy.LATEST, false),
                WatermarkStrategy.noWatermarks(), "parsed-events-source")
            .uid("parsed-events-source")
            .flatMap((String message, Collector<Event> out) -> personEvent(message).ifPresent(out::collect))
            .returns(TypeInformation.of(Event.class))
            .name("Parse Person Events")
            .uid("parse-person-events");

        // A new group reads membership changes from the start of the topic, so the
        // index holds the members the topic still has.
        DataStream<IndexInput> membershipChanges = environment
            .fromSource(source(brokers, groupId, membershipTopic, security, OffsetResetStrategy.EARLIEST, false),
                WatermarkStrategy.noWatermarks(), "segment-membership-source")
            .uid("segment-membership-source")
            .flatMap((String message, Collector<IndexInput> out) -> membershipChange(message)
                .ifPresent(out::collect))
            .returns(TypeInformation.of(IndexInput.class))
            .name("Parse Segment Membership Changes")
            .uid("parse-segment-membership-changes");

        TypeInformation<Either<Row, Row>> updateType = TypeInformation.of(new TypeHint<Either<Row, Row>>() {
        });
        DataStream<Row> campaigns = CampaignRepository
            .changelog(tables, database, CAMPAIGN_TABLE, "flink_fanout_campaigns_slot");
        DataStream<Row> campaignNodes = CampaignNodeRepository
            .changelog(tables, database, CAMPAIGN_NODE_TABLE, "flink_fanout_campaign_nodes_slot");
        TableSources.identify(campaigns, "campaigns-source");
        TableSources.identify(campaignNodes, "campaign-nodes-source");
        // Each wrap is its own lambda, so javac casts each with its own types.
        DataStream<Either<Row, Row>> ruleUpdates = campaigns
            .map(row -> Either.<Row, Row>Left(row))
            .returns(updateType)
            .uid("campaign-updates")
            .setParallelism(1)
            .union(campaignNodes
                .map(row -> Either.<Row, Row>Right(row))
                .returns(updateType)
                .uid("campaign-node-updates")
                .setParallelism(1));

        TypeInformation<Either<BusinessEvent, Event>> inputType = TypeInformation
            .of(new TypeHint<Either<BusinessEvent, Event>>() {
            });
        DataStream<IndexInput> routed = businessEvents
            .map(event -> Either.<BusinessEvent, Event>Left(event))
            .returns(inputType)
            .uid("business-event-inputs")
            .union(personEvents
                .map(event -> Either.<BusinessEvent, Event>Right(event))
                .returns(inputType)
                .uid("person-event-inputs"))
            .connect(ruleUpdates.broadcast(FanoutRouter.CAMPAIGN_STATUS, FanoutRouter.TRIGGERS))
            .process(new FanoutRouter())
            .returns(TypeInformation.of(IndexInput.class))
            .name("Route to Index Keys")
            .uid("route-to-index-keys");

        // One key per interest and item, or per segment shard, so one subtask owns
        // each index entry.
        SingleOutputStreamOperator<Match> matches = routed
            .union(membershipChanges)
            .keyBy(IndexInput::indexKey, Types.STRING)
            .process(new IndexFunction())
            .returns(TypeInformation.of(Match.class))
            .name("Keep Index and Fan Out")
            .uid("keep-index-and-fan-out");

        matches.sinkTo(matchSink(brokers, matchTopic, security)).uid("business-event-match-sink");
        return environment;
    }

    private static KafkaSource<String> source(String brokers, String groupId, String topic,
        KafkaSecurityConfig security, OffsetResetStrategy reset, boolean readCommitted) {
        var properties = KafkaSourceConfig.of(brokers, groupId, topic, security).toProperties();
        if (readCommitted) properties.setProperty("isolation.level", "read_committed");
        return KafkaSource
            .<String>builder()
            .setBootstrapServers(brokers)
            .setTopics(topic)
            .setGroupId(groupId)
            .setStartingOffsets(OffsetsInitializer.committedOffsets(reset))
            .setValueOnlyDeserializer(new SimpleStringSchema())
            .setProperties(properties)
            .build();
    }

    private static KafkaSink<Match> matchSink(String brokers, String topic, KafkaSecurityConfig security) {
        // At least once: customer decision makes a repeated match harmless by its
        // entry id (BEF-NFR-05).
        return KafkaSink
            .<Match>builder()
            .setBootstrapServers(brokers)
            .setKafkaProducerConfig(security.clientProperties())
            .setRecordSerializer(KafkaRecordSerializationSchema
                .<Match>builder()
                .setTopic(topic)
                .setKeySerializationSchema(new KeySerializationSchema<>(Match.class, Match::canonId))
                .setValueSerializationSchema(new JsonSerializationSchema<>(Match.class))
                .build())
            .setDeliveryGuarantee(DeliveryGuarantee.AT_LEAST_ONCE)
            .build();
    }

    /**
     * A message from {@code snowplow-parsed} as a person event, when it has a
     * canon id, a name, and a time: the collector's, else the event's own.
     */
    static Optional<Event> personEvent(String message) {
        try {
            JsonNode root = JacksonMapper.readTree(message);
            String canonId = text(root, "canon_id");
            String eventName = text(root, "event_name");
            Long eventTime = number(root, "event_timestamp");
            Long collectorTime = number(root, "collector_timestamp");
            Long time = collectorTime != null ? collectorTime : eventTime;
            if (canonId == null || eventName == null || time == null) return Optional.empty();
            return Optional
                .of(new Event(canonId, text(root, "domain_userid"), text(root, "network_userid"),
                    text(root, "user_id"), eventName, eventTime, text(root, "screen_location"),
                    text(root, "product_name"), text(root, "url"), text(root, "referrer_url"),
                    text(root, "platform"), text(root, "event_json"), text(root, "event_id"), time));
        } catch (IllegalArgumentException exception) {
            LOG.warn("Dropping a parsed event that is not JSON: {}", exception.getMessage());
            return Optional.empty();
        }
    }

    static Optional<IndexInput> membershipChange(String message) {
        try {
            SegmentMembershipChange change = JacksonMapper.readValue(message, SegmentMembershipChange.class);
            if (change.canonId() == null || change.segmentId() == null || change.change() == null) {
                LOG.warn("Dropping a segment membership change without a canon id, segment, or change");
                return Optional.empty();
            }
            long time = change.eventTime() == null ? 0 : change.eventTime();
            return Optional.of(FanoutRules.segmentChange(change.canonId(), change.segmentId(), change.entered(), time));
        } catch (IllegalArgumentException exception) {
            LOG.warn("Dropping a segment membership change that does not parse: {}", exception.getMessage());
            return Optional.empty();
        }
    }

    private static String text(JsonNode root, String field) {
        JsonNode value = root.get(field);
        return value == null || !value.isTextual() || value.asText().isBlank() ? null : value.asText();
    }

    private static Long number(JsonNode root, String field) {
        JsonNode value = root.get(field);
        return value == null || !value.canConvertToLong() || !value.isNumber() ? null : value.asLong();
    }
}
