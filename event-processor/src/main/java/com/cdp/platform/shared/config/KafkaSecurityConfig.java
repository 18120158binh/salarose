package com.cdp.platform.shared.config;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;

import org.apache.flink.table.api.TableDescriptor;

/**
 * Optional Kafka client security settings shared by all Table API connectors.
 */
public final class KafkaSecurityConfig {

    private static final String SECURITY_PROTOCOL = "KAFKA_SECURITY_PROTOCOL";
    private static final String SASL_MECHANISM = "KAFKA_SASL_MECHANISM";
    private static final String SASL_JAAS_CONFIG = "KAFKA_SASL_JAAS_CONFIG";
    private static final String SSL_TRUSTSTORE_LOCATION = "KAFKA_SSL_TRUSTSTORE_LOCATION";
    private static final String SSL_TRUSTSTORE_TYPE = "KAFKA_SSL_TRUSTSTORE_TYPE";

    private final Map<String, String> tableOptions;

    private KafkaSecurityConfig(Map<String, String> tableOptions) {
        this.tableOptions = Map.copyOf(tableOptions);
    }

    public static KafkaSecurityConfig none() {
        return new KafkaSecurityConfig(Map.of());
    }

    public static KafkaSecurityConfig fromEnvironment(String componentPrefix) {
        return from(System.getenv(), componentPrefix);
    }

    public static KafkaSecurityConfig from(Map<String, String> environment, String componentPrefix) {
        String prefix = componentPrefix == null ? "" : componentPrefix;
        String protocol = value(environment, prefix, SECURITY_PROTOCOL, "").toUpperCase(Locale.ROOT);

        if (protocol.isBlank()) {
            return new KafkaSecurityConfig(Map.of());
        }

        Map<String, String> options = new LinkedHashMap<>();
        options.put("properties.security.protocol", protocol);

        if (protocol.startsWith("SASL_")) {
            options.put("properties.sasl.mechanism", value(environment, prefix, SASL_MECHANISM, "SCRAM-SHA-512"));
            options.put("properties.sasl.jaas.config", required(environment, prefix, SASL_JAAS_CONFIG, protocol));
        }

        if (protocol.endsWith("SSL")) {
            putIfPresent(options, "properties.ssl.truststore.location",
                value(environment, prefix, SSL_TRUSTSTORE_LOCATION, ""));
            putIfPresent(options, "properties.ssl.truststore.type",
                value(environment, prefix, SSL_TRUSTSTORE_TYPE, "PEM"));
        }

        return new KafkaSecurityConfig(options);
    }

    public TableDescriptor.Builder applyTo(TableDescriptor.Builder builder) {
        tableOptions.forEach(builder::option);
        return builder;
    }

    /** Kafka client properties for DataStream Kafka sources and sinks. */
    public Properties clientProperties() {
        Properties properties = new Properties();
        tableOptions.forEach((name, value) -> properties.setProperty(name.replaceFirst("^properties\\.", ""), value));
        return properties;
    }

    private static String required(Map<String, String> environment, String prefix, String name, String protocol) {
        String value = value(environment, prefix, name, "");
        if (value.isBlank()) {
            throw new IllegalStateException(qualified(prefix, name) + " is required when Kafka uses " + protocol);
        }
        return value;
    }

    private static String value(Map<String, String> environment, String prefix, String name, String defaultValue) {
        String componentValue = environment.get(qualified(prefix, name));
        if (componentValue != null && !componentValue.isBlank()) {
            return componentValue.trim();
        }

        String globalValue = environment.get(name);
        if (globalValue != null && !globalValue.isBlank()) {
            return globalValue.trim();
        }
        return defaultValue;
    }

    private static String qualified(String prefix, String name) {
        return prefix + name;
    }

    private static void putIfPresent(Map<String, String> options, String name, String value) {
        if (!value.isBlank()) {
            options.put(name, value);
        }
    }
}
