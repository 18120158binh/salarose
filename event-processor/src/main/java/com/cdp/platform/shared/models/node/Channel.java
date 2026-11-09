package com.cdp.platform.shared.models.node;

import java.util.Arrays;

import com.cdp.platform.shared.utils.ParseResult;

import com.fasterxml.jackson.annotation.JsonValue;

/**
 * The channel an engagement node sends on. Each channel has the name studio
 * saves and the name the notification request publishes.
 */
public enum Channel {
    PUSH("push", "push"), WEB_PUSH("web-push", "web_push"), SMS("sms", "sms"), EMAIL("email", "email"), FACEBOOK(
        "facebook", "facebook"), ZALO("zalo", "zalo"), WHATSAPP("whatsapp", "whatsapp"), WEBHOOK("webhook", "webhook");

    private final String savedName;
    private final String requestName;

    Channel(String savedName, String requestName) {
        this.savedName = savedName;
        this.requestName = requestName;
    }

    @JsonValue
    public String requestName() {
        return requestName;
    }

    public static ParseResult<Channel> fromSavedName(String savedName) {
        return Arrays
            .stream(values())
            .filter(channel -> channel.savedName.equals(savedName))
            .findFirst()
            .map(ParseResult::success)
            .orElseGet(() -> ParseResult
                .failure(new IllegalArgumentException("Unsupported engagement channel: " + savedName)));
    }
}
