package com.cdp.platform.shared.utils;

import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * Resolves custom event attributes from both legacy flattened JSON keys and
 * nested JSON objects. Literal keys take precedence for backward compatibility.
 */
public final class JsonAttributeResolver {

    private JsonAttributeResolver() {
    }

    public static String resolve(String json, String attributePath) {
        if (json == null || json.isBlank() || attributePath == null || attributePath.isBlank()) {
            return null;
        }
        try {
            return resolve(JacksonMapper.instance().readTree(json), attributePath);
        } catch (Exception ignored) {
            return null;
        }
    }

    public static String resolve(JsonNode root, String attributePath) {
        if (root == null || root.isMissingNode() || root.isNull() || attributePath == null || attributePath.isBlank()) {
            return null;
        }

        JsonNode value = node(root, attributePath);
        return value == null ? null : toValue(value);
    }

    /**
     * The JSON value at the path, or null when it is absent: a literal key with
     * the whole path first, then the nested objects.
     */
    public static JsonNode node(JsonNode root, String attributePath) {
        JsonNode literalValue = root.get(attributePath);
        if (literalValue != null) return literalValue;

        JsonNode current = root;
        for (String segment : attributePath.split("\\.")) {
            if (!current.isObject()) {
                return null;
            }
            current = current.get(segment);
            if (current == null) return null;
        }
        return current;
    }

    /**
     * Puts each attribute of a JSON object into the target under a dotted path,
     * with the value that {@link #resolve(String, String)} reads by that path.
     * A leaf that no path reads is left out.
     */
    public static void flattenInto(String json, Map<String, String> target) {
        if (json == null || json.isBlank() || target == null) {
            return;
        }
        try {
            JsonNode root = JacksonMapper.instance().readTree(json);
            if (!root.isObject()) return;
            Set<String> paths = new LinkedHashSet<>();
            root.fields().forEachRemaining(field -> {
                if (field.getKey().contains(".")) paths.add(field.getKey());
                leafPaths(field.getKey(), field.getValue(), paths);
            });
            for (String path : paths) {
                String value = resolve(root, path);
                if (value != null) target.put(path, value);
            }
        } catch (Exception ignored) {
            // Invalid custom properties must not prevent the event from being processed.
        }
    }

    private static void leafPaths(String path, JsonNode value, Set<String> paths) {
        if (!value.isObject()) {
            paths.add(path);
            return;
        }
        value.fields().forEachRemaining(field -> leafPaths(path + "." + field.getKey(), field.getValue(), paths));
    }

    private static String toValue(JsonNode value) {
        if (value == null || value.isNull() || value.isMissingNode()) {
            return null;
        }
        return value.isContainerNode() ? value.toString() : value.asText();
    }
}
