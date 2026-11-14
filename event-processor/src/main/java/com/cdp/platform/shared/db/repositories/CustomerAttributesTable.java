package com.cdp.platform.shared.db.repositories;

import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Pattern;

import com.cdp.platform.shared.utils.JacksonMapper;

import com.fasterxml.jackson.databind.JsonNode;
import org.jooq.Field;
import org.jooq.Table;
import org.jooq.impl.DSL;

/**
 * The table {@code customer_attributes} in the main Postgres: the import
 * metric pass's per-customer results, one row per customer and imported
 * source. The pass is the only writer. Default replica identity and in no
 * publication (IMP-NFR-04).
 */
public final class CustomerAttributesTable {

    public static final String TABLE_NAME = "customer_attributes";

    public static final String CUSTOMER_KEY = "customer_key";
    public static final String SOURCE_ID = "source_id";
    public static final String ATTRIBUTES = "attributes";
    public static final String ATTRIBUTES_HASH = "attributes_hash";
    public static final String PASS_ID = "pass_id";
    public static final String UPDATED_AT = "updated_at";

    /** Every column, in the order of the {@code CREATE TABLE}. */
    public static final List<String> COLUMNS = List
        .of(CUSTOMER_KEY, SOURCE_ID, ATTRIBUTES, ATTRIBUTES_HASH, PASS_ID, UPDATED_AT);

    /**
     * The column of a profile lookup that holds the imported attributes it read,
     * as one JSON object keyed by source.
     */
    static final String IMPORTED = "imported";

    private static final String PROFILE_PREFIX = "profile.";
    private static final Pattern SOURCE_ID_PATTERN = Pattern.compile("[a-z][a-z0-9_]*");
    private static final String ALIAS = "a";
    private static final Table<?> TABLE = DSL.table(DSL.name(TABLE_NAME)).as(ALIAS);
    private static final Field<String> CUSTOMER_KEY_FIELD = DSL.field(DSL.name(ALIAS, CUSTOMER_KEY), String.class);
    private static final Field<String> SOURCE_ID_FIELD = DSL.field(DSL.name(ALIAS, SOURCE_ID), String.class);
    private static final Field<Object> ATTRIBUTES_FIELD = DSL.field(DSL.name(ALIAS, ATTRIBUTES));

    private CustomerAttributesTable() {
    }

    /**
     * The source that a {@code profile_property} field names when it is an
     * imported field: {@code orders} for {@code profile.orders.spend_90d}. The
     * field splits at its first dot after the prefix, and the source must be a
     * valid {@code source_id} with a name after it. A built-in field names no
     * source.
     */
    public static Optional<String> sourceOf(String field) {
        if (field == null || !field.startsWith(PROFILE_PREFIX)) return Optional.empty();
        String imported = field.substring(PROFILE_PREFIX.length());
        int dot = imported.indexOf('.');
        if (dot < 0 || dot == imported.length() - 1) return Optional.empty();
        String source = imported.substring(0, dot);
        return SOURCE_ID_PATTERN.matcher(source).matches() ? Optional.of(source) : Optional.empty();
    }

    /**
     * A scalar subquery for the {@code attributes} of the given sources'
     * rows whose {@code customer_key} is {@code customerKey}, as one JSON
     * object keyed by source, or null when there is no such row. The sources are
     * valid {@code source_id}s and inlined.
     */
    static Field<String> importedOf(Field<String> customerKey, Collection<String> sources) {
        return DSL
            .field(DSL
                .select(DSL
                    .field("cast(jsonb_object_agg({0}, {1}) as text)", String.class, SOURCE_ID_FIELD,
                        ATTRIBUTES_FIELD))
                .from(TABLE)
                .where(CUSTOMER_KEY_FIELD.eq(customerKey))
                .and(SOURCE_ID_FIELD.in(sources.stream().map(DSL::inline).toList())))
            .as(IMPORTED);
    }

    /**
     * The imported fields in an {@link #importedOf} value, keyed
     * {@code <source>.<name>}. A string is its text, a number or a boolean its
     * JSON text, and an object or array its JSON. A JSON null is no value.
     */
    static Map<String, String> fields(String imported) {
        Map<String, String> fields = new HashMap<>();
        if (imported == null) return fields;
        JsonNode bySource = JacksonMapper.readTree(imported);
        bySource.properties().forEach(source -> source.getValue().properties().forEach(attribute -> {
            JsonNode value = attribute.getValue();
            if (value.isNull()) return;
            fields
                .put(source.getKey() + "." + attribute.getKey(), value.isValueNode()
                    ? value.asText()
                    : value
                        .toString());
        }));
        return fields;
    }
}
