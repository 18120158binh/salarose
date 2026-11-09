package com.cdp.platform.shared.config;

import java.io.IOException;
import java.net.URISyntaxException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.security.auth.spi.LoginModule;

import org.apache.flink.connector.jdbc.core.datastream.sink.JdbcSink;
import org.apache.flink.connector.kafka.sink.KafkaSink;
import org.apache.flink.connector.kafka.source.KafkaSource;
import org.apache.flink.runtime.util.EnvironmentInformation;
import org.apache.flink.table.factories.DynamicTableSourceFactory;
import org.apache.flink.table.factories.FactoryUtil;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;
import org.postgresql.util.DriverInfo;

/**
 * The job jar carries the connectors, and the Flink image carries only the JDBC
 * driver. These tests read the classes
 * the build puts on the job's classpath and the jars the image adds to Flink's
 * {@code lib}.
 */
class ConnectorClasspathTest {

    private static final Path DOCKERFILE = Path.of("Dockerfile");
    private static final Pattern IMAGE_JAR = Pattern.compile("maven2/[^ ]+/([^/ ]+)/([^/ ]+)/\\1-\\2\\.jar");

    @Test
    void theConfiguredScramLoginModuleIsOnTheJobsClasspath() throws ClassNotFoundException {
        assertLoads(configuredLoginModule("org.apache.kafka.common.security.scram.ScramLoginModule"));
    }

    @Test
    void theConfiguredPlainLoginModuleIsOnTheJobsClasspath() throws ClassNotFoundException {
        assertLoads(configuredLoginModule("org.apache.kafka.common.security.plain.PlainLoginModule"));
    }

    @Test
    void everyConnectorComesFromAJarBuiltForTheFlinkVersionTheImageRuns() throws URISyntaxException {
        String flinkMinor = EnvironmentInformation.getVersion().replaceFirst("^(\\d+\\.\\d+).*", "$1");
        List<Class<?>> connectors = List
            .of(KafkaSource.class, KafkaSink.class, JdbcSink.class, tableSource("kafka"), tableSource("postgres-cdc"));

        for (Class<?> connector : connectors) {
            String jar = jarOf(connector);
            assertTrue(jar.endsWith("-" + flinkMinor + ".jar"), connector.getName() + " loads from " + jar);
        }
    }

    @Test
    void theGuavaTheCdcSourceCompilesAgainstIsOnTheJobsClasspath() throws ClassNotFoundException {
        Class.forName("org.apache.flink.shaded.guava31.com.google.common.util.concurrent.ThreadFactoryBuilder");
    }

    @Test
    void theImageAddsNoConnectorAndTheDriverTheJobCompilesAgainst() throws IOException {
        List<ImageJar> imageJars = imageJars();

        for (ImageJar jar : imageJars) {
            assertFalse(jar.artifact().contains("connector"), "the image adds " + jar.artifact() + " to Flink's lib");
        }
        String driver = imageJars
            .stream()
            .filter(jar -> jar.artifact().equals("postgresql"))
            .map(ImageJar::version)
            .findFirst()
            .orElse("none");
        assertEquals(DriverInfo.DRIVER_VERSION, driver);
    }

    /**
     * The login module class that the Kafka client reads from the JAAS config the
     * job passes it.
     */
    private static String configuredLoginModule(String module) {
        String jaas = module + " required username=\"flink\" password=\"secret\";";
        String configured = KafkaSecurityConfig
            .from(Map.of("KAFKA_SECURITY_PROTOCOL", "SASL_SSL", "KAFKA_SASL_JAAS_CONFIG", jaas), "")
            .clientProperties()
            .getProperty("sasl.jaas.config");

        return configured.substring(0, configured.indexOf(' '));
    }

    private static void assertLoads(String loginModule) throws ClassNotFoundException {
        assertTrue(LoginModule.class.isAssignableFrom(Class.forName(loginModule)), loginModule);
    }

    private static Class<?> tableSource(String identifier) {
        return FactoryUtil
            .discoverFactory(ConnectorClasspathTest.class.getClassLoader(), DynamicTableSourceFactory.class, identifier)
            .getClass();
    }

    private static String jarOf(Class<?> type) throws URISyntaxException {
        return Path.of(type.getProtectionDomain().getCodeSource().getLocation().toURI()).getFileName().toString();
    }

    /** The Maven jars the Dockerfile downloads into Flink's {@code lib}. */
    private static List<ImageJar> imageJars() throws IOException {
        Matcher matcher = IMAGE_JAR.matcher(Files.readString(DOCKERFILE));
        return matcher.results().map(match -> new ImageJar(match.group(1), match.group(2))).toList();
    }

    private record ImageJar(String artifact, String version) {
    }
}
