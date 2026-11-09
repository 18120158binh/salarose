package com.cdp.platform.jobs.eventparser.transforms;

import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Decodes raw Snowplow payload fields (ue_px/ue_pr, cx/co) as raw JSON ASTs
 * first. Provides helper methods to derive unstructured event data, schema
 * names, and session identities.
 */
final class SnowplowEventDataExtractor {

    private static final Logger LOG = LoggerFactory.getLogger(SnowplowEventDataExtractor.class);

    private static final String BASIC_CONTEXT = "basic";
    private static final String CLIENT_SESSION_SCHEMA = "iglu:com.snowplowanalytics.snowplow/client_session/";

    private static final Pattern SCHEMA_PATTERN = Pattern.compile("iglu:([^/\\\\]+)\\\\?/([^/\\\\]+)\\\\?/jsonschema");

    private SnowplowEventDataExtractor() {
    }

    /**
     * Holds the raw parsed JSON ASTs decoded directly from payload fields.
     */
    static class RawPayloads {
        final JsonNode unstructured; // Raw JSON AST from ue_px or ue_pr
        private final List<JsonNode> entities; // The context entities from cx or co

        RawPayloads(JsonNode unstructured, JsonNode contexts) {
            this.unstructured = unstructured;
            this.entities = contexts == null ? List.of() : collectEntities(contexts);
        }

        String getSchemaName() {
            if (unstructured == null) return null;
            return schemaName(unstructured.path("data").path("schema").asText(null));
        }

        /**
         * The event data with each entity's data added under its lowercased
         * {@code vendor/name}. The first entity of a name wins, and a key the event
         * data already has is kept. An entity without a valid schema or object data
         * is skipped. Returns the event data unchanged when no entity is added.
         */
        JsonNode withEntities(JsonNode eventData) {
            if (entities.isEmpty()) return eventData;
            if (eventData != null && !eventData.isObject()) return eventData;
            ObjectNode merged = eventData == null
                ? JsonNodeFactory.instance.objectNode()
                : ((ObjectNode) eventData).deepCopy();
            boolean added = false;
            for (JsonNode entity : entities) {
                JsonNode schema = entity.get("schema");
                String key = schema == null || !schema.isTextual() ? null : schemaName(schema.textValue());
                JsonNode data = entity.get("data");
                if (key == null || data == null || !data.isObject()) {
                    LOG.warn("Skipping an entity without a valid schema or object data");
                } else if (merged.has(key)) {
                    LOG.warn("Skipping entity {}: event_json already has that key", key);
                } else {
                    merged.set(key, data.deepCopy());
                    added = true;
                }
            }
            return added ? merged : eventData;
        }

        JsonNode getEventData(LegacyContextPrefix legacyPrefix) {
            if (unstructured != null) {
                JsonNode innerData = unstructured.path("data").path("data");
                if (isObject(innerData)) return innerData;
            }

            // legacy custom event contexts fallback
            ObjectNode basicData = null;
            for (JsonNode entity : entities) {
                if (BASIC_CONTEXT.equals(contextName(legacyPrefix, entity)) && entity.path("data").isObject()) {
                    basicData = ((ObjectNode) entity.path("data")).deepCopy();
                    break;
                }
            }
            if (basicData == null) return null;

            for (JsonNode entity : entities) {
                String contextName = contextName(legacyPrefix, entity);
                JsonNode contextData = entity.path("data");
                if (contextName == null || BASIC_CONTEXT.equals(contextName) || !contextData.isObject()) continue;
                basicData.set(contextName, contextData.deepCopy());
            }
            return basicData;
        }

        /** The {@code userId} of the Snowplow {@code client_session} context. */
        String getSessionUserId() {
            for (JsonNode entity : entities) {
                String schema = entity.path("schema").asText(null);
                if (schema != null && schema.startsWith(CLIENT_SESSION_SCHEMA)) {
                    JsonNode uNode = entity.path("data").get("userId");
                    if (uNode != null && !uNode.isNull()) return uNode.asText();
                }
            }
            return null;
        }
    }

    /**
     * Parses raw fields into a RawPayloads container as they are (ue_px -> ue_pr;
     * cx -> co).
     */
    static RawPayloads parseRaw(ObjectMapper mapper, JsonNode event) {
        JsonNode unstructured = decodeRawField(mapper, event, "ue_px", true);
        if (unstructured == null) unstructured = decodeRawField(mapper, event, "ue_pr", false);

        JsonNode contexts = decodeRawField(mapper, event, "cx", true);
        if (contexts == null) contexts = decodeRawField(mapper, event, "co", false);

        return new RawPayloads(unstructured, contexts);
    }

    private static List<JsonNode> collectEntities(JsonNode parsed) {
        List<JsonNode> entities = new ArrayList<>();
        if (parsed.isArray()) {
            for (JsonNode wrapper : parsed) {
                appendEntities(entities, wrapper);
            }
        } else {
            appendEntities(entities, parsed);
        }
        return entities;
    }

    private static void appendEntities(List<JsonNode> entities, JsonNode wrapper) {
        JsonNode data = wrapper.path("data");
        if (!data.isArray()) return;
        for (JsonNode entity : data) {
            if (entity.isObject()) entities.add(entity);
        }
    }

    private static String schemaName(String schema) {
        if (schema == null) return null;
        Matcher m = SCHEMA_PATTERN.matcher(schema);
        return m.find() ? (m.group(1) + "/" + m.group(2)).toLowerCase(Locale.ROOT) : null;
    }

    private static String contextName(LegacyContextPrefix legacyPrefix, JsonNode entity) {
        JsonNode schemaNode = entity.get("schema");
        return schemaNode == null || !schemaNode.isTextual() ? null : legacyPrefix.contextName(schemaNode.textValue());
    }

    private static JsonNode decodeRawField(ObjectMapper mapper, JsonNode event, String field, boolean isBase64) {
        JsonNode rawNode = event.get(field);
        if (rawNode == null || !rawNode.isTextual()) return null;

        try {
            String raw = rawNode.textValue();
            if (!isBase64) return mapper.readTree(raw);
            // Trackers send either Base64 alphabet, and Snowplow Enrich accepts both.
            // A space is a '+' that a GET query string sent unescaped.
            String urlSafe = raw.replace(' ', '-').replace('+', '-').replace('/', '_');
            return mapper.readTree(Base64.getUrlDecoder().decode(urlSafe));
        } catch (Exception e) {
            // The message can quote the field's content, so log only the exception class.
            LOG.warn("Ignoring {} that does not decode: {}", field, e.getClass().getName());
            return null;
        }
    }

    private static boolean isObject(JsonNode node) {
        return node != null && node.isObject();
    }
}
