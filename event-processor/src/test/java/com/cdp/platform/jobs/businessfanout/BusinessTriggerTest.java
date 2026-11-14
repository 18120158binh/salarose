package com.cdp.platform.jobs.businessfanout;

import java.time.Duration;
import java.util.List;

import org.apache.flink.types.Row;

import com.cdp.platform.shared.db.repositories.CampaignNodesTable;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class BusinessTriggerTest {

    @Test
    void anInterestTriggerKeepsItsAudience() {
        BusinessTrigger trigger = BusinessTrigger
            .fromRow(nodeRow("CAMP-0042", "setup_1", "setup", """
                {"kind":"business_event","event":"price_drop",
                 "audience":{"type":"interest","event":"com.acme/view_product","match":"product.id","min_count":2,
                             "window":{"value":7,"unit":"DAYS"},"exclude":{"event":"purchase","match":"product.id"}}}
                """))
            .orElseThrow();

        assertEquals("price_drop", trigger.eventName());
        assertNull(trigger.filters());
        assertEquals(new BusinessTrigger.Interest("com.acme/view_product", "product.id", 2,
            Duration.ofDays(7).toMillis(), "purchase", "product.id"), trigger.interest());
    }

    @Test
    void aSegmentTriggerNamesItsSegment() {
        BusinessTrigger trigger = BusinessTrigger
            .fromRow(nodeRow("CAMP-7", "setup_1", "setup",
                "{\"kind\":\"business_event\",\"event\":\"back_in_stock\","
                    + "\"audience\":{\"type\":\"segment\",\"segment_id\":\"SEG-4f1c9a0b2d3e5f67\"}}"))
            .orElseThrow();

        assertEquals("SEG-4f1c9a0b2d3e5f67", trigger.segmentId());
        assertNull(trigger.interest());
    }

    @Test
    void rowsWithoutAValidBusinessTriggerAreSkipped() {
        String segment = "\"audience\":{\"type\":\"segment\",\"segment_id\":\"S\"}";
        for (String trigger : List
            .of("{\"kind\":\"event\",\"event\":\"purchase\"}",
                "{\"kind\":\"business_event\",\"event\":\"price_drop\"}",
                "{\"kind\":\"business_event\"," + segment + "}",
                "{\"kind\":\"business_event\",\"event\":\"e\",\"audience\":{\"type\":\"other\"}}",
                "{\"kind\":\"business_event\",\"event\":\"e\",\"audience\":{\"type\":\"interest\",\"event\":\"v\","
                    + "\"match\":\"p\",\"min_count\":0,\"window\":{\"value\":7,\"unit\":\"DAYS\"}}}",
                "{\"kind\":\"business_event\",\"event\":\"e\",\"audience\":{\"type\":\"interest\",\"event\":\"v\","
                    + "\"match\":\"p\",\"min_count\":1,\"window\":{\"value\":7,\"unit\":\"FORTNIGHTS\"}}}",
                "{\"kind\":\"business_event\",\"event\":\"e\",\"filters\":{\"groups\":[{\"conditions\":"
                    + "[{\"type\":\"profile_property\",\"field\":\"a\",\"op\":\"=\",\"value\":\"1\"}]}]}," + segment
                    + "}",
                "not json")) {
            assertFalse(BusinessTrigger.fromRow(nodeRow("C", "setup_1", "setup", trigger)).isPresent(), trigger);
        }
    }

    @Test
    void onlyASetupNodeCarriesABusinessTrigger() {
        String trigger = "{\"kind\":\"business_event\",\"event\":\"e\","
            + "\"audience\":{\"type\":\"segment\",\"segment_id\":\"S\"}}";

        assertFalse(BusinessTrigger.fromRow(nodeRow("C", "check_1", "check", trigger)).isPresent());
        assertTrue(BusinessTrigger.fromRow(nodeRow("C", "setup_1", "setup", trigger)).isPresent());
    }

    @Test
    void aBusinessEventMessageParsesAndABadOneIsDropped() {
        BusinessEvent event = BusinessEvent.parse("""
            {"schema_version":1,"event_id":"0f8b","event_name":"com.acme/price_drop","event_time":1792573200000,
             "item_key":"SKU-123","app_id":"inventory-service","attributes":{"drop_percent":15}}
            """).orElseThrow();

        assertEquals(new BusinessEvent("0f8b", "com.acme/price_drop", 1792573200000L, "SKU-123",
            "{\"drop_percent\":15}"), event);
        assertEquals("com.acme/price_drop\u001FSKU-123", event.key());
        assertFalse(BusinessEvent.parse("{\"event_id\":\"x\",\"event_name\":\"n\",\"event_time\":1}").isPresent());
        assertFalse(BusinessEvent.parse("{").isPresent());
    }

    static Row nodeRow(String campaignId, String nodeId, String nodeType, String triggerJson) {
        Row row = Row.withNames();
        row.setField(CampaignNodesTable.CAMPAIGN_ID, campaignId);
        row.setField(CampaignNodesTable.NODE_ID, nodeId);
        row.setField(CampaignNodesTable.NODE_TYPE, nodeType);
        row.setField(CampaignNodesTable.TRIGGER_JSON, triggerJson);
        return row;
    }
}
