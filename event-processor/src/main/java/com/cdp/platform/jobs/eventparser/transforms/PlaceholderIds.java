package com.cdp.platform.jobs.eventparser.transforms;

import java.io.Serializable;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Values that trackers send in place of a missing identifier, such as
 * {@code unknown}. An identifier equal to one, after trimming and ignoring
 * case, is absent.
 */
public final class PlaceholderIds implements Serializable {

    public static final String VARIABLE = "EVENT_PARSE_PLACEHOLDER_IDS";
    static final PlaceholderIds DEFAULT = new PlaceholderIds(Set.of("unknown", "undefined", "null"));

    private final Set<String> values;

    private PlaceholderIds(Set<String> values) {
        this.values = values;
    }

    public static PlaceholderIds fromEnvironment() {
        return parse(System.getenv(VARIABLE));
    }

    /**
     * Parses a comma-separated list. Unset or blank gives the default. An empty
     * entry, such as a trailing comma, is an error.
     */
    public static PlaceholderIds parse(String list) {
        if (list == null || list.isBlank()) return DEFAULT;
        Set<String> values = new LinkedHashSet<>();
        for (String entry : list.split(",", -1)) {
            String value = entry.trim().toLowerCase(Locale.ROOT);
            if (value.isEmpty()) throw new IllegalArgumentException(VARIABLE + " has an empty entry: \"" + list + "\"");
            values.add(value);
        }
        return new PlaceholderIds(Set.copyOf(values));
    }

    /** The trimmed identifier, or null when it is blank or a placeholder. */
    String normalize(String id) {
        if (id == null) return null;
        String trimmed = id.trim();
        return trimmed.isEmpty() || values.contains(trimmed.toLowerCase(Locale.ROOT)) ? null : trimmed;
    }
}
