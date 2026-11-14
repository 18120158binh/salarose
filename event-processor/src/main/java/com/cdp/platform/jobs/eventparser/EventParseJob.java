package com.cdp.platform.jobs.eventparser;

import java.time.Duration;
import java.util.List;
import java.util.stream.IntStream;

import org.apache.flink.api.common.eventtime.WatermarkStrategy;
import org.apache.flink.api.common.serialization.SimpleStringSchema;
import org.apache.flink.api.common.typeinfo.TypeHint;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.dag.Transformation;
import org.apache.flink.configuration.Configuration;
import org.apache.flink.connector.base.DeliveryGuarantee;
import org.apache.flink.connector.jdbc.JdbcExecutionOptions;
import org.apache.flink.connector.kafka.sink.KafkaRecordSerializationSchema;
import org.apache.flink.connector.kafka.sink.KafkaSink;
import org.apache.flink.connector.kafka.source.KafkaSource;
import org.apache.flink.connector.kafka.source.enumerator.initializer.OffsetsInitializer;
import org.apache.flink.streaming.api.datastream.CustomSinkOperatorUidHashes;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.datastream.SingleOutputStreamOperator;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.streaming.api.transformations.SinkTransformation;
import org.apache.flink.table.api.DataTypes;
import org.apache.flink.table.api.Schema;
import org.apache.flink.table.api.Table;
import org.apache.flink.table.api.TableDescriptor;
import org.apache.flink.table.api.bridge.java.StreamStatementSet;
import org.apache.flink.table.api.bridge.java.StreamTableEnvironment;
import org.apache.flink.types.Either;
import org.apache.flink.types.Row;
import org.apache.flink.util.TimeUtils;

import com.cdp.platform.jobs.eventparser.identity.IdentityStitcherFunction;
import com.cdp.platform.jobs.eventparser.transforms.DeadLetter;
import com.cdp.platform.jobs.eventparser.transforms.LegacyContextPrefix;
import com.cdp.platform.jobs.eventparser.transforms.ParseApiEvent;
import com.cdp.platform.jobs.eventparser.transforms.ParseSnowplowEvent;
import com.cdp.platform.jobs.eventparser.transforms.SchemaGateFunction;
import com.cdp.platform.jobs.eventparser.volume.EventVolumeCounter;
import com.cdp.platform.shared.config.DatabaseConfig;
import com.cdp.platform.shared.config.KafkaSecurityConfig;
import com.cdp.platform.shared.db.repositories.EventVolumeTable;
import com.cdp.platform.shared.db.repositories.IdentityGraphRepository;
import com.cdp.platform.shared.db.repositories.UserEventCatalogRepository;
import com.cdp.platform.shared.db.sinks.JdbcSinkOptions;
import com.cdp.platform.shared.models.ParsedEvent;
import com.cdp.platform.shared.models.source.KafkaSourceConfig;
import com.cdp.platform.shared.utils.JsonSerializationSchema;
import com.cdp.platform.shared.utils.PlaceholderIds;

import org.apache.kafka.clients.consumer.OffsetResetStrategy;

public class EventParseJob {

    private static final String JOB_NAME = "event-parse-job";
    private static final String CATALOG_EVENT_TABLE = "event_parse_catalog_events";
    private static final String CATALOG_ATTRIBUTE_TABLE = "event_parse_catalog_attributes";

    private EventParseJob() {
    }

    public static void main(String[] args) throws Exception {
        buildPipeline(DatabaseConfig.fromEnvironment(), new Configuration()).execute(JOB_NAME);
    }

