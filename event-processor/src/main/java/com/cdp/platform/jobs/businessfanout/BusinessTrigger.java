package com.cdp.platform.jobs.businessfanout;

import java.util.Optional;

import org.apache.flink.types.Row;

import com.cdp.platform.shared.db.repositories.CampaignNodesTable;
import com.cdp.platform.shared.models.node.NodeType;
import com.cdp.platform.shared.models.node.Predicate;
import com.cdp.platform.shared.models.node.RuleDocuments;
import com.cdp.platform.shared.models.node.TimeWindow;
import com.cdp.platform.shared.utils.JacksonMapper;

import com.fasterxml.jackson.databind.JsonNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * A setup node's trigger of kind {@code business_event}: the business event's
 * name, filters on its attributes, and one audience. Exactly one of
 * {@code interest} and {@code segmentId} is set.
 */
public record BusinessTrigger(
    String campaignId,
    String nodeId,
    String eventName,
    Predicate filters,
    Interest interest,
    String segmentId) {

    private static final Logger LOG = LoggerFactory.getLogger(BusinessTrigger.class);

    private static final String KIND = "business_event";

    /**
     * People who did {@code event} on the item at least {@code minCount} times in
     * the window, matched by the event's {@code match} attribute, minus those who
     * did {@code excludeEvent} on it, matched by {@code excludeMatch}, in the
     * window. Two campaigns with equal interests share one index.
     */
    public record Interest(
        String event,
        String match,
        int minCount,
        long windowMs,
        String excludeEvent,
        String excludeMatch) {

        /**
         * What identifies the interest's index: everything but the count and the
         * window, which each campaign applies when it reads.
         */
        public String indexId() {
            char separator = BusinessEvent.KEY_SEPARATOR;
            return event + separator + match + separator + (excludeEvent == null ? "" : excludeEvent) + separator
                + (excludeMatch == null ? "" : excludeMatch);
        }
    }

    /**
     * The trigger in a campaign_nodes row, when the row is a setup node with one.
     */
    public static Optional<BusinessTrigger> fromRow(Row row) {
        String campaignId = (String) row.getField(CampaignNodesTable.CAMPAIGN_ID);
        String nodeId = (String) row.getField(CampaignNodesTable.NODE_ID);
        String triggerJson = (String) row.getField(CampaignNodesTable.TRIGGER_JSON);
        if (!NodeType.setup.name().equals(row.getField(CampaignNodesTable.NODE_TYPE)) || triggerJson == null) {
            return Optional.empty();
        }
        try {
            JsonNode root = JacksonMapper.readTree(triggerJson);
            if (!root.isObject() || !KIND.equals(text(root, "kind"))) return Optional.empty();
            if (campaignId == null || nodeId == null) throw new IllegalArgumentException("Missing campaign or node id");
            Predicate filters = RuleDocuments.eventFilters(root.get("filters"));
            JsonNode audience = root.get("audience");
            if (audience == null || !audience.isObject()) throw new IllegalArgumentException("Missing audience");
            String type = requiredText(audience, "type");
            return Optional.of(switch (type) {
                case "interest" -> new BusinessTrigger(campaignId, nodeId, requiredText(root, "event"), filters,
                    interest(audience), null);
                case "segment" -> new BusinessTrigger(campaignId, nodeId, requiredText(root, "event"), filters, null,
                    requiredText(audience, "segment_id"));
                default -> throw new IllegalArgumentException("Unknown audience type " + type);
            });
        } catch (IllegalArgumentException exception) {
            LOG.warn("Ignoring the business trigger of node {}:{}: {}", campaignId, nodeId, exception.getMessage());
            return Optional.empty();
        }
    }

    private static Interest interest(JsonNode audience) {
        JsonNode minCount = audience.get("min_count");
        if (minCount == null || !minCount.canConvertToExactIntegral() || minCount.asInt() < 1) {
            throw new IllegalArgumentException("An interest needs a min_count of at least 1");
        }
        JsonNode window = audience.get("window");
        if (window == null || !window.isObject() || !window.has("value")
            || !window.get("value").canConvertToExactIntegral() || window.get("value").asLong() < 1) {
            throw new IllegalArgumentException("An interest needs a window");
        }
        String unitName = requiredText(window, "unit");
        TimeWindow.Unit unit = TimeWindow.Unit
            .of(unitName)
            .orElseThrow(() -> new IllegalArgumentException("Unknown window unit " + unitName));
        JsonNode exclude = audience.get("exclude");
        boolean excludes = exclude != null && exclude.isObject();
        return new Interest(requiredText(audience, "event"), requiredText(audience, "match"), minCount.asInt(),
            window.get("value").asLong() * unit.millis(), excludes ? requiredText(exclude, "event") : null,
            excludes ? requiredText(exclude, "match") : null);
    }

    private static String requiredText(JsonNode node, String field) {
        String text = text(node, field);
        if (text == null) throw new IllegalArgumentException("Missing " + field);
        return text;
    }

    private static String text(JsonNode node, String field) {
        JsonNode value = node.get(field);
        return value == null || !value.isTextual() || value.asText().isBlank() ? null : value.asText();
    }
}
