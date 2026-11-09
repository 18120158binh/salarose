package com.cdp.platform.shared.utils;

import java.io.Serializable;
import java.nio.charset.StandardCharsets;

import org.apache.flink.api.common.serialization.SerializationSchema;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.java.typeutils.ResultTypeQueryable;

/**
 * Standard, library-compatible Key serialization schema for Flink Kafka sinks.
 * Implements {@link ResultTypeQueryable} to guarantee full Flink TypeExtractor
 * compatibility
 * across all Flink 1.x and 2.x runtimes.
 */
public final class KeySerializationSchema<T> implements SerializationSchema<T>, ResultTypeQueryable<T> {

    @FunctionalInterface
    public interface KeyExtractor<T> extends Serializable {
        String extractKey(T element);
    }

    private final Class<T> type;
    private final KeyExtractor<T> keyExtractor;

    public KeySerializationSchema(Class<T> type, KeyExtractor<T> keyExtractor) {
        this.type = type;
        this.keyExtractor = keyExtractor;
    }

    @Override
    public byte[] serialize(T element) {
        if (element == null || keyExtractor == null) return null;
        String key = keyExtractor.extractKey(element);
        return key != null ? key.getBytes(StandardCharsets.UTF_8) : null;
    }

    @Override
    public TypeInformation<T> getProducedType() {
        return TypeInformation.of(type);
    }
}
