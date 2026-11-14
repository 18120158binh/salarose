package com.cdp.platform.shared.models.imports;

import java.time.DateTimeException;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * One immutable version of a dataset: its columns, the column each role maps
 * to, its delivery mode, time zone, and CSV delimiter. Parsed once from a row
 * of {@code import_record_type_versions} joined to
 * {@code import_record_types}, so code after {@link #parse} trusts it.
 */
public record DatasetVersion(String recordTypeId, int version, Kind kind, List<DatasetColumn> columns,
    Map<Role, List<String>> roles, DeliveryMode deliveryMode, ZoneId timeZone, char delimiter) {

    public enum Kind {
        PROFILE, EVENT
    }

    public enum DeliveryMode {
        INCREMENTAL, SNAPSHOT
    }

    /** The roles of the data import contract, by their stored names. */
    public enum Role {
        CUSTOMER_KEY("customer_key"), RECORD_ID("record_id"), EVENT_TIME("event_time"), UPDATED_AT(
            "updated_at"), DELETED_FLAG("deleted_flag"), EMAIL("email"), PHONE("phone");

        private final String wireName;

        Role(String wireName) {
            this.wireName = wireName;
        }

        public String wireName() {
            return wireName;
        }

        /** The roles a dataset of the kind must map (DIM-FR-03). */
        public boolean requiredFor(Kind kind) {
            return this == CUSTOMER_KEY || kind == Kind.EVENT && (this == RECORD_ID || this == EVENT_TIME);
        }

        boolean repeatable() {
            return this == EMAIL || this == PHONE;
        }
    }

    public DatasetVersion {
        columns = List.copyOf(columns);
        roles = Map.copyOf(roles);
    }

    /**
     * Parses a version.
     *
     * @throws IllegalArgumentException
     *             when a field breaks the shape studio saves
     */
    public static DatasetVersion parse(String recordTypeId, int version, String kind, JsonNode columns,
        JsonNode roles, String deliveryMode, String timeZone, String delimiter) {
        if (columns == null || !columns.isArray()) throw new IllegalArgumentException("columns is not an array");
        Map<String, DatasetColumn> byName = new LinkedHashMap<>();
        for (JsonNode column : columns) {
            DatasetColumn parsed = DatasetColumn.parse(column);
            if (byName.put(parsed.name(), parsed) != null) {
                throw new IllegalArgumentException("column " + parsed.name() + " repeats");
            }
        }
        if (roles == null || !roles.isObject()) throw new IllegalArgumentException("roles is not an object");
        Map<Role, List<String>> mapped = new EnumMap<>(Role.class);
        for (Role role : Role.values()) {
            JsonNode value = roles.get(role.wireName());
            if (value == null || value.isNull()) continue;
            List<String> names = new ArrayList<>();
            if (role.repeatable() && value.isArray()) {
                value.forEach(name -> names.add(name.asText()));
            } else if (value.isTextual()) {
                names.add(value.asText());
            } else {
                throw new IllegalArgumentException("role " + role.wireName() + " has no column name");
            }
            for (String name : names) {
                if (!byName.containsKey(name)) {
                    throw new IllegalArgumentException("role " + role.wireName() + " names no column");
                }
            }
            if (!names.isEmpty()) mapped.put(role, List.copyOf(names));
        }
        Kind parsedKind = enumOf(Kind.class, kind, "kind");
        for (Role role : Role.values()) {
            if (role.requiredFor(parsedKind) && !mapped.containsKey(role)) {
                throw new IllegalArgumentException("role " + role.wireName() + " is not mapped");
            }
        }
        if (delimiter == null || delimiter.length() != 1 || ",;".indexOf(delimiter.charAt(0)) < 0) {
            throw new IllegalArgumentException("delimiter is not , or ;");
        }
        ZoneId zone;
        try {
            zone = ZoneId.of(timeZone);
        } catch (DateTimeException | NullPointerException e) {
            throw new IllegalArgumentException("time zone is not an IANA zone", e);
        }
        return new DatasetVersion(recordTypeId, version, parsedKind, List.copyOf(byName.values()), mapped,
            enumOf(DeliveryMode.class, deliveryMode, "delivery mode"), zone, delimiter.charAt(0));
    }

    private static <E extends Enum<E>> E enumOf(Class<E> type, String value, String field) {
        for (E constant : type.getEnumConstants()) {
            if (constant.name().equalsIgnoreCase(value)) return constant;
        }
        throw new IllegalArgumentException(field + " is not known: " + value);
    }

    /** The one column a single role maps to. */
    public Optional<String> column(Role role) {
        List<String> names = roles.get(role);
        return names == null ? Optional.empty() : Optional.of(names.get(0));
    }

    /** Every column a role maps to, for email and phone. */
    public List<String> columnsOf(Role role) {
        return roles.getOrDefault(role, List.of());
    }

    /**
     * An ordered type waits behind a held run: a snapshot type, or an incremental
     * type that maps no {@code updated_at}.
     */
    public boolean ordered() {
        return deliveryMode == DeliveryMode.SNAPSHOT || !roles.containsKey(Role.UPDATED_AT);
    }
}
