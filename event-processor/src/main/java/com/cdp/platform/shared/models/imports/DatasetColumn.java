package com.cdp.platform.shared.models.imports;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * One column of a dataset version, as studio saves it in
 * {@code import_record_type_versions.columns}.
 */
public record DatasetColumn(String name, ColumnType type, boolean pii, List<String> aliases) {

    public enum ColumnType {
        STRING, NUMBER, BOOLEAN, DATETIME, JSON
    }

    public DatasetColumn {
        aliases = List.copyOf(aliases);
    }

    static DatasetColumn parse(JsonNode column) {
        if (column == null || !column.isObject()) throw new IllegalArgumentException("a column is not an object");
        JsonNode name = column.get("name");
        if (name == null || !name.isTextual() || name.asText().isEmpty()) {
            throw new IllegalArgumentException("a column has no name");
        }
        JsonNode type = column.get("type");
        ColumnType parsedType;
        try {
            parsedType = ColumnType.valueOf(type == null ? "" : type.asText().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("column " + name.asText() + " has an unknown type", e);
        }
        List<String> aliases = new ArrayList<>();
        JsonNode list = column.get("aliases");
        if (list != null && list.isArray()) list.forEach(alias -> aliases.add(alias.asText()));
        JsonNode pii = column.get("pii");
        return new DatasetColumn(name.asText(), parsedType, pii != null && pii.asBoolean(), aliases);
    }
}
