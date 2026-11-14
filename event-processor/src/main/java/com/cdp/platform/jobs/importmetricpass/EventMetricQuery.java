package com.cdp.platform.jobs.importmetricpass;

import java.math.BigDecimal;
import java.time.DateTimeException;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.function.Function;
import java.util.stream.Collectors;

import com.cdp.platform.jobs.importmetricpass.MetricDefinition.Filter;
import com.cdp.platform.jobs.importmetricpass.MetricDefinition.Op;
import com.cdp.platform.shared.models.imports.DatasetColumn;
import com.cdp.platform.shared.models.imports.DatasetColumn.ColumnType;
import com.cdp.platform.shared.models.imports.DatasetVersion;

/**
 * The one grouped query over an event dataset's records that computes every
 * metric of it that is not archived (IMP-FR-05, IMP-FR-06), exactly, in SQL.
 * It groups every record of the type by {@code customer_key}, so every
 * customer with a record gets a row, and each metric aggregates only the
 * records in its window that pass its filters. The window is
 * ({@code as_of} minus N times 86,400 seconds, {@code as_of}]. Column names
 * and operands go in as parameters.
 */
record EventMetricQuery(String sql, List<Object> parameters, List<Output> outputs) {

    /** A metric's result column, and the dataset column it reads, if any. */
    record Output(MetricDefinition definition, Optional<ColumnType> columnType) {
    }

    static final String TABLE = "import_records";

    /**
     * Builds the query. A definition that names a column, in its function or a
     * filter, that the version lacks gives no value, so it gets no output and
     * goes in {@code unusable}.
     */
    static EventMetricQuery build(DatasetVersion version, List<MetricDefinition> active, Instant asOf,
        List<MetricDefinition> unusable) {
        Map<String, DatasetColumn> columns = version
            .columns()
            .stream()
            .collect(Collectors.toMap(DatasetColumn::name, Function.identity()));
        Sql sql = new Sql();
        sql.text("SELECT customer_key");
        List<Output> outputs = new ArrayList<>();
        for (MetricDefinition definition : active) {
            boolean known = definition.column().map(columns::containsKey).orElse(true)
                && definition.filters().stream().allMatch(filter -> columns.containsKey(filter.column()));
            if (!known) {
                unusable.add(definition);
                continue;
            }
            Optional<DatasetColumn> column = definition.column().map(columns::get);
            sql.text(", ");
            aggregate(sql, definition, column, columns, asOf);
            outputs.add(new Output(definition, column.map(DatasetColumn::type)));
        }
        sql.text(" FROM " + TABLE + " WHERE record_type_id = ?::uuid GROUP BY customer_key");
        sql.parameters.add(version.recordTypeId());
        return new EventMetricQuery(sql.out.toString(), List.copyOf(sql.parameters), List.copyOf(outputs));
    }

    private static void aggregate(Sql sql, MetricDefinition definition, Optional<DatasetColumn> column,
        Map<String, DatasetColumn> columns, Instant asOf) {
        switch (definition.function()) {
            case COUNT -> {
                sql.text("count(*) FILTER (WHERE ");
                condition(sql, definition, columns, asOf);
                sql.text(")");
            }
            case SUM, AVG, MIN, MAX -> {
                String function = definition.function().name().toLowerCase(Locale.ROOT);
                if (definition.function() == MetricDefinition.Function.SUM) sql.text("coalesce(");
                sql.text(function + "(");
                number(sql, column.orElseThrow().name());
                sql.text(") FILTER (WHERE ");
                condition(sql, definition, columns, asOf);
                sql.text(")");
                if (definition.function() == MetricDefinition.Function.SUM) sql.text(", 0)");
            }
            case MEDIAN -> {
                sql.text("percentile_cont(0.5) WITHIN GROUP (ORDER BY ");
                number(sql, column.orElseThrow().name());
                sql.text("::float8) FILTER (WHERE ");
                condition(sql, definition, columns, asOf);
                sql.text(")");
            }
            case DISTINCT_COUNT -> {
                sql.text("count(DISTINCT data -> ?::text) FILTER (WHERE ");
                sql.parameters.add(column.orElseThrow().name());
                present(sql, column.orElseThrow().name());
                sql.text(" AND ");
                condition(sql, definition, columns, asOf);
                sql.text(")");
            }
            case LATEST -> {
                sql.text("((array_agg(data -> ?::text ORDER BY event_time DESC, record_id DESC) FILTER (WHERE ");
                sql.parameters.add(column.orElseThrow().name());
                present(sql, column.orElseThrow().name());
                sql.text(" AND ");
                condition(sql, definition, columns, asOf);
                sql.text("))[1])::text");
            }
            case FIRST_TIME, LAST_TIME -> {
                sql.text(definition.function() == MetricDefinition.Function.FIRST_TIME ? "min" : "max");
                sql.text("(event_time) FILTER (WHERE ");
                condition(sql, definition, columns, asOf);
                sql.text(")");
            }
        }
    }

