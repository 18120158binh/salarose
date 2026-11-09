package com.cdp.platform.shared.models.db;

import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;

import com.cdp.platform.shared.models.Event;

import static com.cdp.platform.shared.models.EventFieldNames.COLLIDING;
import static com.cdp.platform.shared.models.EventFieldNames.equalsFromJson;
import static com.cdp.platform.shared.models.EventFieldNames.jsonWith;
import static com.cdp.platform.shared.models.EventFieldNames.withEveryField;
import static org.junit.jupiter.api.Assertions.assertAll;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class MetricConfigTest {

    // The text studio writes for catalog default values on screen_location and
    // order.channel,
    // and the same condition as Postgres returns it from the jsonb column.
    private static final String STUDIO_DEFAULTS = "{\"type\":\"and\",\"expressions\":["
        + "{\"type\":\"comparison\",\"left\":\"screen_location\",\"op\":\"=\",\"right\":\"checkout\"},"
        + "{\"type\":\"comparison\",\"left\":\"order.channel\",\"op\":\"=\",\"right\":\"web\"}]}";
    private static final String JSONB_DEFAULTS = "{\"type\": \"and\", \"expressions\": ["
        + "{\"op\": \"=\", \"left\": \"screen_location\", \"type\": \"comparison\", \"right\": \"checkout\"}, "
        + "{\"op\": \"=\", \"left\": \"order.channel\", \"type\": \"comparison\", \"right\": \"web\"}]}";
    // A condition tree as studio wrote it for the attribute map
    // {"product.category":
    // "electronics", "quantity": 2}.
    private static final String STUDIO_FILTER = "{\"type\":\"and\",\"expressions\":["
        + "{\"type\":\"comparison\",\"left\":\"product.category\",\"op\":\"=\",\"right\":\"electronics\"},"
        + "{\"type\":\"comparison\",\"left\":\"quantity\",\"op\":\"=\",\"right\":\"2\"}]}";

    @Test
    void emptyObjectConditionsMatchEveryEventOfTheMetricEvent() {
        MetricConfig config = MetricConfig.load(definitionRow("{}", "{}"));

        assertEquals("m_add_to_cart_count", config.id());
        assertTrue(config.enabled());
        assertTrue(config.matches(event("add_to_cart")));
        assertFalse(config.matches(event("view_page")));
    }

    @Test
    void definitionWithMalformedConditionLoadsDisabledUnderItsId() {
        MetricConfig config = MetricConfig.load(definitionRow("{}", "{\"type\":\"unknown\"}"));

        assertEquals("m_add_to_cart_count", config.id());
        assertFalse(config.enabled());
    }

    @Test
    void definitionWithAComparisonWithoutOperatorLoadsDisabledUnderItsId() {
        MetricConfig config = MetricConfig
            .load(definitionRow("{}", "{\"type\":\"comparison\",\"left\":\"product.price\",\"right\":\"10\"}"));

        assertEquals("m_add_to_cart_count", config.id());
        assertFalse(config.enabled());
    }

    @Test
    void definitionWithAGroupWithoutExpressionsLoadsDisabledUnderItsId() {
        MetricConfig config = MetricConfig.load(definitionRow("{}", "{\"type\":\"or\"}"));

        assertEquals("m_add_to_cart_count", config.id());
        assertFalse(config.enabled());
    }

    @Test
    void definitionWithAComparisonWithoutLeftLoadsDisabledUnderItsId() {
        MetricConfig config = MetricConfig
            .load(definitionRow("{}", "{\"type\":\"comparison\",\"op\":\">\",\"right\":\"10\"}"));

        assertEquals("m_add_to_cart_count", config.id());
        assertFalse(config.enabled());
    }

    @Test
    void studioDefaultPropertiesLoadAndMatchEventsWithTheDefaultValues() {
        assertLoadsAndMatchesDefaults(STUDIO_DEFAULTS);
    }

    @Test
    void studioDefaultPropertiesReadBackFromJsonbLoadAndMatchEventsWithTheDefaultValues() {
        assertLoadsAndMatchesDefaults(JSONB_DEFAULTS);
    }

    @Test
    void studioFilterConditionsLoadAndMatchEventsWithTheFilterValues() {
        MetricConfig config = MetricConfig.load(definitionRow("{}", STUDIO_FILTER));

        assertTrue(config.enabled());
        assertTrue(config.matches(event("add_to_cart", "{\"product\":{\"category\":\"electronics\"},\"quantity\":2}")));
        assertFalse(config.matches(event("add_to_cart", "{\"product\":{\"category\":\"books\"},\"quantity\":2}")));
    }

    @Test
    void definitionWithAComparisonWithAnUnknownOperatorLoadsDisabledUnderItsId() {
        MetricConfig config = MetricConfig
            .load(definitionRow("{}",
                "{\"type\":\"comparison\",\"left\":\"product.category\",\"op\":\"CONTAINS\",\"right\":\"phone\"}"));

        assertEquals("m_add_to_cart_count", config.id());
        assertFalse(config.enabled());
    }

    @Test
    void definitionWithAnUnknownValueTypeLoadsDisabledUnderItsId() {
        Row row = definitionRow("{}", "{}");
        row.setField("value_type", "PERCENT");

        MetricConfig config = MetricConfig.load(row);

        assertEquals("m_add_to_cart_count", config.id());
        assertFalse(config.enabled());
    }

    @Test
    void flatMapConditionLoadsDisabled() {
        MetricConfig config = MetricConfig.load(definitionRow("{\"screen_location\":\"checkout\"}", "{}"));

        assertFalse(config.enabled());
    }

    @Test
    void definitionWithABlankOrWildcardEventNameLoadsDisabledUnderItsId() {
        for (String eventName : new String[] {"", "  ", "*"}) {
            Row row = definitionRow("{}", "{}");
            row.setField("event_name", eventName);

            MetricConfig config = MetricConfig.load(row);

            assertEquals("m_add_to_cart_count", config.id());
            assertFalse(config.enabled(), "event_name '" + eventName + "'");
        }
    }

    @Test
    void aFilterOnANameOutsideTheContractListReadsEventJson() {
        assertAll(COLLIDING
            .stream()
            .map(name -> () -> assertTrue(
                MetricConfig.load(definitionRow("{}", equalsFromJson(name))).matches(withEveryField(jsonWith(name))),
                name)));
    }

    private static void assertLoadsAndMatchesDefaults(String defaultProperties) {
        MetricConfig config = MetricConfig.load(definitionRow(defaultProperties, "{}"));

        assertTrue(config.enabled());
        assertTrue(
            config.matches(event("add_to_cart", "{\"screen_location\":\"checkout\",\"order\":{\"channel\":\"web\"}}")));
        assertFalse(
            config.matches(event("add_to_cart", "{\"screen_location\":\"checkout\",\"order\":{\"channel\":\"app\"}}")));
    }

    private static Row definitionRow(String defaultProperties, String filterConditions) {
        Row row = Row.withNames(RowKind.INSERT);
        row.setField("id", "m_add_to_cart_count");
        row.setField("name", "add_to_cart_count");
        row.setField("processing_mode", "LIVE");
        row.setField("user_event_id", "add_to_cart");
        row.setField("event_name", "add_to_cart");
        row.setField("default_properties", defaultProperties);
        row.setField("filter_conditions", filterConditions);
        row.setField("agg_operator", "COUNT");
        row.setField("agg_field", null);
        row.setField("metric_type", "EVENT_SERIES");
        row.setField("value_type", "PRESENCE");
        row.setField("retention_ms", 86_400_000L);
        row.setField("enabled", true);
        return row;
    }

    private static Event event(String eventName) {
        return event(eventName, "{}");
    }

    private static Event event(String eventName, String eventJson) {
        return new Event("canon-1", null, null, null, eventName, 1_700_000_000_000L, null, null, null, null,
            "web", eventJson, "event-1");
    }
}
