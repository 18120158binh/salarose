package com.cdp.platform.shared.models;

import java.util.List;

/**
 * Event attribute names shared by the tests of every reader of an event's
 * fields.
 */
public final class EventFieldNames {

    public static final String FROM_JSON = "from-json";

    /**
     * Names that once resolved to a parsed event field: each record component's
     * spellings, the spellings of the five contract names that are not the contract
     * name, and the aliases of the page fields.
     */
    public static final List<String> COLLIDING = List
        .of(
            "url", "platform", "user_id", "domain_userid", "event_id", "canon_id", "event_timestamp",
            "collector_timestamp", "userId", "userid", "domainUserId", "domain_user_id", "networkUserId",
            "network_userid", "network_user_id", "canonId", "eventId", "eventTimestamp", "collectorTimestamp",
            "eventName", "event_name", "eventname", "screenLocation", "screen_location", "productName",
            "product_name", "referrerUrl", "referrer_url", "eventJson", "event_json", "pagelocation", "pageurl",
            "pagereferrer", "page_url", "pageUrl", "PAGE.URL", "Event.Name", "EVENT_NAME");

    private EventFieldNames() {
    }

    /**
     * An add_to_cart event with every parsed field set to a value other than
     * {@link #FROM_JSON}.
     */
    public static Event withEveryField(String eventJson) {
        return new Event("canon-1", "duid-1", "nuid-1", "uid-1", "add_to_cart", 1_785_800_000_000L, "checkout",
            "iphone", "https://shop.vn/home", "https://google.com", "web", eventJson, "event-1",
            1_785_800_000_500L);
    }

    public static String jsonWith(String name) {
        return "{\"%s\":\"%s\"}".formatted(name, FROM_JSON);
    }

    public static String equalsFromJson(String name) {
        return "{\"type\":\"comparison\",\"left\":\"%s\",\"op\":\"=\",\"right\":\"%s\"}".formatted(name, FROM_JSON);
    }
}