    /**
     * Builds the job graph without connecting to Kafka or Postgres. The settings
     * apply to the job on top of the cluster's configuration.
     */
    static StreamExecutionEnvironment buildPipeline(DatabaseConfig databaseConfig, Configuration settings) {
        String sourceKafkaBrokers = System
            .getenv()
            .getOrDefault("EVENT_PARSE_SOURCE_KAFKA_BROKERS",
                System.getenv().getOrDefault("KAFKA_BROKERS", "redpanda:29092"));
        String sinkKafkaBrokers = System
            .getenv()
            .getOrDefault("EVENT_PARSE_SINK_KAFKA_BROKERS",
                System.getenv().getOrDefault("KAFKA_BROKERS", "redpanda:29092"));
        String groupId = System
            .getenv()
            .getOrDefault("EVENT_PARSE_SOURCE_GROUP_ID",
                System.getenv().getOrDefault("KAFKA_GROUP_ID", "event-processor-group"));
        String sourcePattern = System
            .getenv()
            .getOrDefault("KAFKA_EVENT_TOPIC_PATTERN", "snowplow\\.good\\.events\\..*");
        String apiTopic = System.getenv().getOrDefault("KAFKA_INGESTION_API_TOPIC", "ingestion-api-events");
        String sinkTopic = System.getenv().getOrDefault("KAFKA_EVENT_PARSED_TOPIC", "snowplow-parsed");
        String deadLetterTopic = System
            .getenv()
            .getOrDefault("KAFKA_EVENT_DEAD_LETTER_TOPIC", "snowplow-parsed-dead-letters");
        String checkpointInterval = System.getenv().getOrDefault("CHECKPOINT_INTERVAL", "30s");
        PlaceholderIds placeholderIds = PlaceholderIds.fromEnvironment();
        LegacyContextPrefix legacyPrefix = LegacyContextPrefix.fromEnvironment();
        Duration identityRecheckInterval = TimeUtils
            .parseDuration(System.getenv().getOrDefault("IDENTITY_RECHECK_INTERVAL", "1m"));
        int deadLetterPayloadLimit = DeadLetter.payloadLimit(System.getenv(DeadLetter.PAYLOAD_LIMIT_VARIABLE));
        JdbcExecutionOptions identityBatches = JdbcSinkOptions
            .batches(Integer.parseInt(System.getenv().getOrDefault("JDBC_BATCH_SIZE", "200")),
                TimeUtils.parseDuration(System.getenv().getOrDefault("JDBC_BATCH_INTERVAL", "200ms")));
        // A batch keeps one total per row, so a longer interval writes fewer rows.
        JdbcExecutionOptions volumeBatches = JdbcSinkOptions
            .batches(Integer.parseInt(System.getenv().getOrDefault("JDBC_BATCH_SIZE", "200")),
                TimeUtils.parseDuration(System.getenv().getOrDefault("EVENT_VOLUME_BATCH_INTERVAL", "10s")));

        KafkaSecurityConfig sourceSecurity = KafkaSecurityConfig.fromEnvironment("EVENT_PARSE_SOURCE_");

        KafkaSourceConfig sourceConfig = KafkaSourceConfig
            .ofPattern(sourceKafkaBrokers, groupId, sourcePattern, sourceSecurity);

        // 1. Initialize Flink Execution Environment
        StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment(settings);
        // Set on the environment, which env.execute reads. attachAsDataStream does not
        // copy the table config to it.
        env.enableCheckpointing(TimeUtils.parseDuration(checkpointInterval).toMillis());
        StreamTableEnvironment tEnv = StreamTableEnvironment.create(env);

        TableDescriptor sourceDescriptor = sourceConfig
            .createTableDescriptorBuilder(Schema.newBuilder().column("raw_payload", DataTypes.BYTES()).build())
            .option("properties.auto.offset.reset", "latest")
            .option("format", "raw")
            .build();

        tEnv.createTemporaryTable("kafka_snowplow_good", sourceDescriptor);

        KafkaSecurityConfig sinkSecurity = KafkaSecurityConfig.fromEnvironment("EVENT_PARSE_SINK_");
        TableDescriptor sinkDescriptor = sinkSecurity
            .applyTo(TableDescriptor.forConnector("kafka"))
            .schema(ParsedEvent.schema())
            .option("topic", sinkTopic)
            .option("properties.bootstrap.servers", sinkKafkaBrokers)
            .option("key.format", "raw")
            .option("key.fields", "canon_id")
            .option("value.format", "json")
            .option("value.fields-include", "ALL")
            .option("sink.delivery-guarantee", "at-least-once")
            .build();

        tEnv.createTemporaryTable("kafka_snowplow_parsed", sinkDescriptor);

        DataStream<Row> rawPayloads = tEnv.toDataStream(tEnv.from("kafka_snowplow_good"));
        // The id Flink generated for the Kafka source before the catalog sources were
        // added, at any parallelism, so its offsets restore from an older savepoint.
        identifyTableSource(rawPayloads, "snowplow-good-source").setUidHash("cbc357ccb763df2852fee8c4fc7d55f2");
        TypeInformation<ParsedEvent> parsedType = TypeInformation.of(ParsedEvent.class);
        SingleOutputStreamOperator<ParsedEvent> parsedStream = rawPayloads
            .process(new ParseSnowplowEvent(placeholderIds, legacyPrefix, deadLetterPayloadLimit))
            .returns(parsedType)
            .name("Parse Snowplow Events")
            .uid("parse-snowplow-events");

        // The data ingestion API writes each request in a transaction, so read
        // committed events only. A new topic or group starts at the earliest offset,
        // so no event the API accepted is skipped.
        KafkaSource<String> apiSource = KafkaSource
            .<String>builder()
            .setBootstrapServers(sourceKafkaBrokers)
            .setTopics(apiTopic)
            .setGroupId(groupId)
            .setStartingOffsets(OffsetsInitializer.committedOffsets(OffsetResetStrategy.EARLIEST))
            .setValueOnlyDeserializer(new SimpleStringSchema())
            .setProperties(sourceSecurity.clientProperties())
            .setProperty("isolation.level", "read_committed")
            .build();
        SingleOutputStreamOperator<ParsedEvent> apiStream = env
            .fromSource(apiSource, WatermarkStrategy.noWatermarks(), "Ingestion API Events")
            .uid("ingestion-api-events-source")
            .process(new ParseApiEvent(placeholderIds, deadLetterPayloadLimit))
            .returns(parsedType)
            .name("Parse Ingestion API Events")
            .uid("parse-api-events");

        TypeInformation<Either<Row, Row>> catalogUpdateType = TypeInformation.of(new TypeHint<Either<Row, Row>>() {
        });
        DataStream<Either<Row, Row>> catalogEvents = UserEventCatalogRepository
            .eventChangelog(tEnv, databaseConfig, CATALOG_EVENT_TABLE, "flink_event_parse_catalog_events_slot")
            .<Either<Row, Row>>map(Either::Left)
            .returns(catalogUpdateType)
            .name("Catalog Event Updates")
            .uid("catalog-event-updates")
            .setParallelism(1);
        DataStream<Either<Row, Row>> catalogAttributes = UserEventCatalogRepository
            .attributeChangelog(tEnv, databaseConfig, CATALOG_ATTRIBUTE_TABLE,
                "flink_event_parse_catalog_fields_slot")
            .<Either<Row, Row>>map(Either::Right)
            .returns(catalogUpdateType)
            .name("Catalog Attribute Updates")
            .uid("catalog-attribute-updates")
            .setParallelism(1);
        identifyTableSource(catalogEvents, "catalog-events-source");
        identifyTableSource(catalogAttributes, "catalog-attributes-source");
        // Planner operators keep the ids sha-15717015fcc5 generated for them: a
        // savepoint holds an entry for every operator, stateless ones included.
        identifyPlannerOperator(rawPayloads, "TableToDataStream", "snowplow-good-table-to-stream",
            "998dadf9946b970c79d77e33b9d2221b");
        identifyPlannerOperator(catalogEvents, "TableToDataStream", "catalog-events-table-to-stream",
            "60012c04fa8e9af71f2e62ba10ef01d8");
        identifyPlannerOperator(catalogEvents, "ConstraintEnforcer", "catalog-events-not-null",
            "f56b46de9890103271819c0e0944e061");
        identifyPlannerOperator(catalogAttributes, "TableToDataStream", "catalog-attributes-table-to-stream",
            "57d37a84322a9b5fc19c35047a049691");
        identifyPlannerOperator(catalogAttributes, "ConstraintEnforcer", "catalog-attributes-not-null",
            "c1b6b6b9d3bef98441b0238f5b076a4c");

        SingleOutputStreamOperator<ParsedEvent> gatedStream = parsedStream
            .union(apiStream)
            .connect(catalogEvents
                .union(catalogAttributes)
                .broadcast(SchemaGateFunction.CATALOG_EVENTS, SchemaGateFunction.CATALOG_ATTRIBUTES))
            .process(new SchemaGateFunction())
            .returns(parsedType)
            .name("Catalog Schema Gate")
            .uid("catalog-schema-gate");

        SingleOutputStreamOperator<ParsedEvent> stitchedStream = gatedStream
            .filter(IdentityStitcherFunction::hasIdentifier)
            .name("Events With An Identifier")
            .uid("events-with-identifier")
            .keyBy(IdentityStitcherFunction::keyOf)
            .process(new IdentityStitcherFunction(databaseConfig, identityRecheckInterval))
            .returns(parsedType)
            .name("Identity Stitcher")
            .uid("identity-stitcher");
        // An event with no identifier keeps its null canon_id and goes around the
        // stitcher, so no key collects all of them.
        DataStream<ParsedEvent> withoutIdentifier = gatedStream
            .filter(event -> !IdentityStitcherFunction.hasIdentifier(event))
            .name("Events Without An Identifier")
            .uid("events-without-identifier");

        DataStream<Row> parsedRows = stitchedStream
            .union(withoutIdentifier)
            .map(ParsedEvent::toRow)
            .returns(ParsedEvent.ROW_TYPE)
            .name("Parsed Event Rows")
            .uid("parsed-event-rows");
        Table stitchedTable = tEnv.fromDataStream(parsedRows, ParsedEvent.schema());

        tEnv.getConfig().getConfiguration().setString("table.exec.sink.not-null-enforcer", "DROP");

        StreamStatementSet statementSet = tEnv.createStatementSet();
        statementSet.addInsert("kafka_snowplow_parsed", stitchedTable);
        statementSet.attachAsDataStream();
        SinkTransformation<?, ?> parsedSink = identifyTableSink(env, "kafka_snowplow_parsed",
            "kafka-snowplow-parsed-sink", CustomSinkOperatorUidHashes
                .builder()
                .setWriterUidHash("d6d3715bf8f439961ad0b670e668bc73")
                .setCommitterUidHash("0ab474423ed7ba38f42c3e02c381c284")
                .build());
        Transformation<?> parsedRowsToTable = parsedSink.getInputs().getFirst();
        parsedRowsToTable.setUid("parsed-rows-to-table");
        parsedRowsToTable.setUidHash("552996606ef16beb756235cd4b35b09b");

        DataStream<DeadLetter> deadLetters = parsedStream
            .getSideOutput(DeadLetter.OUTPUT)
            .union(apiStream.getSideOutput(DeadLetter.OUTPUT), gatedStream.getSideOutput(DeadLetter.OUTPUT));
        deadLetters
            .sinkTo(deadLetterSink(sinkKafkaBrokers, deadLetterTopic, sinkSecurity))
            .name("Dead Letters")
            .uid("dead-letter-sink");

        EventVolumeTable.attach(EventVolumeCounter.totals(gatedStream, deadLetters), databaseConfig, volumeBatches);

        IdentityGraphRepository
            .attach(stitchedStream.getSideOutput(IdentityStitcherFunction.DEVICE_MAPPINGS), databaseConfig,
                identityBatches);

        return env;
    }

