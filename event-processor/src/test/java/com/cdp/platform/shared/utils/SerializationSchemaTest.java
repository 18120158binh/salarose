package com.cdp.platform.shared.utils;

import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import org.junit.jupiter.api.Test;

class SerializationSchemaTest {

    private record Mutation(String canonId, long version) {
    }

    @Test
    void theKeyIsTheExtractedIdInUtf8() {
        KeySerializationSchema<Mutation> keys = new KeySerializationSchema<>(Mutation.class, Mutation::canonId);

        assertArrayEquals("khách-1".getBytes(StandardCharsets.UTF_8), keys.serialize(new Mutation("khách-1", 3)));
    }

    @Test
    void aRecordWithoutAnIdHasNoKey() {
        KeySerializationSchema<Mutation> keys = new KeySerializationSchema<>(Mutation.class, Mutation::canonId);

        assertNull(keys.serialize(new Mutation(null, 3)));
        assertNull(keys.serialize(null));
    }

    @Test
    void theValueIsTheRecordAsJson() {
        byte[] value = new JsonSerializationSchema<>(Mutation.class).serialize(new Mutation("canon-1", 3));

        assertEquals("{\"canonId\":\"canon-1\",\"version\":3}", new String(value, StandardCharsets.UTF_8));
    }
}
