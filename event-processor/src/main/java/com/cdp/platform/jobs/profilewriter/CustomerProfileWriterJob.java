package com.cdp.platform.jobs.profilewriter;

import java.util.Properties;

import org.apache.flink.api.common.eventtime.WatermarkStrategy;
import org.apache.flink.api.common.serialization.SimpleStringSchema;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.connector.kafka.source.KafkaSource;
import org.apache.flink.connector.kafka.source.enumerator.initializer.OffsetsInitializer;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;

import com.cdp.platform.jobs.profilewriter.transforms.CustomerProfileMutationMapper;
import com.cdp.platform.jobs.profilewriter.transforms.RatePacer;
import com.cdp.platform.jobs.profilewriter.transforms.SegmentMembershipChangeMapper;
import com.cdp.platform.shared.config.DatabaseConfig;
import com.cdp.platform.shared.config.KafkaSecurityConfig;
import com.cdp.platform.shared.db.repositories.SegmentMemberRepository;
import com.cdp.platform.shared.db.repositories.UserMetricRepository;
import com.cdp.platform.shared.models.CustomerProfileMutationEvent;
import com.cdp.platform.shared.models.SegmentMembershipChange;
import com.cdp.platform.shared.models.db.UserMetric;
import com.cdp.platform.shared.models.source.KafkaSourceConfig;

import org.apache.kafka.clients.consumer.ConsumerConfig;

/** Durable PostgreSQL projection of customer profile mutations. */
public final class CustomerProfileWriterJob {

    private static final String JOB_NAME = "customer-profile-writer-job";
    private static final double DEFAULT_SEGMENT_MEMBERS_MAX_ROWS_PER_SECOND = 1_000;

    private CustomerProfileWriterJob() {
    }

    public static void main(String[] args) throws Exception {
        String kafkaBrokers = System
            .getenv()
            .getOrDefault("PROFILE_WRITER_KAFKA_BROKERS",
                System.getenv().getOrDefault("KAFKA_BROKERS", "redpanda:29092"));
        String groupId = System
            .getenv()
            .getOrDefault("PROFILE_WRITER_GROUP_ID",
                System.getenv().getOrDefault("KAFKA_GROUP_ID", "customer-profile-writer"));
        String topic = System.getenv().getOrDefault("KAFKA_PROFILE_MUTATION_TOPIC", "customer-profile-mutations");

        KafkaSecurityConfig kafkaSecurity = KafkaSecurityConfig.fromEnvironment("PROFILE_WRITER_");
        DatabaseConfig databaseConfig = DatabaseConfig.fromEnvironment();

        KafkaSourceConfig sourceConfig = KafkaSourceConfig.of(kafkaBrokers, groupId, topic, kafkaSecurity);

        StreamExecutionEnvironment environment = StreamExecutionEnvironment.getExecutionEnvironment();
        environment.enableCheckpointing(30_000L);

        Properties properties = sourceConfig.toProperties();
        properties.setProperty("auto.offset.reset", "earliest");
        String maxMessageBytes = String.valueOf(CustomerProfileMutationEvent.MAX_MESSAGE_BYTES);
        properties.setProperty(ConsumerConfig.MAX_PARTITION_FETCH_BYTES_CONFIG, maxMessageBytes);
        properties.setProperty(ConsumerConfig.FETCH_MAX_BYTES_CONFIG, maxMessageBytes);
        KafkaSource<String> source = KafkaSource
            .<String>builder()
            .setBootstrapServers(sourceConfig.brokers())
            .setTopics(topic)
            .setGroupId(sourceConfig.groupId())
            .setStartingOffsets(OffsetsInitializer.earliest())
            .setValueOnlyDeserializer(new SimpleStringSchema())
            .setProperties(properties)
            .build();

        DataStream<UserMetric> metrics = environment
            .fromSource(source, WatermarkStrategy.noWatermarks(), "Customer Profile Mutations")
            .uid("customer-profile-mutations-source")
            .flatMap(new CustomerProfileMutationMapper())
            .returns(TypeInformation.of(UserMetric.class))
            .name("Decode User Metrics")
            .uid("decode-user-metrics");

        UserMetricRepository.attach(metrics, databaseConfig);

        String membershipTopic = System
            .getenv()
            .getOrDefault("KAFKA_SEGMENT_MEMBERSHIP_TOPIC", "segment-membership-changes");
        KafkaSource<String> membershipSource = KafkaSource
            .<String>builder()
            .setBootstrapServers(sourceConfig.brokers())
            .setTopics(membershipTopic)
            .setGroupId(sourceConfig.groupId())
            .setStartingOffsets(OffsetsInitializer.earliest())
            .setValueOnlyDeserializer(new SimpleStringSchema())
            .setProperties(sourceConfig.toProperties())
            .build();

        DataStream<SegmentMembershipChange> changes = environment
            .fromSource(membershipSource, WatermarkStrategy.noWatermarks(), "Segment Membership Changes")
            .uid("segment-membership-changes-source")
            .flatMap(new SegmentMembershipChangeMapper())
            .returns(TypeInformation.of(SegmentMembershipChange.class))
            .name("Decode Segment Membership Changes")
            .uid("decode-segment-membership-changes")
            .map(new RatePacer<SegmentMembershipChange>(
                segmentMembersMaxRowsPerSecond(System.getenv("SEGMENT_MEMBERS_MAX_ROWS_PER_SECOND"))))
            .returns(TypeInformation.of(SegmentMembershipChange.class))
            .name("Pace Segment Membership Changes")
            .uid("pace-segment-membership-changes");

        SegmentMemberRepository.attach(changes, databaseConfig);
        environment.execute(JOB_NAME);
    }

    /**
     * The cap on {@code segment_members} writes a second (PRW-NFR-06), 1,000 when
     * unset.
     */
    static double segmentMembersMaxRowsPerSecond(String configured) {
        if (configured == null || configured.isBlank()) return DEFAULT_SEGMENT_MEMBERS_MAX_ROWS_PER_SECOND;
        double rows;
        try {
            rows = Double.parseDouble(configured.strip());
        } catch (NumberFormatException invalid) {
            throw new IllegalArgumentException("SEGMENT_MEMBERS_MAX_ROWS_PER_SECOND is not a number: " + configured,
                invalid);
        }
        if (!(rows > 0) || Double.isInfinite(rows)) {
            throw new IllegalArgumentException("SEGMENT_MEMBERS_MAX_ROWS_PER_SECOND must be positive: " + configured);
        }
        return rows;
    }
}
