package com.cdp.platform.jobs.segmentpass;

import java.util.Map;

import com.cdp.platform.shared.db.repositories.CustomerProfilesTable;
import com.cdp.platform.shared.models.db.UserProfile;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * One imported-only customer as conditions read them: the built-in profile
 * fields of the {@code customer_profiles} row whose {@code cdp_uuid} is the
 * key, and the imported attributes of each {@code customer_attributes} row of
 * the key, by {@code source_id}.
 */
record ImportedCustomer(String customerKey, UserProfile profile, Map<String, JsonNode> attributesBySource) {

    private static final String PROFILE_PREFIX = "profile.";

    ImportedCustomer {
        profile = profile == null ? UserProfile.empty() : profile;
        attributesBySource = Map.copyOf(attributesBySource);
    }

    /**
     * The value of a {@code profile_property} field, or null when the customer
     * has none. The segment parser names every such field under
     * {@code profile.}. A built-in field, such as {@code profile.city}, reads the
     * profile. Any other field is imported, {@code profile.<source>.<name>}: the
     * rest splits at its first {@code .} and reads the key {@code <name>} of the
     * source's
     * attributes (DEC-FR-40). A JSON null, or no such row or key, is no value. A
     * number or a boolean reads as its JSON text, an object or array as its JSON.
     */
    String field(String field) {
        if (field == null) return null;
        if (CustomerProfilesTable.columnOf(field).isPresent()) return profile.getField(field);
        if (!field.startsWith(PROFILE_PREFIX)) return null;
        String imported = field.substring(PROFILE_PREFIX.length());
        int dot = imported.indexOf('.');
        if (dot <= 0 || dot == imported.length() - 1) return null;
        JsonNode attributes = attributesBySource.get(imported.substring(0, dot));
        if (attributes == null) return null;
        JsonNode value = attributes.get(imported.substring(dot + 1));
        if (value == null || value.isNull() || value.isMissingNode()) return null;
        return value.isValueNode() ? value.asText() : value.toString();
    }
}
