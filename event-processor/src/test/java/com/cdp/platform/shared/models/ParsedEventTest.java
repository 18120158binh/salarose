package com.cdp.platform.shared.models;

import java.util.List;

import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.java.typeutils.PojoTypeInfo;
import org.apache.flink.table.api.Schema.UnresolvedColumn;
import org.apache.flink.table.api.Schema.UnresolvedPhysicalColumn;
import org.apache.flink.types.Row;

import com.cdp.platform.shared.utils.JacksonMapper;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;

import org.junit.jupiter.api.Test;

class ParsedEventTest {

    private static final ParsedEvent EVENT = new ParsedEvent("203.0.113.7", "Mozilla/5.0", "nuid-1", 900L, 1000L,
        "shop", "view_page", "0912345678", "https://search.example/", "Home", "Shoe", "https://shop.example/",
        "a1b2c3", "web", "{\"a\":1}", "canon-1", "5f0c1a2e-8a51-4c4e-9d1b-1d2f3e4a5b6c");

    /**
     * The columns of snowplow-parsed, in the order the job has always published
     * them.
     */
    @Test
    void theSchemaListsThePublishedColumnsInOrder() {
        List<String> columns = ParsedEvent
            .schema()
            .getColumns()
            .stream()
            .map(column -> column.getName() + " " + ((UnresolvedPhysicalColumn) column).getDataType())
            .toList();

        assertEquals(List
            .of("ip STRING", "user_agent STRING", "network_userid STRING", "event_timestamp BIGINT",
                "collector_timestamp BIGINT", "app_id STRING", "event_name STRING", "user_id STRING",
                "referrer_url STRING", "screen_location STRING", "product_name STRING", "url STRING",
                "domain_userid STRING", "platform STRING", "event_json STRING", "canon_id STRING", "event_id STRING"),
            columns);
        assertEquals(ParsedEvent.schema().getColumns().stream().map(UnresolvedColumn::getName).toList(),
            List.of(ParsedEvent.ROW_TYPE.getFieldNames()));
    }

    @Test
    void eachRowFieldHoldsTheValueOfItsColumn() {
        Row row = EVENT.toRow();
        String[] names = ParsedEvent.ROW_TYPE.getFieldNames();

        assertEquals("url", names[11]);
        assertEquals("https://shop.example/", row.getField(11));
        assertEquals("domain_userid", names[12]);
        assertEquals("a1b2c3", row.getField(12));
        assertEquals(900L, row.getField(3));
        assertEquals(1000L, row.getField(4));
    }

    @Test
    void itsJsonUsesThePublishedColumnNames() {
        assertEquals("""
            {"ip":"203.0.113.7","user_agent":"Mozilla/5.0","network_userid":"nuid-1","event_timestamp":900,\
            "collector_timestamp":1000,"app_id":"shop","event_name":"view_page","user_id":"0912345678",\
            "referrer_url":"https://search.example/","screen_location":"Home","product_name":"Shoe",\
            "url":"https://shop.example/","domain_userid":"a1b2c3","platform":"web","event_json":"{\\"a\\":1}",\
            "canon_id":"canon-1","event_id":"5f0c1a2e-8a51-4c4e-9d1b-1d2f3e4a5b6c"}""",
            JacksonMapper.writeValueAsString(EVENT));
    }

    @Test
    void flinkSerializesItWithoutKryo() {
        assertInstanceOf(PojoTypeInfo.class, TypeInformation.of(ParsedEvent.class));
    }
}
