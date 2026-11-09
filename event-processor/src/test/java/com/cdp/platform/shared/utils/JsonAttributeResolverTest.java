package com.cdp.platform.shared.utils;

import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import org.junit.jupiter.api.Test;

class JsonAttributeResolverTest {

    @Test
    void aNestedAttributeResolvesByItsDottedPath() {
        assertEquals("Hanoi", JsonAttributeResolver.resolve("{\"address\":{\"city\":\"Hanoi\"}}", "address.city"));
    }

    @Test
    void aLiteralDottedKeyWinsOverTheNestedObject() {
        String json = "{\"address.city\":\"Saigon\",\"address\":{\"city\":\"Hanoi\"}}";

        assertEquals("Saigon", JsonAttributeResolver.resolve(json, "address.city"));
    }

    @Test
    void scalarsResolveAsTextAndContainersAsJson() {
        String json = "{\"price\":12.5,\"paid\":true,\"items\":[1,2],\"cart\":{\"size\":2}}";

        assertEquals("12.5", JsonAttributeResolver.resolve(json, "price"));
        assertEquals("true", JsonAttributeResolver.resolve(json, "paid"));
        assertEquals("[1,2]", JsonAttributeResolver.resolve(json, "items"));
        assertEquals("{\"size\":2}", JsonAttributeResolver.resolve(json, "cart"));
    }

    @Test
    void aMissingNullOrUnreadableAttributeResolvesToNull() {
        assertNull(JsonAttributeResolver.resolve("{\"a\":{\"b\":1}}", "a.c"));
        assertNull(JsonAttributeResolver.resolve("{\"a\":1}", "a.b"));
        assertNull(JsonAttributeResolver.resolve("{\"a\":null}", "a"));
        assertNull(JsonAttributeResolver.resolve("{not json", "a"));
        assertNull(JsonAttributeResolver.resolve("{\"a\":1}", " "));
        assertNull(JsonAttributeResolver.resolve((String) null, "a"));
    }

    @Test
    void flatteningWritesEveryLeafUnderItsPathAndALiteralDottedKeyWinsOverTheNestedPath() {
        Map<String, String> target = new HashMap<>();

        JsonAttributeResolver
            .flattenInto("{\"plan\":\"pro\",\"cart\":{\"size\":2,\"total\":null},\"cart.size\":3,\"tags\":[\"a\"]}",
                target);

        assertEquals(Map.of("plan", "pro", "cart.size", "3", "tags", "[\"a\"]"), target);
    }

    @Test
    void everyFlattenedKeyResolvesToItsFlattenedValue() {
        Map<String, Map<String, String>> expected = Map
            .of("{\"a\":{\"b.c\":1,\"b\":{\"c\":2}}}", Map.of("a.b.c", "2"),
                "{\"product\":{\"price.usd\":10}}", Map.of(),
                "{\"a.b\":{\"c\":1}}", Map.of("a.b", "{\"c\":1}"),
                "{\"plan\":\"y\",\"\":{\"plan\":\"x\"}}", Map.of("plan", "y", ".plan", "x"));

        expected.forEach((json, flattened) -> {
            Map<String, String> target = new HashMap<>();

            JsonAttributeResolver.flattenInto(json, target);

            assertEquals(flattened, target, json);
            target.forEach((key, value) -> assertEquals(value, JsonAttributeResolver.resolve(json, key), json));
        });
    }

    @Test
    void propertiesThatAreNotAnObjectFlattenToNothing() {
        Map<String, String> target = new HashMap<>();

        JsonAttributeResolver.flattenInto("[1]", target);
        JsonAttributeResolver.flattenInto("5", target);
        JsonAttributeResolver.flattenInto("{\"plan\":\"pro\"}", target);

        assertEquals(Map.of("plan", "pro"), target);
    }

    @Test
    void unreadablePropertiesFlattenToNothing() {
        Map<String, String> target = new HashMap<>();

        JsonAttributeResolver.flattenInto("{not json", target);

        assertEquals(Map.of(), target);
    }
}
