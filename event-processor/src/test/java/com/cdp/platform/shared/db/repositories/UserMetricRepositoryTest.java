package com.cdp.platform.shared.db.repositories;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

import com.cdp.platform.shared.config.DatabaseConfig;
import com.cdp.platform.shared.models.MetricBucket;
import com.cdp.platform.shared.models.MetricBucket.Size;
import com.cdp.platform.shared.models.db.UserMetric;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class UserMetricRepositoryTest {

    private static final MetricBucket ONE_MINUTE = new MetricBucket(Size.MINUTE, 0L, 1, null, null, null, null, null,
        null, null);
    private static final MetricBucket NEXT_MINUTE = new MetricBucket(Size.MINUTE, 60_000L, 1, null, null, null, null,
        null, null, null);
    private static final Path SCHEMA_SQL = Path.of("..", "infra", "db", "schema.sql");
    private static final Pattern CREATE_TABLE = Pattern
        .compile("CREATE TABLE IF NOT EXISTS user_metrics \\((.*?)\\n\\s*\\);", Pattern.DOTALL);
    private static final Pattern ALIAS = Pattern.compile(" as \"[^\"]+\"");
    private static final Pattern QUOTED_IDENTIFIER = Pattern.compile("\"([^\"]+)\"");

    @Test
    void readsGoToTheJobsReadReplica() {
        try (UserMetricRepository repository = UserMetricRepository
            .open(new DatabaseConfig("primary.invalid", "5432", "cdp", "secret", "cdp",
                "jdbc:postgresql://primary.invalid:5432/cdp", "jdbc:postgresql://replica.invalid:5432/cdp", 10), 1)) {
            assertEquals("jdbc:postgresql://replica.invalid:5432/cdp", repository.dataSource.getJdbcUrl());
            assertEquals("cdp", repository.dataSource.getUsername());
        }
    }

    @Test
    void upsertWritesOnlyColumnsTheTableDefines() throws IOException {
        assertEquals(Set.of(), missingFromSchema(identifiers(UserMetricRepository.upsertQuery().getSQL())));
    }

    @Test
    void upsertReplacesARowOnlyWhenTheStoredBehaviorVersionIsLower() {
        String sql = UserMetricRepository.upsertQuery().getSQL();

        assertTrue(
            sql.endsWith("where \"user_metrics\".\"last_behavior_version\" < excluded.\"last_behavior_version\""),
            sql);
    }

    @Test
    void twoVersionsOfOneRowInABatchWriteTheHigherOne() {
        UserMetric merged = UserMetricRepository.mergeInOrder(row("m_purchase_count", 19), row("m_purchase_count", 20));

        assertEquals(row("m_purchase_count", 20), merged);
    }

    @Test
    void anOlderVersionAfterANewerOneInABatchDoesNotReplaceIt() {
        UserMetric merged = UserMetricRepository.mergeInOrder(row("m_purchase_count", 20), row("m_purchase_count", 19));

        assertEquals(row("m_purchase_count", 20), merged);
    }

    @Test
    void aSecondRowAtTheSameVersionInABatchDoesNotReplaceTheFirst() {
        UserMetric first = row("m_purchase_count", 20);
        UserMetric second = new UserMetric("customer-42", "m_purchase_count", 60_000L, List.of(NEXT_MINUTE),
            20L);

        assertEquals(first, UserMetricRepository.mergeInOrder(first, second));
    }

    @Test
    void rowsOfOnePersonAndMetricShareABatchKey() {
        assertEquals(UserMetricRepository.rowKey(row("m_purchase_count", 19)),
            UserMetricRepository.rowKey(row("m_purchase_count", 20)));
        assertNotEquals(UserMetricRepository.rowKey(row("m_purchase_count", 19)),
            UserMetricRepository.rowKey(row("m_view_count", 19)));
        assertNotEquals(UserMetricRepository.rowKey(row("m_purchase_count", 19)), UserMetricRepository
            .rowKey(new UserMetric("customer-43", "m_purchase_count", 0L, List.of(ONE_MINUTE), 19L)));
    }

    private static UserMetric row(String metricId, long behaviorVersion) {
        return new UserMetric("customer-42", metricId, 0L, List.of(ONE_MINUTE), behaviorVersion);
    }

    @Test
    void selectReadsOnlyColumnsTheTableDefines() throws IOException {
        String sql = UserMetricRepository.selectQuery("customer-42", List.of("m_purchase_count")).getSQL();

        assertEquals(Set.of(), missingFromSchema(identifiers(sql)));
    }

    @Test
    void lastBehaviorVersionReadsOnlyColumnsTheTableDefines() throws IOException {
        String sql = UserMetricRepository.lastBehaviorVersionQuery("customer-42").getSQL();

        assertEquals(Set.of(), missingFromSchema(identifiers(sql)));
        assertTrue(sql.contains("max(\"last_behavior_version\")"), sql);
    }

    @Test
    void failedBehaviorVersionReadFailsInsteadOfReturningZero() {
        try (UserMetricRepository repository = UnreachableDatabase.userMetrics()) {
            RuntimeException failure = assertThrows(RuntimeException.class,
                () -> repository.findLastBehaviorVersion("customer-42"));

            assertTrue(failure.getMessage().contains("customer-42"), failure.getMessage());
        }
    }

    @Test
    void failedSeriesReadFailsInsteadOfReturningNoSeries() {
        try (UserMetricRepository repository = UnreachableDatabase.userMetrics()) {
            RuntimeException failure = assertThrows(RuntimeException.class,
                () -> repository.findMetrics("customer-42", List.of("m_purchase_count")));

            assertTrue(failure.getMessage().contains("customer-42"), failure.getMessage());
        }
    }

    @Test
    void readTimeoutIsFiveSecondsWhenUnset() {
        assertEquals(Duration.ofSeconds(5), UserMetricRepository.readTimeout(null));
        assertEquals(Duration.ofSeconds(5), UserMetricRepository.readTimeout(" "));
    }

    @Test
    void readTimeoutTakesADuration() {
        assertEquals(Duration.ofMillis(1500), UserMetricRepository.readTimeout("1500ms"));
        assertEquals(Duration.ofSeconds(2), UserMetricRepository.readTimeout("2s"));
    }

    @Test
    void readTimeoutBelowTheMinimumIsRaisedTo250Milliseconds() {
        assertEquals(Duration.ofMillis(250), UserMetricRepository.readTimeout("100ms"));
        assertEquals(Duration.ofMillis(250), UserMetricRepository.readTimeout("0"));
    }

    @Test
    void readTimeoutThatIsNotADurationNamesTheVariable() {
        IllegalArgumentException failure = assertThrows(IllegalArgumentException.class,
            () -> UserMetricRepository.readTimeout("five seconds"));

        assertTrue(failure.getMessage().contains("USER_METRICS_READ_TIMEOUT"), failure.getMessage());
    }

    private static Set<String> identifiers(String sql) {
        Set<String> identifiers = QUOTED_IDENTIFIER
            .matcher(ALIAS.matcher(sql).replaceAll(""))
            .results()
            .map(identifier -> identifier.group(1))
            .collect(Collectors.toCollection(LinkedHashSet::new));
        identifiers.remove("user_metrics");
        return identifiers;
    }

    private static Set<String> missingFromSchema(Set<String> columns) throws IOException {
        Set<String> defined = Arrays
            .stream(userMetricsTable().split("(?i)primary key")[0].split("\\n"))
            .map(String::trim)
            .filter(line -> !line.isEmpty())
            .map(line -> line.split("\\s+")[0])
            .collect(Collectors.toSet());
        return columns.stream().filter(column -> !defined.contains(column)).collect(Collectors.toSet());
    }

    private static String userMetricsTable() throws IOException {
        Matcher table = CREATE_TABLE.matcher(Files.readString(SCHEMA_SQL));
        assertTrue(table.find(), "schema.sql has no CREATE TABLE for user_metrics");
        return table.group(1);
    }
}
