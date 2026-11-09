package com.cdp.platform.shared.models.node;

import com.cdp.platform.shared.utils.JacksonMapper;
import com.cdp.platform.shared.utils.ParseResult;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonRawValue;
import com.fasterxml.jackson.databind.JsonNode;

/**
 * An engagement node's channel and content, parsed from the {@code action_json}
 * that studio saves.
 */
public record EngagementAction(Channel channel, Content content) {

    /**
     * The message content. Studio saves an unset field as an empty string, so a
     * blank field is absent here. The payload is the JSON studio saved, published
     * as is. Only a webhook action has a method.
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Content(
        @JsonProperty("title") String title,
        @JsonProperty("body") String body,
        @JsonProperty("subject") String subject,
        @JsonProperty("url") String url,
        @JsonProperty("template_id") String templateId,
        @JsonProperty("payload") @JsonRawValue String payload,
        @JsonProperty("method") HttpMethod method) {
    }

    public static ParseResult<EngagementAction> parse(String actionJson) {
        JsonNode action;
        try {
            action = JacksonMapper.readTree(actionJson);
        } catch (IllegalArgumentException exception) {
            return ParseResult.failure(exception);
        }
        if (!action.isObject()) {
            return ParseResult.failure(new IllegalArgumentException("Engagement action must be a JSON object"));
        }
        ParseResult<Channel> channel = Channel.fromSavedName(action.path("type").textValue());
        if (!channel.isValid()) return ParseResult.failure(new IllegalArgumentException(channel.failureMessage()));
        ParseResult<HttpMethod> method = channel.valueOrThrow() == Channel.WEBHOOK
            ? webhookMethod(action.path("method"))
            : ParseResult.success(null);
        if (!method.isValid()) return ParseResult.failure(new IllegalArgumentException(method.failureMessage()));

        Content content = new Content(
            text(action, "title"),
            text(action, "body"),
            text(action, "subject"),
            text(action, "url"),
            text(action, "templateId"),
            payload(action),
            method.valueOrThrow());
        return ParseResult.success(new EngagementAction(channel.valueOrThrow(), content));
    }

    private static String text(JsonNode action, String field) {
        String value = action.path(field).textValue();
        return value == null || value.isBlank() ? null : value;
    }

    private static ParseResult<HttpMethod> webhookMethod(JsonNode method) {
        if (method.isMissingNode() || method.isNull()) return HttpMethod.fromSavedName(null);
        if (!method.isTextual()) {
            return ParseResult.failure(new IllegalArgumentException("Webhook method must be a name: " + method));
        }
        return HttpMethod.fromSavedName(method.textValue());
    }

    private static String payload(JsonNode action) {
        JsonNode payload = action.path("payload");
        if (payload.isMissingNode() || payload.isNull()) return null;
        if (payload.isTextual() && payload.textValue().isBlank()) return null;
        return payload.toString();
    }
}
