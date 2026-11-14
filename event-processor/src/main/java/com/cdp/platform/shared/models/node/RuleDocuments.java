package com.cdp.platform.shared.models.node;

import java.util.ArrayList;
import java.util.List;

import com.cdp.platform.shared.utils.JacksonMapper;
import com.cdp.platform.shared.utils.ParseResult;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * Parses the rule documents of a {@code campaign_nodes} row: the trigger, the
 * conditions, and the paths. A trigger becomes a predicate on the event that
 * compares {@code event.name} first. An {@code IN} becomes one {@code =} for
 * each of its values, in the group that holds it.
 */
public final class RuleDocuments {

    private static final String EVENT_NAME = "event.name";
    private static final String PROFILE_PREFIX = "profile.";

    private RuleDocuments() {
    }

    /** How a node branches. Null fields mean the node has one path. */
    public record Paths(String pathType, List<BranchCondition> branches) {

        public static final Paths NONE = new Paths(null, null);
    }

    /** The trigger as a predicate on the event, or null when there is none. */
    public static ParseResult<Predicate> trigger(String json) {
        return parse(json, "trigger", root -> {
            if (!"event".equals(text(root, "kind"))) {
                throw new IllegalArgumentException("Unsupported trigger kind: " + root.get("kind"));
            }
            Predicate name = new Comparison(EVENT_NAME, "=", requiredText(root, "event"));
            Predicate filters = filters(root.get("filters"));
            return new And(filters == null ? List.of(name) : List.of(name, filters));
        });
    }

    /**
     * The conditions on the person, {@link PersonConditions#NONE} when there are
     * none.
     */
    public static ParseResult<PersonConditions> conditions(String json) {
        ParseResult<PersonConditions> parsed = parse(json, "conditions", RuleDocuments::conditions);
        if (parsed.isValid() && parsed.valueOrThrow() == null) return ParseResult.success(PersonConditions.NONE);
        return parsed;
    }

    /**
     * A segment's conditions: at least one group, of profile and behavior
     * conditions only, since a segment cannot test another segment.
     */
    public static ParseResult<PersonConditions> segmentConditions(String json) {
        return parse(json, "segment conditions", root -> {
            PersonConditions conditions = conditions(root);
            if (conditions.groups().isEmpty()) throw new IllegalArgumentException("A segment has no groups");
            if (!conditions.segmentIds().isEmpty()) {
                throw new IllegalArgumentException("A segment cannot hold a segment_membership condition");
            }
            return conditions;
        });
    }

    public static ParseResult<Paths> paths(String json) {
        ParseResult<Paths> parsed = parse(json, "paths", root -> {
            JsonNode branches = root.get("branches");
            if (branches == null || branches.isNull()) return new Paths(text(root, "path_type"), null);
            if (!branches.isArray()) throw new IllegalArgumentException("branches is not an array");
            List<BranchCondition> parsedBranches = new ArrayList<>();
            for (JsonNode branch : branches) {
                parsedBranches
                    .add(new BranchCondition(requiredText(branch, "key"), filters(branch.get("filters")),
                        conditions(branch.get("conditions"))));
            }
            return new Paths(text(root, "path_type"), List.copyOf(parsedBranches));
        });
        if (parsed.isValid() && parsed.valueOrThrow() == null) return ParseResult.success(Paths.NONE);
        return parsed;
    }

    private interface Reader<T> {
        T read(JsonNode root);
    }

    private static <T> ParseResult<T> parse(String json, String document, Reader<T> reader) {
        if (json == null || json.isBlank()) return ParseResult.success(null);
        try {
            JsonNode root = JacksonMapper.readTree(json.trim());
            if (root.isNull()) return ParseResult.success(null);
            if (!root.isObject()) throw new IllegalArgumentException("not a JSON object");
            return ParseResult.success(reader.read(root));
        } catch (IllegalArgumentException exception) {
            return ParseResult.failure(new IllegalArgumentException("Invalid " + document + " JSON", exception));
        }
    }

    /** Filters on an event, as an {@code and} of one {@code or} per group. */
    private static Predicate filters(JsonNode filters) {
        List<List<JsonNode>> groups = groups(filters);
        if (groups.isEmpty()) return null;
        List<Predicate> and = new ArrayList<>();
        for (List<JsonNode> group : groups) {
            List<Predicate> or = new ArrayList<>();
            for (JsonNode condition : group) {
                if (!"event_property".equals(text(condition, "type"))) {
                    throw new IllegalArgumentException("A filter is not an event_property: " + condition.get("type"));
                }
                or.addAll(fieldComparisons(condition));
            }
            and.add(new Or(List.copyOf(or)));
        }
        return new And(List.copyOf(and));
    }

    private static PersonConditions conditions(JsonNode conditions) {
        List<PersonConditions.Group> parsed = new ArrayList<>();
        for (List<JsonNode> group : groups(conditions)) {
            List<Comparison> profile = new ArrayList<>();
            List<Comparison> behavior = new ArrayList<>();
            List<SegmentMembership> segments = new ArrayList<>();
            for (JsonNode condition : group) {
                String type = text(condition, "type");
                switch (type == null ? "" : type) {
                    case "profile_property" -> profile.addAll(fieldComparisons(condition, PROFILE_PREFIX));
                    case "behavior" -> behavior.add(behavior(condition));
                    case "segment_membership" -> segments.add(segmentMembership(condition));
                    default -> throw new IllegalArgumentException("Unsupported condition type: " + type);
                }
            }
            parsed.add(new PersonConditions.Group(profile, behavior, segments));
        }
        return new PersonConditions(parsed);
    }

