package com.cdp.platform.shared.utils;

import java.util.Objects;

/**
 * Represents either a successfully parsed value (including a nullable optional
 * value) or a type-specific parsing failure.
 */
public final class ParseResult<T> {

    private final T value;
    private final IllegalArgumentException failure;

    private ParseResult(T value, IllegalArgumentException failure) {
        this.value = value;
        this.failure = failure;
    }

    public static <T> ParseResult<T> success(T value) {
        return new ParseResult<>(value, null);
    }

    public static <T> ParseResult<T> failure(IllegalArgumentException failure) {
        return new ParseResult<>(null, Objects.requireNonNull(failure, "Parsing failure is required"));
    }

    public boolean isValid() {
        return failure == null;
    }

    public T valueOrThrow() {
        if (failure != null) throw failure;
        return value;
    }

    public String failureMessage() {
        return failure == null ? null : failure.getMessage();
    }
}
