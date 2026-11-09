package com.cdp.platform.shared.models.node;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;
import java.util.function.Function;
import java.util.regex.Pattern;

import com.cdp.platform.shared.utils.ParseResult;

/**
 * The predicate language over event and profile fields. Metric conditions use
 * the same tree with their own operators and defaults.
 */
public final class FieldPredicates {

    private FieldPredicates() {
    }

    /**
     * Parses a condition over event or profile fields. Unlike a metric
     * comparison, a field comparison has no default operator.
     */
    public static ParseResult<Predicate> fromJson(String json) {
        ParseResult<Predicate> parsed = Predicate.fromJson(json);
        return parsed.isValid() ? check(parsed.valueOrThrow()) : parsed;
    }

    /**
     * Fails when a group in the tree has no expressions, or a comparison has no
     * left field or an operator that is not a {@link FieldOperator}.
     */
    public static ParseResult<Predicate> check(Predicate predicate) {
        ParseResult<Predicate> groups = Predicate.checkGroups(predicate);
        if (!groups.isValid()) return groups;
        return firstProblem(predicate)
            .<ParseResult<Predicate>>map(problem -> ParseResult.failure(new IllegalArgumentException(problem)))
            .orElse(ParseResult.success(predicate));
    }

    /**
     * Evaluates the tree, reading the left side of each comparison through
     * {@code fields}.
     */
    public static boolean evaluate(Predicate predicate, Function<String, String> fields) {
        if (predicate == null) return true;
        return switch (predicate) {
            case And(var expressions) -> expressions == null
                || expressions.stream().allMatch(expression -> evaluate(expression, fields));
            case Or(var expressions) -> expressions != null
                && expressions.stream().anyMatch(expression -> evaluate(expression, fields));
            case Not(var expression) -> !evaluate(expression, fields);
            // A rule restored from state may predate the parse-time checks, so a
            // missing left field or an unknown operator is read as false.
            case Comparison comparison -> comparison.left() != null && FieldOperator
                .of(comparison.op())
                .map(operator -> compare(fields.apply(comparison.left()), operator, comparison.right()))
                .orElse(false);
        };
    }

    private static Optional<String> firstProblem(Predicate predicate) {
        if (predicate == null) return Optional.empty();
        return switch (predicate) {
            case And(var expressions) -> firstProblem(expressions);
            case Or(var expressions) -> firstProblem(expressions);
            case Not(var expression) -> firstProblem(expression);
            case Comparison comparison -> problem(comparison);
        };
    }

    private static Optional<String> firstProblem(List<Predicate> expressions) {
        if (expressions == null) return Optional.empty();
        return expressions.stream().flatMap(expression -> firstProblem(expression).stream()).findFirst();
    }