    // The conditions of each group. An absent list has no groups, and a group
    // must hold at least one condition.
    private static List<List<JsonNode>> groups(JsonNode list) {
        if (list == null || list.isNull()) return List.of();
        JsonNode groups = list.get("groups");
        if (groups == null || !groups.isArray()) throw new IllegalArgumentException("groups is not an array");
        List<List<JsonNode>> parsed = new ArrayList<>();
        for (JsonNode group : groups) {
            JsonNode conditions = group.get("conditions");
            if (conditions == null || !conditions.isArray() || conditions.isEmpty()) {
                throw new IllegalArgumentException("A group has no conditions");
            }
            List<JsonNode> entries = new ArrayList<>();
            conditions.forEach(entries::add);
            parsed.add(List.copyOf(entries));
        }
        return List.copyOf(parsed);
    }

    private static List<Comparison> fieldComparisons(JsonNode condition) {
        return fieldComparisons(condition, "");
    }

    // A profile field is saved by its bare name, and the profile reads it under
    // its prefix.
    private static List<Comparison> fieldComparisons(JsonNode condition, String prefix) {
        String field = prefix + requiredText(condition, "field");
        String op = requiredText(condition, "op");
        FieldOperator operator = FieldOperator
            .of(op)
            .orElseThrow(() -> new IllegalArgumentException("Comparison on %s has unknown operator %s"
                .formatted(field, op)));
        JsonNode value = condition.get("value");
        if (operator.isRelativeDate()) return List.of(relativeDate(field, op, prefix, value));
        if (operator != FieldOperator.IN) return List.of(new Comparison(field, op, scalar(field, value)));
        if (value == null || !value.isArray()) {
            throw new IllegalArgumentException("IN on %s needs an array of values".formatted(field));
        }
        List<Comparison> equalities = new ArrayList<>();
        value.forEach(item -> equalities.add(new Comparison(field, "=", scalar(field, item))));
        return List.copyOf(equalities);
    }

    // A relative-date operator compares a datetime profile field with the check
    // time, so it takes a whole number of days of at least 1, and no event field
    // (DEC-FR-43).
    private static Comparison relativeDate(String field, String op, String prefix, JsonNode value) {
        if (prefix.isEmpty()) {
            throw new IllegalArgumentException("%s on the event field %s is not allowed".formatted(op, field));
        }
        boolean whole = value != null && (value.isIntegralNumber() || value.isTextual())
            && FieldPredicates.days(value.asText()).isPresent();
        if (!whole)
            throw new IllegalArgumentException("%s on %s needs a whole number of days of at least 1"
                .formatted(op, field));
        return new Comparison(field, op, value.asText());
    }

    private static Comparison behavior(JsonNode condition) {
        String metricId = requiredText(condition, "metric_id");
        requiredText(condition, "event");
        String measure = requiredText(condition, "measure");
        MetricFunction function;
        try {
            function = MetricFunction.valueOf(measure);
        } catch (IllegalArgumentException unknown) {
            throw new IllegalArgumentException("Behavior on %s has unknown measure %s".formatted(metricId, measure));
        }
        String op = requiredText(condition, "op");
        JsonNode value = condition.get("value");
        if (value == null || !value.isNumber()) {
            throw new IllegalArgumentException("Behavior on %s has a value that is not a number".formatted(metricId));
        }
        Comparison comparison = new Comparison(metricId, op, value.asText(), window(metricId, condition.get("window")),
            function);
        // Checks the operator, the value, and the window.
        MetricComparison.of(comparison);
        return comparison;
    }

    private static SegmentMembership segmentMembership(JsonNode condition) {
        String segmentId = requiredText(condition, "segment_id");
        String op = requiredText(condition, "op");
        return switch (op) {
            case "in" -> new SegmentMembership(segmentId, true);
            case "not_in" -> new SegmentMembership(segmentId, false);
            default -> throw new IllegalArgumentException("Segment membership has unknown operator " + op);
        };
    }

    private static TimeWindow window(String metricId, JsonNode window) {
        if (window == null || window.isNull()) {
            throw new IllegalArgumentException("Behavior on %s has no window".formatted(metricId));
        }
        JsonNode value = window.get("value");
        if (value == null || !value.canConvertToExactIntegral() || !value.canConvertToLong()) {
            throw new IllegalArgumentException("Behavior on %s has a window that is not whole".formatted(metricId));
        }
        return new TimeWindow(value.longValue(), requiredText(window, "unit"));
    }

    private static String scalar(String field, JsonNode value) {
        if (value == null || !value.isValueNode() || value.isNull()) {
            throw new IllegalArgumentException("Comparison on %s has no value".formatted(field));
        }
        return value.asText();
    }

    private static String requiredText(JsonNode node, String field) {
        String text = text(node, field);
        if (text == null || text.isBlank()) throw new IllegalArgumentException("Missing " + field);
        return text;
    }

    private static String text(JsonNode node, String field) {
        JsonNode value = node.get(field);
        return value != null && value.isTextual() ? value.asText() : null;
    }
}
