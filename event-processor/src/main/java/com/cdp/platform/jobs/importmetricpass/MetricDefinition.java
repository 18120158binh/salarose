package com.cdp.platform.jobs.importmetricpass;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.OptionalInt;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * One row of {@code import_metric_definitions}, parsed once, so the query
 * builder trusts it. A row that breaks the shape studio saves fails to parse,
 * and the pass logs and skips it.
 */
record MetricDefinition(String id, String recordTypeId, String name, Function function, Optional<String> column,
    List<Filter> filters, OptionalInt windowDays, boolean archived) {

    enum Function {
        COUNT, SUM, AVG, MIN, MAX, MEDIAN, DISTINCT_COUNT, LATEST, FIRST_TIME, LAST_TIME;

        boolean readsColumn() {
            return this != COUNT && this != FIRST_TIME && this != LAST_TIME;
        }

        /** Over no values in the window, 0 rather than no value (IMP-FR-06). */
        boolean zeroWhenEmpty() {
            return this == COUNT || this == SUM || this == DISTINCT_COUNT;
        }
    }

    enum Op {
        EQ("="), NE("!="), GT(">"), GE(">="), LT("<"), LE("<=");

        final String sql;

        Op(String sql) {
            this.sql = sql;
        }

        static Op of(String text) {
            for (Op op : values()) {
                if (op.sql.equals(text)) return op;
            }
            throw new IllegalArgumentException("unknown filter operator " + text);
        }
    }

    /** A filter on one column: a number or a string operand. */
    record Filter(String column, Op op, String text, Optional<BigDecimal> number) {
    }

    MetricDefinition {
        filters = List.copyOf(filters);
        if (function.readsColumn() != column.isPresent()) {
            throw new IllegalArgumentException(function + " must " + (function.readsColumn() ? "" : "not ")
                + "name a column");
        }
    }

    static MetricDefinition parse(String id, String recordTypeId, String name, String function, String column,
        JsonNode filters, Integer windowDays, boolean archived) {
        if (filters == null || !filters.isArray()) throw new IllegalArgumentException("filters is not an array");
        List<Filter> parsed = new ArrayList<>();
        for (JsonNode filter : filters) {
            JsonNode filterColumn = filter.path("column");
            JsonNode value = filter.path("value");
            if (!filterColumn.isTextual()) throw new IllegalArgumentException("a filter has no column");
            Optional<BigDecimal> number = value.isNumber() ? Optional.of(value.decimalValue()) : Optional.empty();
            if (!value.isNumber() && !value.isTextual()) throw new IllegalArgumentException("a filter has no value");
            parsed.add(new Filter(filterColumn.asText(), Op.of(filter.path("op").asText()), value.asText(), number));
        }
        if (windowDays != null && windowDays < 1) throw new IllegalArgumentException("window_days is under 1");
        return new MetricDefinition(id, recordTypeId, name, Function.valueOf(function), Optional.ofNullable(column),
            parsed, windowDays == null ? OptionalInt.empty() : OptionalInt.of(windowDays), archived);
    }
}
