package com.cdp.platform.jobs.eventparser.transforms;

import java.util.Comparator;
import java.util.List;
import java.util.Optional;

import com.cdp.platform.shared.models.db.CatalogAttribute;
import com.cdp.platform.shared.utils.JsonAttributeResolver;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * The catalog attributes of one event whose schema gate is on. An event matches
 * when each attribute with a value has the attribute's type, and each required
 * attribute has a value. A null counts as no value. A required attribute is
 * checked only when its parent object is present, so an optional parent can be
 * left out with its required children. Attributes that the catalog does not
 * list are allowed.
 */
final class EventSchema {

    private final List<CatalogAttribute> attributes;

    EventSchema(List<CatalogAttribute> attributes) {
        this.attributes = attributes.stream().sorted(Comparator.comparing(CatalogAttribute::path)).toList();
    }

    /**
     * The first mismatch, as the attribute path and its catalog type, such as
     * {@code product.price not number}. Never a value from the event.
     */
    Optional<String> violation(JsonNode eventJson) {
        for (CatalogAttribute attribute : attributes) {
            JsonNode value = JsonAttributeResolver.node(eventJson, attribute.path());
            if (value != null && !value.isNull()) {
                if (attribute.type() != null && !attribute.type().matches(value)) {
                    return Optional.of(attribute.path() + " not " + attribute.type().label());
                }
            } else if (attribute.required() && hasParent(eventJson, attribute.path())) {
                String type = attribute.type() == null ? "" : " (" + attribute.type().label() + ")";
                return Optional.of(attribute.path() + " missing" + type);
            }
        }
        return Optional.empty();
    }

    private static boolean hasParent(JsonNode eventJson, String path) {
        int lastDot = path.lastIndexOf('.');
        if (lastDot < 0) return true;
        JsonNode parent = JsonAttributeResolver.node(eventJson, path.substring(0, lastDot));
        return parent != null && parent.isObject();
    }
}
