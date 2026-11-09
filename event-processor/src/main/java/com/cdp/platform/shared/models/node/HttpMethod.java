package com.cdp.platform.shared.models.node;

import java.util.Arrays;
import java.util.Locale;

import com.cdp.platform.shared.utils.ParseResult;

/**
 * The HTTP method a webhook node calls its URL with.
 */
public enum HttpMethod {
    GET, POST, PUT, PATCH, DELETE;

    /**
     * Parses the method studio saves on a webhook node, in any case. A node
     * without a method calls with POST.
     */
    public static ParseResult<HttpMethod> fromSavedName(String savedName) {
        if (savedName == null || savedName.isBlank()) return ParseResult.success(POST);
        String name = savedName.trim().toUpperCase(Locale.ROOT);
        return Arrays
            .stream(values())
            .filter(method -> method.name().equals(name))
            .findFirst()
            .map(ParseResult::success)
            .orElseGet(() -> ParseResult
                .failure(new IllegalArgumentException("Unsupported webhook method: " + savedName)));
    }
}
