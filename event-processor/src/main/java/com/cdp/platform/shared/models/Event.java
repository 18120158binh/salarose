package com.cdp.platform.shared.models;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

import org.apache.flink.types.Row;

import com.cdp.platform.shared.models.db.CampaignNode;
import com.cdp.platform.shared.models.node.FieldPredicates;
import com.cdp.platform.shared.models.node.Predicate;
import com.cdp.platform.shared.utils.JsonAttributeResolver;

import com.fasterxml.jackson.annotation.JsonProperty;

public record Event(
    @JsonProperty("canonId") String canonId,
    @JsonProperty("domainUserId") String domainUserId,
    @JsonProperty("networkUserId") String networkUserId,
    @JsonProperty("userId") String userId,
    @JsonProperty("eventName") String eventName,
    @JsonProperty("eventTimestamp") Long eventTimestamp,
    @JsonProperty("screenLocation") String screenLocation,
    @JsonProperty("productName") String productName,
    @JsonProperty("url") String url,
    @JsonProperty("referrerUrl") String referrerUrl,
    @JsonProperty("platform") String platform,
    @JsonProperty("eventJson") String eventJson,
    @JsonProperty("eventId") String eventId,
    @JsonProperty("collectorTimestamp") Long collectorTimestamp) {
    private static final Map<String, Function<Event, String>> NAMED_FIELDS = Map
        .of(
            "event.name", Event::eventName,
            "page.location", Event::screenLocation,
            "page.url", Event::url,
            "page.referrer", Event::referrerUrl,
            "product.name", Event::productName);

    public Event(
        String canonId, String domainUserId, String networkUserId, String userId,
        String eventName, Long eventTimestamp, String screenLocation, String productName,
        String url, String referrerUrl, String platform, String eventJson, String eventId) {
        this(canonId, domainUserId, networkUserId, userId, eventName, eventTimestamp, screenLocation,
            productName, url, referrerUrl, platform, eventJson, eventId, eventTimestamp);
    }

    public Event(
        String canonId, String domainUserId, String networkUserId, String userId,
        String eventName, Long eventTimestamp, String screenLocation, String productName,
        String url, String referrerUrl, String platform, String eventJson) {
        this(canonId, domainUserId, networkUserId, userId, eventName, eventTimestamp, screenLocation,
            productName, url, referrerUrl, platform, eventJson, null, eventTimestamp);
    }

    public Event(
        String domainUserId, String userId, String eventName, Long eventTimestamp,
        String screenLocation, String productName, String url, String referrerUrl,
        String platform, String eventJson) {
        this(domainUserId, domainUserId, null, userId, eventName, eventTimestamp, screenLocation,
            productName, url, referrerUrl, platform, eventJson, null, eventTimestamp);
    }

    public static Event fromRow(Row row) {
        Long eventTimestamp = longField(row, "event_timestamp");
        Long collectorTimestamp = longField(row, "collector_timestamp");
        return new Event(
            stringField(row, "canon_id"),
            stringField(row, "domain_userid"),
            stringField(row, "network_userid"),
            stringField(row, "user_id"),
            stringField(row, "event_name"),
            eventTimestamp,
            stringField(row, "screen_location"),
            stringField(row, "product_name"),
            stringField(row, "url"),
            stringField(row, "referrer_url"),
            stringField(row, "platform"),
            stringField(row, "event_json"),
            stringField(row, "event_id"),
            collectorTimestamp != null ? collectorTimestamp : eventTimestamp);
    }

    private static String stringField(Row row, String name) {
        return row.getFieldNames(true).contains(name) ? (String) row.getField(name) : null;
    }

    private static Long longField(Row row, String name) {
        return row.getFieldNames(true).contains(name) ? (Long) row.getField(name) : null;
    }

    public Map<String, String> buildContext() {
        var ctx = new LinkedHashMap<String, String>();
        // The five named fields go in last so they win over event_json, as they
        // do in conditions.
        JsonAttributeResolver.flattenInto(eventJson, ctx);
        if (eventName != null) ctx.put("event.name", eventName);
        if (screenLocation != null) ctx.put("page.location", screenLocation);
        if (url != null) ctx.put("page.url", url);
        if (referrerUrl != null) ctx.put("page.referrer", referrerUrl);
        if (productName != null) ctx.put("product.name", productName);
        return ctx;
    }

    public boolean evalPredicate(Predicate predicate) {
        return FieldPredicates.evaluate(predicate, this::propertyValue);
    }

    public String propertyValue(String field) {
        if (field == null || field.isBlank()) {
            return null;
        }
        Function<Event, String> named = NAMED_FIELDS.get(field);
        String value = named == null ? null : named.apply(this);
        return value != null ? value : JsonAttributeResolver.resolve(eventJson, field);
    }

    public List<String> matchAll(CampaignNode node) {
        if (node == null || !evalPredicate(node.condition())) {
            return List.of();
        }
        if (node.branches() == null || node.branches().isEmpty()) {
            return node.nodeType().triggerBranch().map(Enum::name).stream().toList();
        }
        List<String> matched = new ArrayList<>();
        for (var branch : node.branches()) {
            if (branch.condition() == null || evalPredicate(branch.condition())) {
                matched.add(branch.branchKey());
            }
        }
        return List.copyOf(matched);
    }
}