    /** At least once, like {@code snowplow-parsed}, with no key. */
    private static KafkaSink<DeadLetter> deadLetterSink(String brokers, String topic, KafkaSecurityConfig security) {
        return KafkaSink
            .<DeadLetter>builder()
            .setBootstrapServers(brokers)
            .setKafkaProducerConfig(security.clientProperties())
            .setRecordSerializer(KafkaRecordSerializationSchema
                .<DeadLetter>builder()
                .setTopic(topic)
                .setValueSerializationSchema(new JsonSerializationSchema<>(DeadLetter.class))
                .build())
            .setDeliveryGuarantee(DeliveryGuarantee.AT_LEAST_ONCE)
            .build();
    }

    /**
     * The SQL planner creates the sink of a table insert and gives it no uid, so
     * its operators would take ids from the shape of the graph. Flink reads a
     * sink's operator hashes only from its constructor, so this replaces the
     * planner's sink with a copy that carries them. The writer takes the uid, the
     * committer {@code Sink Committer: <uid>}.
     */
    private static SinkTransformation<?, ?> identifyTableSink(StreamExecutionEnvironment env, String table,
        String uid, CustomSinkOperatorUidHashes hashes) {
        List<Transformation<?>> transformations = env.getTransformations();
        int index = IntStream
            .range(0, transformations.size())
            .filter(i -> transformations.get(i) instanceof SinkTransformation<?, ?> sink
                && sink.getName().startsWith(table + "["))
            .findFirst()
            .orElseThrow(() -> new IllegalStateException("No planner sink for " + table));
        SinkTransformation<?, ?> sink = withHashes((SinkTransformation<?, ?>) transformations.get(index), uid, hashes);
        transformations.set(index, sink);
        return sink;
    }