    /** The window, then each filter. */
    private static void condition(Sql sql, MetricDefinition definition, Map<String, DatasetColumn> columns,
        Instant asOf) {
        sql.text("event_time <= ?");
        sql.parameters.add(asOf.atOffset(ZoneOffset.UTC));
        if (definition.windowDays().isPresent()) {
            sql.text(" AND event_time > ?");
            sql.parameters
                .add(asOf.minus(Duration.ofDays(definition.windowDays().getAsInt())).atOffset(ZoneOffset.UTC));
        }
        for (Filter filter : definition.filters()) {
            sql.text(" AND ");
            filter(sql, filter, columns.get(filter.column()).type());
        }
    }

    /**
     * A number column compares as a number, a datetime column as an instant by
     * customer decision's datetime rules, and every other column as text for
     * {@code =} and {@code !=}. A comparison those rules do not define, or a
     * record with no value, is false.
     */
    static void filter(Sql sql, Filter filter, ColumnType type) {
        switch (type) {
            case NUMBER -> {
                Optional<BigDecimal> operand = filter.number().or(() -> decimal(filter.text()));
                if (operand.isEmpty()) {
                    sql.text("false");
                    return;
                }
                number(sql, filter.column());
                sql.text(" " + filter.op().sql + " ?");
                sql.parameters.add(operand.get());
            }
            case DATETIME -> {
                Optional<Bound> bound = bound(filter.op(), filter.text());
                if (bound.isEmpty()) {
                    text(sql, filter);
                    return;
                }
                sql.text("(data ->> ?::text)::timestamptz " + bound.get().op().sql + " ?");
                sql.parameters.add(filter.column());
                sql.parameters.add(bound.get().at().atOffset(ZoneOffset.UTC));
            }
            default -> text(sql, filter);
        }
    }

    private static void text(Sql sql, Filter filter) {
        if (filter.op() != Op.EQ && filter.op() != Op.NE) {
            sql.text("false");
            return;
        }
        sql.text("(data ->> ?::text) " + filter.op().sql + " ?");
        sql.parameters.add(filter.column());
        sql.parameters.add(filter.text());
    }

    /** An instant comparison, after a date alone becomes a bound in UTC. */
    record Bound(Op op, Instant at) {
    }

    /**
     * Customer decision's datetime rules for a right-hand side: a datetime with
     * an offset is that instant, one without is UTC, and a date alone is its whole
     * day in UTC. Empty for {@code =} and {@code !=}, which compare text, and for
     * a value that does not parse.
     */
    static Optional<Bound> bound(Op op, String value) {
        if (op == Op.EQ || op == Op.NE) return Optional.empty();
        try {
            return Optional.of(new Bound(op, OffsetDateTime.parse(value).toInstant()));
        } catch (DateTimeException ignored) {
            // Not a datetime with an offset.
        }
        try {
            return Optional.of(new Bound(op, LocalDateTime.parse(value).toInstant(ZoneOffset.UTC)));
        } catch (DateTimeException ignored) {
            // Not a datetime without an offset.
        }
        try {
            LocalDate date = LocalDate.parse(value);
            Instant start = date.atStartOfDay(ZoneOffset.UTC).toInstant();
            Instant next = date.plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant();
            return Optional.of(switch (op) {
                case GT -> new Bound(Op.GE, next);
                case GE -> new Bound(Op.GE, start);
                case LT -> new Bound(Op.LT, start);
                case LE -> new Bound(Op.LT, next);
                default -> throw new IllegalStateException(op.sql);
            });
        } catch (DateTimeException ignored) {
            return Optional.empty();
        }
    }

    private static Optional<BigDecimal> decimal(String text) {
        try {
            return Optional.of(new BigDecimal(text.trim()));
        } catch (NumberFormatException e) {
            return Optional.empty();
        }
    }

    /** The column as {@code numeric}, or SQL null when it holds no number. */
    private static void number(Sql sql, String column) {
        sql.text("(CASE WHEN jsonb_typeof(data -> ?::text) = 'number' THEN (data ->> ?::text)::numeric END)");
        sql.parameters.add(column);
        sql.parameters.add(column);
    }

    private static void present(Sql sql, String column) {
        sql.text("coalesce(jsonb_typeof(data -> ?::text), 'null') <> 'null'");
        sql.parameters.add(column);
    }

    /** SQL text and its parameters, appended in the order they appear. */
    static final class Sql {
        final StringBuilder out = new StringBuilder();
        final List<Object> parameters = new ArrayList<>();

        void text(String text) {
            out.append(text);
        }
    }
}
