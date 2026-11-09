package com.cdp.platform.shared.models.source;

import java.util.Map;
import java.util.Properties;

import org.apache.flink.table.api.DataTypes;
import org.apache.flink.table.api.Schema;

import com.cdp.platform.shared.config.KafkaSecurityConfig;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import org.junit.jupiter.api.Test;

class KafkaSourceConfigTest {

    private static final Schema SCHEMA = Schema.newBuilder().column("raw_payload", DataTypes.BYTES()).build();
    private static final KafkaSecurityConfig TLS = KafkaSecurityConfig
        .from(Map.of("KAFKA_SECURITY_PROTOCOL", "SSL"), "");

    @Test
    void blankBrokersAndGroupTakeTheDefaults() {
        KafkaSourceConfig source = KafkaSourceConfig.of(" ", null, "snowplow-parsed");

        assertEquals(KafkaSourceConfig.DEFAULT_BROKERS, source.brokers());
        assertEquals(KafkaSourceConfig.DEFAULT_GROUP_ID, source.groupId());
    }

    @Test
    void aTopicSourceReadsTheTopicFromTheGroupOffsets() {
        Map<String, String> options = KafkaSourceConfig
            .of(" kafka:9092 ", "decision", "snowplow-parsed", TLS)
            .createTableDescriptorBuilder(SCHEMA)
            .build()
            .getOptions();

        assertEquals(Map
            .of("connector", "kafka", "properties.bootstrap.servers", "kafka:9092", "properties.group.id",
                "decision", "scan.startup.mode", "group-offsets", "topic", "snowplow-parsed",
                "properties.security.protocol", "SSL", "properties.ssl.truststore.type", "PEM"),
            options);
    }

    @Test
    void aPatternSourceReadsTheTopicPatternAndNoTopic() {
        Map<String, String> options = KafkaSourceConfig
            .ofPattern("kafka:9092", "parser", "snowplow\\.good\\..*", KafkaSecurityConfig.none())
            .createTableDescriptorBuilder(SCHEMA)
            .build()
            .getOptions();

        assertEquals("snowplow\\.good\\..*", options.get("topic-pattern"));
        assertFalse(options.containsKey("topic"));
    }

    @Test
    void clientPropertiesCarryTheBrokersTheGroupAndTheSecurity() {
        Properties properties = KafkaSourceConfig.of("kafka:9092", "writer", "mutations", TLS).toProperties();

        assertEquals("kafka:9092", properties.getProperty("bootstrap.servers"));
        assertEquals("writer", properties.getProperty("group.id"));
        assertEquals("SSL", properties.getProperty("security.protocol"));
    }
}
