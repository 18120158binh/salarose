package com.cdp.platform.shared.config;

import java.util.HashMap;
import java.util.Map;
import java.util.Properties;

import org.apache.flink.table.api.TableDescriptor;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class KafkaSecurityConfigTest {

    private static final String PREFIX = "EVENT_PARSE_SOURCE_";
    private static final String KAFKA_JAAS = "org.apache.kafka.common.security.scram.ScramLoginModule required "
        + "username=\"flink\" password=\"secret\";";

    @Test
    void withoutAProtocolTheClientConnectsInPlainText() {
        assertEquals(Map.of(), options(KafkaSecurityConfig.from(Map.of(), PREFIX)));
        assertEquals(Map.of(), options(KafkaSecurityConfig.from(Map.of("KAFKA_SECURITY_PROTOCOL", " "), PREFIX)));
        assertEquals(new Properties(), KafkaSecurityConfig.none().clientProperties());
    }

    @Test
    void saslOverTlsPassesTheJaasConfigThroughAndTrustsPemCertificates() {
        KafkaSecurityConfig security = KafkaSecurityConfig
            .from(Map
                .of("KAFKA_SECURITY_PROTOCOL", "sasl_ssl", "KAFKA_SASL_JAAS_CONFIG", KAFKA_JAAS,
                    "KAFKA_SSL_TRUSTSTORE_LOCATION", "/etc/kafka/ca.pem"),
                PREFIX);

        assertEquals(Map
            .of("properties.security.protocol", "SASL_SSL", "properties.sasl.mechanism", "SCRAM-SHA-512",
                "properties.sasl.jaas.config", KAFKA_JAAS, "properties.ssl.truststore.location", "/etc/kafka/ca.pem",
                "properties.ssl.truststore.type", "PEM"),
            options(security));
    }

    @Test
    void theJobsOwnVariableWinsOverTheSharedOne() {
        KafkaSecurityConfig security = KafkaSecurityConfig
            .from(Map
                .of("KAFKA_SECURITY_PROTOCOL", "SASL_SSL", PREFIX + "KAFKA_SECURITY_PROTOCOL", "SSL",
                    PREFIX + "KAFKA_SSL_TRUSTSTORE_TYPE", "JKS"),
                PREFIX);

        assertEquals(Map.of("properties.security.protocol", "SSL", "properties.ssl.truststore.type", "JKS"),
            options(security));
    }

    @Test
    void saslWithoutAJaasConfigStopsTheJobAndNamesTheVariable() {
        IllegalStateException failure = assertThrows(IllegalStateException.class,
            () -> KafkaSecurityConfig.from(Map.of("KAFKA_SECURITY_PROTOCOL", "SASL_SSL"), PREFIX));

        assertTrue(failure.getMessage().contains(PREFIX + "KAFKA_SASL_JAAS_CONFIG"), failure.getMessage());
    }

    @Test
    void clientPropertiesDropTheTableOptionPrefix() {
        Properties properties = KafkaSecurityConfig
            .from(Map.of("KAFKA_SECURITY_PROTOCOL", "SSL"), PREFIX)
            .clientProperties();

        assertEquals("SSL", properties.getProperty("security.protocol"));
        assertEquals("PEM", properties.getProperty("ssl.truststore.type"));
        assertEquals(2, properties.size());
    }

    /** The options the security adds to a Kafka table. */
    private static Map<String, String> options(KafkaSecurityConfig security) {
        Map<String, String> options = new HashMap<>(
            security.applyTo(TableDescriptor.forConnector("kafka")).build().getOptions());
        options.remove("connector");
        return options;
    }
}
