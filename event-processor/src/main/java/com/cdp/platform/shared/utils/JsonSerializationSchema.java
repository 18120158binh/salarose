package com.cdp.platform.shared.utils;

import org.apache.flink.api.common.serialization.SerializationSchema;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.java.typeutils.ResultTypeQueryable;

/**
 * Standard, library-compatible JSON serialization schema for Flink sinks.
 * Implements {@link ResultTypeQueryable} to guarantee full Flink TypeExtractor
 * compatibility
 * across all Flink 1.x and 2.x runtimes.
 */
public final class JsonSerializationSchema<T> implements SerializationSchema<T>, ResultTypeQueryable<T> {

    private final Class<T> type;

    public JsonSerializationSchema(Class<T> type) {
        this.type = type;
    }

    @Override
    public byte[] serialize(T element) {
        return JacksonMapper.writeValueAsBytes(element);
    }

    @Override
    public TypeInformation<T> getProducedType() {
        return TypeInformation.of(type);
    }
}
