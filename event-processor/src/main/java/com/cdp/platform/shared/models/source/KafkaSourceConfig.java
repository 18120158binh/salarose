package com.cdp.platform.shared.models.source;

import java.util.Collections;
import java.util.List;
import java.util.Objects;
import java.util.Properties;

import org.apache.flink.table.api.Schema;
import org.apache.flink.table.api.TableDescriptor;

import com.cdp.platform.shared.config.KafkaSecurityConfig;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Pure configuration record for Kafka sources.
 * Accepts configuration directly from callers/jobs without implicit environment
 * lookup.
 */
public record KafkaSourceConfig(
    @JsonProperty("brokers") String brokers,
    @JsonProperty("groupId") String groupId,
    @JsonProperty("topics") List<String> topics,
    @JsonProperty("topicPattern") String topicPattern,
    @JsonProperty("startupMode") String startupMode,
    @JsonProperty("security") KafkaSecurityConfig security,
    @JsonProperty("extraProperties") Properties extraProperties) {

    public static final String DEFAULT_BROKERS = "redpanda:29092";
    public static final String DEFAULT_GROUP_ID = "flink-source-group";

    public KafkaSourceConfig {
        brokers = (brokers != null && !brokers.isBlank()) ? brokers.trim() : DEFAULT_BROKERS;
        groupId = (groupId != null && !groupId.isBlank()) ? groupId.trim() : DEFAULT_GROUP_ID;
        topics = topics == null ? Collections.emptyList() : List.copyOf(topics);
        startupMode = (startupMode != null && !startupMode.isBlank()) ? startupMode.trim() : "group-offsets";
        security = Objects.requireNonNullElseGet(security, KafkaSecurityConfig::none);
        extraProperties = extraProperties == null ? new Properties() : (Properties) extraProperties.clone();
    }

    public static KafkaSourceConfig of(String brokers, String groupId, String topic) {
        return of(brokers, groupId, topic, KafkaSecurityConfig.none());
    }

    public static KafkaSourceConfig of(String brokers, String groupId, String topic, KafkaSecurityConfig security) {
        return new KafkaSourceConfig(
            brokers,
            groupId,
            topic != null ? List.of(topic) : Collections.emptyList(),
            null,
            "group-offsets",
            security,
            new Properties());
    }

    public static KafkaSourceConfig ofPattern(String brokers, String groupId, String topicPattern,
        KafkaSecurityConfig security) {
        return new KafkaSourceConfig(
            brokers,
            groupId,
            Collections.emptyList(),
            topicPattern,
            "group-offsets",
            security,
            new Properties());
    }

    public Properties toProperties() {
        Properties properties = security.clientProperties();
        properties.setProperty("bootstrap.servers", brokers);
        properties.setProperty("group.id", groupId);
        properties.putAll(extraProperties);
        return properties;
    }

    public TableDescriptor.Builder createTableDescriptorBuilder(Schema schema) {
        TableDescriptor.Builder builder = security
            .applyTo(TableDescriptor.forConnector("kafka"))
            .schema(schema)
            .option("properties.bootstrap.servers", brokers)
            .option("properties.group.id", groupId)
            .option("scan.startup.mode", startupMode);
        if (topicPattern != null && !topicPattern.isBlank()) {
            builder.option("topic-pattern", topicPattern);
        } else if (topics != null && !topics.isEmpty()) {
            builder.option("topic", String.join(";", topics));
        }
        for (String key : extraProperties.stringPropertyNames()) {
            builder.option(key, extraProperties.getProperty(key));
        }
        return builder;
    }
}
