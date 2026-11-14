package com.cdp.platform.jobs.importmetricpass;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import com.cdp.platform.jobs.importmetricpass.MetricDefinition.Op;
import com.cdp.platform.shared.models.imports.DatasetColumn.ColumnType;
import com.cdp.platform.shared.models.imports.DatasetVersion;
import com.cdp.platform.shared.utils.JacksonMapper;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * The SQL of one event dataset's metrics (IMP-FR-05, IMP-FR-06). The text and
 * parameter order are what this test can see without a Postgres. The
 * statements run against Postgres only on a cluster.
 */
class EventMetricQueryTest {

    static final String ORDERS = "11111111-1111-1111-1111-111111111111";
    static final Instant AS_OF = Instant.parse("2026-11-07T20:00:00Z");

    static DatasetVersion orders() {
        return DatasetVersion
            .parse(ORDERS, 1, "event",
                JacksonMapper
                    .readTree(
                        "[{\"name\":\"order_id\",\"type\":\"string\"},{\"name\":\"customer_id\",\"type\":\"string\"},"
                            + "{\"name\":\"ordered_at\",\"type\":\"datetime\"},{\"name\":\"total\",\"type\":\"number\"},"
                            + "{\"name\":\"status\",\"type\":\"string\"}]"),
                JacksonMapper
                    .readTree(
                        "{\"customer_key\":\"customer_id\",\"record_id\":\"order_id\",\"event_time\":\"ordered_at\"}"),
                "incremental", "Asia/Ho_Chi_Minh", ",");
    }

    static MetricDefinition definition(String name, String function, String column, String filters, Integer window) {
        return MetricDefinition
            .parse(name + "-id", ORDERS, name, function, column, JacksonMapper.readTree(filters), window, false);
    }

    @Test
    void sumsOverTheWindowWithItsFiltersAndGroupsEveryRecord() {
        List<MetricDefinition> unusable = new ArrayList<>();
        EventMetricQuery query = EventMetricQuery
            .build(orders(),
                List
                    .of(definition("spend_90d", "SUM", "total",
                        "[{\"column\":\"status\",\"op\":\"=\",\"value\":\"completed\"}]",
                        90)),
                AS_OF, unusable);

        assertEquals("SELECT customer_key, coalesce(sum((CASE WHEN jsonb_typeof(data -> ?::text) = 'number' "
            + "THEN (data ->> ?::text)::numeric END)) FILTER (WHERE event_time <= ? AND event_time > ? "
            + "AND (data ->> ?::text) = ?), 0) FROM import_records WHERE record_type_id = ?::uuid GROUP BY customer_key",
            query.sql());
        assertEquals(List
            .of("total", "total", AS_OF.atOffset(ZoneOffset.UTC),
                OffsetDateTime.parse("2026-08-09T20:00:00Z"), "status", "completed", ORDERS),
            query.parameters());
        assertEquals(List.of(), unusable);
    }

    @Test
    void countsWithoutAColumnAndWithoutAWindowUpToAsOf() {
        EventMetricQuery query = EventMetricQuery
            .build(orders(), List.of(definition("orders_all", "COUNT", null, "[]", null)), AS_OF, new ArrayList<>());

        assertTrue(query.sql().contains("count(*) FILTER (WHERE event_time <= ?)"), query.sql());
        assertEquals(List.of(AS_OF.atOffset(ZoneOffset.UTC), ORDERS), query.parameters());
    }

    @Test
    void takesTheLatestValueByEventTimeThenRecordId() {
        EventMetricQuery query = EventMetricQuery
            .build(orders(), List.of(definition("last_status", "LATEST", "status", "[]", null)), AS_OF,
                new ArrayList<>());

        assertTrue(query.sql().contains("array_agg(data -> ?::text ORDER BY event_time DESC, record_id DESC)"),
            query.sql());
        assertEquals(Optional.of(ColumnType.STRING), query.outputs().getFirst().columnType());
    }

    @Test
    void aDefinitionNamingAMissingColumnHasNoOutput() {
        List<MetricDefinition> unusable = new ArrayList<>();
        MetricDefinition gone = definition("discount_sum", "SUM", "discount", "[]", 30);
        MetricDefinition goneFilter = definition("n", "COUNT", null,
            "[{\"column\":\"channel\",\"op\":\"=\",\"value\":\"web\"}]", 30);

        EventMetricQuery query = EventMetricQuery.build(orders(), List.of(gone, goneFilter), AS_OF, unusable);

        assertEquals(List.of(gone, goneFilter), unusable);
        assertEquals(List.of(), query.outputs());
        assertEquals("SELECT customer_key FROM import_records WHERE record_type_id = ?::uuid GROUP BY customer_key",
            query.sql());
    }

    @Test
    void comparesANumberColumnAsANumber() {
        EventMetricQuery.Sql sql = new EventMetricQuery.Sql();
        EventMetricQuery
            .filter(sql, new MetricDefinition.Filter("total", Op.GE, "100", Optional.of(new BigDecimal("100"))),
                ColumnType.NUMBER);

        assertTrue(sql.out.toString().endsWith("::numeric END) >= ?"), sql.out.toString());
        assertEquals(new BigDecimal("100"), sql.parameters.getLast());
    }

    @Test
    void anOrderingOnAStringColumnIsFalse() {
        EventMetricQuery.Sql sql = new EventMetricQuery.Sql();
        EventMetricQuery
            .filter(sql, new MetricDefinition.Filter("status", Op.GT, "a", Optional.empty()), ColumnType.STRING);

        assertEquals("false", sql.out.toString());
    }

    @Test
    void aDateAloneBoundsItsWholeDayInUtc() {
        Instant start = Instant.parse("2026-10-01T00:00:00Z");
        Instant next = Instant.parse("2026-10-02T00:00:00Z");

        assertEquals(new EventMetricQuery.Bound(Op.GE, next),
            EventMetricQuery.bound(Op.GT, "2026-10-01").orElseThrow());
        assertEquals(new EventMetricQuery.Bound(Op.GE, start),
            EventMetricQuery.bound(Op.GE, "2026-10-01").orElseThrow());
        assertEquals(new EventMetricQuery.Bound(Op.LT, start),
            EventMetricQuery.bound(Op.LT, "2026-10-01").orElseThrow());
        assertEquals(new EventMetricQuery.Bound(Op.LT, next),
            EventMetricQuery.bound(Op.LE, "2026-10-01").orElseThrow());
        assertEquals(Instant.parse("2026-10-01T02:00:00Z"),
            EventMetricQuery.bound(Op.GT, "2026-10-01T09:00:00+07:00").orElseThrow().at());
        assertEquals(Instant.parse("2026-10-01T09:00:00Z"),
            EventMetricQuery.bound(Op.GT, "2026-10-01T09:00:00").orElseThrow().at());
        assertEquals(Optional.empty(), EventMetricQuery.bound(Op.GT, "2026-10-01 09:00"));
    }
}