    private static Optional<String> problem(Comparison comparison) {
        String left = comparison.left();
        if (isBlank(left)) return Optional.of("Comparison has no left field");
        if (isBlank(comparison.op())) return Optional.of("Comparison on %s has no operator".formatted(left));
        return FieldOperator.of(comparison.op()).isPresent()
            ? Optional.empty()
            : Optional.of("Comparison on %s has unknown operator %s".formatted(left, comparison.op()));
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

    private static boolean compare(String left, FieldOperator operator, String right) {
        if (left == null || right == null) return false;
        return switch (operator) {
            case GREATER, AT_LEAST, LESS, AT_MOST -> order(left, operator, right);
            case EQUALS -> left.equals(right);
            case NOT_EQUALS -> !left.equals(right);
            case LIKE -> like(left, right);
            case IN -> in(left, right);
        };
    }

    // Orders two numbers, or else two ISO 8601 datetimes. False for anything else.
    private static boolean order(String left, FieldOperator operator, String right) {
        Optional<Integer> numbers = compareNumbers(left, right);
        if (numbers.isPresent()) return holds(operator, numbers.get());
        Optional<Instant> leftInstant = instant(left);
        if (leftInstant.isEmpty()) return false;
        Optional<LocalDate> rightDay = date(right);
        if (rightDay.isPresent()) return withinDays(leftInstant.get(), operator, rightDay.get());
        return instant(right)
            .map(rightInstant -> holds(operator, leftInstant.get().compareTo(rightInstant)))
            .orElse(false);
    }

    private static boolean holds(FieldOperator operator, int sign) {
        return switch (operator) {
            case GREATER -> sign > 0;
            case AT_LEAST -> sign >= 0;
            case LESS -> sign < 0;
            case AT_MOST -> sign <= 0;
            default -> false;
        };
    }

    // A date on the right is the whole UTC day: after it means from the start of
    // the next day, and on or before it means before the start of the next day.
    private static boolean withinDays(Instant value, FieldOperator operator, LocalDate day) {
        Instant start = day.atStartOfDay(ZoneOffset.UTC).toInstant();
        Instant nextStart = day.plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant();
        return switch (operator) {
            case GREATER -> !value.isBefore(nextStart);
            case AT_LEAST -> !value.isBefore(start);
            case LESS -> value.isBefore(start);
            case AT_MOST -> value.isBefore(nextStart);
            default -> false;
        };
    }

    // NaN orders with nothing, and -0 equals 0, as the primitive comparisons read
    // them.
    private static Optional<Integer> compareNumbers(String left, String right) {
        double leftNumber;
        double rightNumber;
        try {
            leftNumber = Double.parseDouble(left);
            rightNumber = Double.parseDouble(right);
        } catch (NumberFormatException exception) {
            return Optional.empty();
        }
        if (Double.isNaN(leftNumber) || Double.isNaN(rightNumber)) return Optional.empty();
        return Optional.of(leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0);
    }

    // An offset datetime, a datetime without an offset as UTC, or a date as the
    // start of its day in UTC.
    private static Optional<Instant> instant(String value) {
        String text = value.trim();
        try {
            return Optional.of(OffsetDateTime.parse(text).toInstant());
        } catch (DateTimeParseException withoutOffset) {
            // Try the forms without an offset.
        }
        try {
            return Optional.of(LocalDateTime.parse(text).toInstant(ZoneOffset.UTC));
        } catch (DateTimeParseException dateOnly) {
            // Try a date.
        }
        return date(text).map(day -> day.atStartOfDay(ZoneOffset.UTC).toInstant());
    }

    private static Optional<LocalDate> date(String value) {
        try {
            return Optional.of(LocalDate.parse(value.trim()));
        } catch (DateTimeParseException notADate) {
            return Optional.empty();
        }
    }

    private static boolean like(String value, String pattern) {
        StringBuilder regex = new StringBuilder();
        StringBuilder literal = new StringBuilder();
        for (char character : pattern.toCharArray()) {
            if (character == '%' || character == '_') {
                appendQuoted(regex, literal);
                regex.append(character == '%' ? ".*" : ".");
            } else {
                literal.append(character);
            }
        }
        appendQuoted(regex, literal);
        return Pattern.compile(regex.toString(), Pattern.DOTALL).matcher(value).matches();
    }

    private static void appendQuoted(StringBuilder regex, StringBuilder literal) {
        if (literal.isEmpty()) return;
        regex.append(Pattern.quote(literal.toString()));
        literal.setLength(0);
    }

    private static boolean in(String value, String list) {
        return inItems(list).contains(value.trim());
    }

    /**
     * The items of an {@code IN} list, as the trimmed field value is compared
     * with them. Commas separate the items. One pair of parentheses around the
     * whole list is removed, and so is one pair of matching quotes around an
     * item. A quote or a parenthesis anywhere else is part of the item. Studio
     * reads an IN list the same way when it finds the events a rule names.
     */
    public static List<String> inItems(String list) {
        String items = list.trim();
        if (items.length() >= 2 && items.startsWith("(") && items.endsWith(")")) {
            items = items.substring(1, items.length() - 1);
        }
        return Arrays.stream(items.split(",")).map(item -> unquoted(item.trim())).toList();
    }

    private static String unquoted(String item) {
        if (item.length() < 2) return item;
        char first = item.charAt(0);
        boolean quoted = (first == '\'' || first == '"') && item.charAt(item.length() - 1) == first;
        return quoted ? item.substring(1, item.length() - 1) : item;
    }
}
