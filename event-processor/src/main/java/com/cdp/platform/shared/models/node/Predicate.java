package com.cdp.platform.shared.models.node;

import java.io.Serializable;
import java.util.List;

import com.cdp.platform.shared.utils.JacksonMapper;
import com.cdp.platform.shared.utils.ParseResult;

import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;
import com.fasterxml.jackson.databind.JsonNode;

// Java 21 Sealed AST Hierarchy for Predicates
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "type")
@JsonSubTypes({
    @JsonSubTypes.Type(value = And.class, name = "and"),
    @JsonSubTypes.Type(value = Or.class, name = "or"),
    @JsonSubTypes.Type(value = Comparison.class, name = "comparison")
})
public sealed interface Predicate extends Serializable permits And, Or, Comparison, Not {

    static ParseResult<Predicate> fromJson(String json) {
        if (json == null || json.isBlank()) return ParseResult.success(null);
        try {
            return checkGroups(JacksonMapper.readValue(json.trim(), Predicate.class));
        } catch (IllegalArgumentException exception) {
            return ParseResult.failure(new IllegalArgumentException("Invalid predicate JSON", exception));
        }
    }

    static ParseResult<Predicate> fromJsonNode(JsonNode node) {
        if (node == null || node.isNull()) return ParseResult.success(null);
        try {
            return checkGroups(JacksonMapper.treeToValue(node, Predicate.class));
        } catch (IllegalArgumentException exception) {
            return ParseResult.failure(new IllegalArgumentException("Invalid predicate JSON", exception));
        }
    }

    /**
     * Fails when an {@code and} or {@code or} in the tree has no
     * {@code expressions}. An empty list is allowed.
     */
    static ParseResult<Predicate> checkGroups(Predicate predicate) {
        if (hasGroupWithoutExpressions(predicate)) {
            return ParseResult.failure(new IllegalArgumentException("Condition group has no expressions"));
        }
        return ParseResult.success(predicate);
    }

    private static boolean hasGroupWithoutExpressions(Predicate predicate) {
        if (predicate == null) return false;
        return switch (predicate) {
            case And(var expressions) -> hasGroupWithoutExpressions(expressions);
            case Or(var expressions) -> hasGroupWithoutExpressions(expressions);
            case Not(var expression) -> hasGroupWithoutExpressions(expression);
            case Comparison comparison -> false;
        };
    }

    private static boolean hasGroupWithoutExpressions(List<Predicate> expressions) {
        return expressions == null || expressions.stream().anyMatch(Predicate::hasGroupWithoutExpressions);
    }
}
