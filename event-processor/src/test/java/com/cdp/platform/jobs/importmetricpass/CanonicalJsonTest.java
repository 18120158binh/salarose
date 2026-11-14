package com.cdp.platform.jobs.importmetricpass;

import java.math.BigDecimal;
import java.util.List;

import com.cdp.platform.shared.utils.JacksonMapper;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

/** The RFC 8785 canonical form and the attribute hash (IMP-FR-11). */
class CanonicalJsonTest {

    @Test
    void writesNumbersInEcmaScriptsShortestForm() {
        assertEquals("300", CanonicalJson.number(300));
        assertEquals("300", CanonicalJson.number(300.00));
        assertEquals("300", CanonicalJson.number(3e2));
        assertEquals("0", CanonicalJson.number(-0.0));
        assertEquals("-1.5", CanonicalJson.number(-1.5));
        assertEquals("0.1", CanonicalJson.number(0.1));
        assertEquals("0.000001", CanonicalJson.number(1e-6));
        assertEquals("1e-7", CanonicalJson.number(1e-7));
        assertEquals("1e+21", CanonicalJson.number(1e21));
        assertEquals("100000000000000000000", CanonicalJson.number(1e20));
        assertEquals("12990000", CanonicalJson.number(12990000));
        assertEquals("4.5", CanonicalJson.number(4.5));
        assertEquals("1.7976931348623157e+308", CanonicalJson.number(Double.MAX_VALUE));
        assertEquals("5e-324", CanonicalJson.number(Double.MIN_VALUE));
        assertEquals("333333333.3333333", CanonicalJson.number(333333333.33333333));
    }

    @Test
    void matchesTheRfc8785Example() {
        JsonNode example = JacksonMapper
            .readTree("{\"numbers\":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"
                + "\"string\":\"\\u20ac$\\u000F\\u000aA'\\u0042\\u0022\\u005c\\\\\\\"\\/\","
                + "\"literals\":[null,true,false]}");

        assertEquals("{\"literals\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],"
            + "\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\\\\\"/\"}", CanonicalJson.write(example));
    }

    @Test
    void equalValuesHashEquallyWhateverTheirKeyOrderOrNumberForm() {
        ObjectNode a = JacksonMapper.instance().createObjectNode();
        a.put("spend_90d", 300);
        a.set("emails", AttributeValues.identifiers(List.of("b@x.vn", "a@x.vn")).orElseThrow());
        ObjectNode b = JacksonMapper.instance().createObjectNode();
        b.set("emails", AttributeValues.identifiers(List.of("a@x.vn", "b@x.vn", "a@x.vn")).orElseThrow());
        b.put("spend_90d", new BigDecimal("300.00"));

        assertEquals(CanonicalJson.hash(CanonicalJson.write(a)), CanonicalJson.hash(CanonicalJson.write(b)));
        b.put("spend_90d", 301);
        assertNotEquals(CanonicalJson.hash(CanonicalJson.write(a)), CanonicalJson.hash(CanonicalJson.write(b)));
    }

    @Test
    void sortsKeysByUtf16CodeUnitAtEveryLevel() {
        JsonNode nested = JacksonMapper
            .readTree("{\"b\":{\"z\":1,\"a\":2},\"a\":[{\"y\":1,\"x\":2}],\"\\u00e9\":0,\"Z\":0}");

        assertEquals("{\"Z\":0,\"a\":[{\"x\":2,\"y\":1}],\"b\":{\"a\":2,\"z\":1},\"é\":0}",
            CanonicalJson.write(nested));
    }
}
