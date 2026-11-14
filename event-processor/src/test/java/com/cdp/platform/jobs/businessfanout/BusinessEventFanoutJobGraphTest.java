package com.cdp.platform.jobs.businessfanout;

import java.util.List;
import java.util.Map;

import com.cdp.platform.shared.config.DatabaseConfig;
import com.cdp.platform.shared.config.EnvironmentSettings;
import com.cdp.platform.shared.db.repositories.CdcStreamOrder;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class BusinessEventFanoutJobGraphTest {

    private static final DatabaseConfig DATABASE = new DatabaseConfig("postgres", "5432", "cdp", "unused", "cdp",
        "jdbc:postgresql://postgres:5432/cdp", "jdbc:postgresql://postgres-replica:5432/cdp", 10);

    private static final EnvironmentSettings ENV = new EnvironmentSettings(Map.of());

    @Test
    void everyCdcStreamKeepsItsLogOrder() {
        assertEquals(List.of(),
            CdcStreamOrder.breaks(BusinessEventFanoutJob.buildPipeline(DATABASE, CdcStreamOrder.settings(), ENV)));
    }

    @Test
    void theJobGraphBuilds() {
        assertDoesNotThrow(() -> BusinessEventFanoutJob
            .buildPipeline(DATABASE, CdcStreamOrder.settings(), ENV)
            .getStreamGraph()
            .getJobGraph());
    }

    @Test
    void aParsedEventBecomesAPersonEventAndOneWithoutACanonIdDoesNot() {
        var event = BusinessEventFanoutJob
            .personEvent("{\"canon_id\":\"A\",\"event_name\":\"view_product\",\"event_timestamp\":5,"
                + "\"collector_timestamp\":7,\"event_json\":\"{\\\"product\\\":{\\\"id\\\":\\\"SKU-1\\\"}}\"}")
            .orElseThrow();

        assertEquals(7L, event.collectorTimestamp());
        assertEquals("SKU-1", event.propertyValue("product.id"));
        assertTrue(BusinessEventFanoutJob.personEvent("{\"event_name\":\"v\",\"event_timestamp\":5}").isEmpty());
        assertTrue(BusinessEventFanoutJob.personEvent("nope").isEmpty());
    }

    @Test
    void aMembershipChangeLandsOnTheShardOfItsCanonId() {
        IndexInput entered = BusinessEventFanoutJob
            .membershipChange("{\"canon_id\":\"A\",\"segment_id\":\"S\",\"change\":\"entered\",\"event_time\":1}")
            .orElseThrow();
        IndexInput exited = BusinessEventFanoutJob
            .membershipChange("{\"canon_id\":\"A\",\"segment_id\":\"S\",\"change\":\"exited\",\"event_time\":2}")
            .orElseThrow();

        assertEquals(entered.indexKey(), exited.indexKey());
        assertEquals(IndexInput.Kind.EXITED, exited.observation().kind());
        assertTrue(BusinessEventFanoutJob.membershipChange("{\"segment_id\":\"S\"}").isEmpty());
    }
}