    private static <I, O> SinkTransformation<I, O> withHashes(SinkTransformation<I, O> planned, String uid,
        CustomSinkOperatorUidHashes hashes) {
        SinkTransformation<I, O> sink = new SinkTransformation<>(planned.getInputStream(), planned.getSink(),
            planned.getOutputType(), planned.getName(), planned.getParallelism(), planned.isParallelismConfigured(),
            hashes);
        sink.setUid(uid);
        sink.setDescription(planned.getDescription());
        if (planned.getChainingStrategy() != null) {
            sink.setChainingStrategy(planned.getChainingStrategy());
        }
        if (planned.getMaxParallelism() > 0) {
            sink.setMaxParallelism(planned.getMaxParallelism());
        }
        planned.getSlotSharingGroup().ifPresent(sink::setSlotSharingGroup);
        return sink;
    }

    /**
     * The SQL planner adds operators between a table source and its stream, such as
     * the not-null check and the conversion to rows, and gives them no uid.
     */
    private static void identifyPlannerOperator(DataStream<?> stream, String name, String uid, String hash) {
        Transformation<?> operator = stream.getTransformation();
        while (!operator.getName().startsWith(name)) {
            if (operator.getInputs().isEmpty()) {
                throw new IllegalStateException(
                    "No planner operator " + name + " above " + stream.getTransformation().getName());
            }
            operator = operator.getInputs().getFirst();
        }
        operator.setUid(uid);
        operator.setUidHash(hash);
    }

    /**
     * The SQL planner creates the source operator of a table stream and gives it no
     * uid, so set it here.
     */
    private static Transformation<?> identifyTableSource(DataStream<?> stream, String uid) {
        Transformation<?> source = stream.getTransformation();
        while (!source.getInputs().isEmpty()) {
            source = source.getInputs().getFirst();
        }
        source.setUid(uid);
        return source;
    }
}
