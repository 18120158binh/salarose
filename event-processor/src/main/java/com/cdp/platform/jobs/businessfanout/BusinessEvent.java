package com.cdp.platform.jobs.businessfanout;

import java.util.Optional;

import com.cdp.platform.shared.models.node.FieldPredicates;
import com.cdp.platform.shared.models.node.Predicate;
import com.cdp.platform.shared.utils.JacksonMapper;
import com.cdp.platform.shared.utils.JsonAttributeResolver;

import com.fasterxml.jackson.databind.JsonNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * One accepted business event from {@code business-events}. The attributes stay
 * the JSON text they arrived as, so a match carries them unchanged.
 */
public record BusinessEvent(String eventId, String eventName, long eventTime, String itemKey, String attributes) {

    private static final Logger LOG = LoggerFactory.getLogger(BusinessEvent.class);

    /** Separates the event name and the item key in the topic's message key. */
    static final char KEY_SEPARATOR = '\u001F';

    /**
     * The event in a message, or empty when it lacks an id, name, time, or item
     * key. A bad message is logged and dropped, so it never stops the job.
     */
    public static Optional<BusinessEvent> parse(String message) {
        try {
            JsonNode root = JacksonMapper.readTree(message);
            String eventId = text(root, "event_id");
            String eventName = text(root, "event_name");
            String itemKey = text(root, "item_key");
            JsonNode time = root.get("event_time");
            if (eventId == null || eventName == null || itemKey == null || time == null || !time.canConvertToLong()) {
                LOG.warn("Dropping a business event without an id, name, time, or item key");
                return Optional.empty();
            }
            JsonNode attributes = root.get("attributes");
            String attributesJson = attributes == null || !attributes.isObject() ? "{}" : attributes.toString();
            return Optional.of(new BusinessEvent(eventId, eventName, time.asLong(), itemKey, attributesJson));
        } catch (IllegalArgumentException exception) {
            LOG.warn("Dropping a business event that is not JSON: {}", exception.getMessage());
            return Optional.empty();
        }
    }

    /** The topic's key: the event name, U+001F, and the item key. */
    public String key() {
        return eventName + KEY_SEPARATOR + itemKey;
    }

    /** Whether the event passes a trigger's filters, which test its attributes. */
    boolean passes(Predicate filters) {
        return filters == null
            || FieldPredicates.evaluate(filters, field -> JsonAttributeResolver.resolve(attributes, field));
    }

    private static String text(JsonNode root, String field) {
        JsonNode value = root.get(field);
        return value == null || !value.isValueNode() || value.asText().isBlank() ? null : value.asText();
    }
}
