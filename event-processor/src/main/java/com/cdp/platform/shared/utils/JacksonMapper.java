package com.cdp.platform.shared.utils;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * Provides the consistently configured Jackson mapper used by event processor
 * jobs and payload contracts.
 */
public final class JacksonMapper {

    private static final ObjectMapper INSTANCE = new ObjectMapper();

    private JacksonMapper() {
    }

    public static ObjectMapper instance() {
        return INSTANCE;
    }

    public static byte[] writeValueAsBytes(Object value) {
        try {
            return INSTANCE.writeValueAsBytes(value);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException("Cannot serialize value as JSON", exception);
        }
    }

    public static String writeValueAsString(Object value) {
        try {
            return INSTANCE.writeValueAsString(value);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException("Cannot serialize value as JSON", exception);
        }
    }

    public static <T> T readValue(String json, Class<T> valueType) {
        try {
            return INSTANCE.readValue(json, valueType);
        } catch (JsonProcessingException exception) {
            throw new IllegalArgumentException("Cannot deserialize JSON as " + valueType.getSimpleName(), exception);
        }
    }

    public static JsonNode readTree(String json) {
        try {
            return INSTANCE.readTree(json);
        } catch (JsonProcessingException exception) {
            throw new IllegalArgumentException("Cannot parse JSON tree", exception);
        }
    }

    public static <T> T treeToValue(JsonNode node, Class<T> valueType) {
        try {
            return INSTANCE.treeToValue(node, valueType);
        } catch (JsonProcessingException exception) {
            throw new IllegalArgumentException("Cannot map JSON tree as " + valueType.getSimpleName(), exception);
        }
    }
}
