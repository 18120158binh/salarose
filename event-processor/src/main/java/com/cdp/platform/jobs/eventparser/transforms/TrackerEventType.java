package com.cdp.platform.jobs.eventparser.transforms;

import java.math.BigDecimal;
import java.util.List;
import java.util.Locale;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * The Snowplow event types whose name and {@code event_json} come from their
 * own
 * tracker fields rather than from a self-describing event.
 */
enum TrackerEventType {
    STRUCTURED("se", null, List
        .of(new Field("se_ca", "category", false), new Field("se_ac", "action", false),
            new Field("se_la", "label", false), new Field("se_pr", "property", false),
            new Field("se_va", "value", true))), TRANSACTION("tr", "transaction",
                List
                    .of(new Field("tr_id", "order_id", false), new Field("tr_af", "affiliation", false),
                        new Field("tr_tt", "total", true), new Field("tr_tx", "tax", true),
                        new Field("tr_sh", "shipping", true), new Field("tr_ci", "city", false),
                        new Field("tr_st", "state", false), new Field("tr_co", "country", false),
                        new Field("tr_cu", "currency", false))), TRANSACTION_ITEM("ti", "transaction_item",
                            List
                                .of(new Field("ti_id", "order_id", false), new Field("ti_sk", "sku", false),
                                    new Field("ti_nm", "name", false), new Field("ti_ca", "category", false),
                                    new Field("ti_pr", "price", true), new Field("ti_qu", "quantity", true),
                                    new Field("ti_cu", "currency", false)));

    private final String code;
    private final String eventName;
    private final List<Field> fields;

    TrackerEventType(String code, String eventName, List<Field> fields) {
        this.code = code;
        this.eventName = eventName;
        this.fields = fields;
    }

    /** The type for the tracker's {@code e} code, or null for any other code. */
    static TrackerEventType of(String code) {
        for (TrackerEventType type : values()) {
            if (type.code.equals(code)) return type;
        }
        return null;
    }

    /**
     * The event's name: its fixed name, or a structured event's lowercased
     * action. Null for a structured event without an action.
     */
    String eventName(ObjectNode eventJson) {
        if (eventName != null) return eventName;
        JsonNode action = eventJson.get("action");
        return action == null ? null : action.asText().toLowerCase(Locale.ROOT);
    }

    /**
     * The event's fields under their {@code event_json} names. An absent or empty
     * field is left out. A numeric field that does not parse stays a string, so
     * a schema gate on the event can reject it.
     */
    ObjectNode eventJson(ObjectMapper mapper, JsonNode event) {
        ObjectNode json = mapper.createObjectNode();
        for (Field field : fields) {
            JsonNode value = event.get(field.param());
            if (value == null || value.isNull() || value.asText().isEmpty()) continue;
            String text = value.asText();
            BigDecimal number = field.numeric() ? parseNumber(text) : null;
            if (number != null) {
                json.put(field.name(), number);
            } else {
                json.put(field.name(), text);
            }
        }
        return json;
    }

    private static BigDecimal parseNumber(String text) {
        try {
            return new BigDecimal(text.trim());
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    private record Field(String param, String name, boolean numeric) {
    }
}
