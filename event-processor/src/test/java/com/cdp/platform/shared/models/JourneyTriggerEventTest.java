package com.cdp.platform.shared.models;

import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class JourneyTriggerEventTest {

    @Test
    void aTriggerBuiltHereCarriesTheVersionAReaderAssumesForAMessageWithoutOne() {
        Row withoutVersion = Row.withNames(RowKind.INSERT);
        withoutVersion.setField("canon_id", "customer-42");
        withoutVersion.setField("campaign_id", "CAMP-0001");
        withoutVersion.setField("node_id", "node-2");
        withoutVersion.setField("branch", "yes");
        withoutVersion.setField("event_time", 1_785_800_000_000L);

        JourneyTriggerEvent read = JourneyTriggerEvent.parse(withoutVersion).valueOrThrow();
        JourneyTriggerEvent built = new JourneyTriggerEvent("customer-42", null, null, null, "CAMP-0001", "node-2",
            "yes", "add_to_cart", 1_785_800_000_000L, null);

        assertEquals(read.schemaVersion(), built.schemaVersion());
    }
}
