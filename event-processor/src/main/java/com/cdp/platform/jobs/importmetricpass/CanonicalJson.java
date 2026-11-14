package com.cdp.platform.jobs.importmetricpass;

import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Iterator;
import java.util.Map;
import java.util.TreeMap;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * The JSON Canonicalization Scheme of RFC 8785, and the attribute hash
 * (IMP-FR-11): object keys sorted by UTF-16 code unit at every level, no
 * spaces, every number as an IEEE 754 double in ECMAScript's shortest form,
 * and strings escaped as {@code JSON.stringify} escapes them.
 */
final class CanonicalJson {

    private CanonicalJson() {
    }

    static String write(JsonNode node) {
        StringBuilder out = new StringBuilder();
        write(node, out);
        return out.toString();
    }

    /** The SHA-256 of the canonical form's UTF-8 bytes, in lowercase hex. */
    static String hash(String canonical) {
        try {
            return HexFormat
                .of()
                .formatHex(MessageDigest.getInstance("SHA-256").digest(canonical.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static void write(JsonNode node, StringBuilder out) {
        if (node.isObject()) {
            Map<String, JsonNode> sorted = new TreeMap<>();
            for (Iterator<Map.Entry<String, JsonNode>> fields = node.fields(); fields.hasNext();) {
                Map.Entry<String, JsonNode> field = fields.next();
                sorted.put(field.getKey(), field.getValue());
            }
            out.append('{');
            boolean first = true;
            for (Map.Entry<String, JsonNode> field : sorted.entrySet()) {
                if (!first) out.append(',');
                first = false;
                string(field.getKey(), out);
                out.append(':');
                write(field.getValue(), out);
            }
            out.append('}');
        } else if (node.isArray()) {
            out.append('[');
            for (int i = 0; i < node.size(); i++) {
                if (i > 0) out.append(',');
                write(node.get(i), out);
            }
            out.append(']');
        } else if (node.isNumber()) {
            out.append(number(node.doubleValue()));
        } else if (node.isTextual()) {
            string(node.textValue(), out);
        } else if (node.isBoolean()) {
            out.append(node.booleanValue());
        } else if (node.isNull() || node.isMissingNode()) {
            out.append("null");
        } else {
            throw new IllegalArgumentException("no canonical form for " + node.getNodeType());
        }
    }

    /**
     * ECMAScript's Number::toString of a finite double. Java 19 and later print
     * the shortest decimal that reads back as the same double, except that they
     * keep two digits where one would do, as in {@code 4.9E-324}, so the digits
     * shrink while they still read back.
     */
    static String number(double value) {
        if (!Double.isFinite(value)) throw new IllegalArgumentException("JSON has no form for " + value);
        if (value == 0) return "0";
        String sign = value < 0 ? "-" : "";
        double magnitude = Math.abs(value);
        BigDecimal decimal = new BigDecimal(Double.toString(magnitude)).stripTrailingZeros();
        while (decimal.precision() > 1) {
            BigDecimal shorter = decimal.round(new MathContext(decimal.precision() - 1, RoundingMode.HALF_EVEN));
            if (shorter.doubleValue() != magnitude) break;
            decimal = shorter.stripTrailingZeros();
        }
        String digits = decimal.unscaledValue().toString();
        int k = digits.length();
        int n = k - decimal.scale();
        if (k <= n && n <= 21) return sign + digits + "0".repeat(n - k);
        if (0 < n && n <= 21) return sign + digits.substring(0, n) + "." + digits.substring(n);
        if (-6 < n && n <= 0) return sign + "0." + "0".repeat(-n) + digits;
        int exponent = n - 1;
        String mantissa = k == 1 ? digits : digits.charAt(0) + "." + digits.substring(1);
        return sign + mantissa + "e" + (exponent < 0 ? "-" : "+") + Math.abs(exponent);
    }

    private static void string(String value, StringBuilder out) {
        out.append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\b' -> out.append("\\b");
                case '\f' -> out.append("\\f");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (c < 0x20) out.append("\\u%04x".formatted((int) c));
                    else out.append(c);
                }
            }
        }
        out.append('"');
    }
}
