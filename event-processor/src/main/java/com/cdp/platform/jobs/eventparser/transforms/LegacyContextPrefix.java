package com.cdp.platform.jobs.eventparser.transforms;

import java.io.Serializable;

/**
 * The schema prefix of the contexts that a legacy {@code basic} context nests
 * under their names, such as {@code iglu:com.example.snowplow/}.
 */
public final class LegacyContextPrefix implements Serializable {

    public static final String VARIABLE = "SNOWPLOW_LEGACY_CONTEXT_SCHEMA_PREFIX";
    static final LegacyContextPrefix DEFAULT = new LegacyContextPrefix("iglu:com.example.snowplow/");

    private static final String JSON_SCHEMA_MARKER = "/jsonschema/";

    private final String prefix;

    private LegacyContextPrefix(String prefix) {
        this.prefix = prefix;
    }

    public static LegacyContextPrefix fromEnvironment() {
        return parse(System.getenv(VARIABLE));
    }

    /**
     * Unset or blank gives the default. Any other value must be an Iglu vendor
     * prefix: it starts with {@code iglu:} and ends with {@code /}.
     */
    public static LegacyContextPrefix parse(String value) {
        if (value == null || value.isBlank()) return DEFAULT;
        String prefix = value.trim();
        if (!prefix.startsWith("iglu:") || !prefix.endsWith("/") || prefix.length() == "iglu:/".length()) {
            throw new IllegalArgumentException(
                VARIABLE + " must start with \"iglu:\" and end with \"/\": \"" + value + "\"");
        }
        return new LegacyContextPrefix(prefix);
    }

    /**
     * The context's name, such as {@code product} for
     * {@code iglu:com.example.snowplow/product/jsonschema/1-0-0}, or null when its
     * schema has another prefix or no single name.
     */
    String contextName(String schema) {
        if (schema == null || !schema.startsWith(prefix)) return null;
        int markerIndex = schema.indexOf(JSON_SCHEMA_MARKER, prefix.length());
        if (markerIndex < 0) return null;

        String name = schema.substring(prefix.length(), markerIndex);
        return name.isBlank() || name.contains("/") ? null : name;
    }
}
