package com.cdp.platform.shared.models.node;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertAll;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import org.junit.jupiter.api.Test;

class EngagementActionTest {

    @Test
    void anActionThatDoesNotParseIsRejectedWithoutAnException() {
        List<String> unparseable = List
            .of(
                "not json",
                "",
                "[]",
                "\"sms\"",
                "{\"title\":\"Hey!\",\"body\":\"No channel\"}",
                "{\"type\":\"pigeon\",\"body\":\"Unknown channel\"}",
                "{\"type\":42,\"body\":\"Channel is not a name\"}",
                "{\"type\":\"webhook\",\"url\":\"https://example.com/webhook\",\"method\":\"FETCH\"}",
                "{\"type\":\"webhook\",\"url\":\"https://example.com/webhook\",\"method\":42}");

        assertAll(unparseable
            .stream()
            .map(actionJson -> () -> assertFalse(EngagementAction.parse(actionJson).isValid(), actionJson)));
    }

    @Test
    void webhookMethodIsNormalizedToUppercaseAndDefaultsToPost() {
        assertEquals(HttpMethod.PATCH, webhookMethod("\"method\":\"patch\","));
        assertEquals(HttpMethod.DELETE, webhookMethod("\"method\":\"DELETE\","));
        assertEquals(HttpMethod.GET, webhookMethod("\"method\":\"Get\","));
        assertEquals(HttpMethod.POST, webhookMethod(""));
        assertEquals(HttpMethod.POST, webhookMethod("\"method\":null,"));
    }

    @Test
    void onlyAWebhookActionCarriesAMethod() {
        EngagementAction sms = EngagementAction
            .parse("{\"type\":\"sms\",\"body\":\"Your cart is waiting.\",\"method\":\"FETCH\"}")
            .valueOrThrow();

        assertEquals(null, sms.content().method());
        assertEquals("Your cart is waiting.", sms.content().body());
    }

    private static HttpMethod webhookMethod(String methodField) {
        return EngagementAction
            .parse("{\"type\":\"webhook\"," + methodField + "\"url\":\"https://example.com/webhook\"}")
            .valueOrThrow()
            .content()
            .method();
    }
}
