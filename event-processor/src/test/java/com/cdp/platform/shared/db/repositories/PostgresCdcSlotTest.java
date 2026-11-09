package com.cdp.platform.shared.db.repositories;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import org.apache.flink.table.api.TableDescriptor;

import com.cdp.platform.shared.config.DatabaseConfig;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.debezium.config.Configuration;
import io.debezium.connector.postgresql.PostgresConnectorConfig;
import io.debezium.heartbeat.DatabaseHeartbeatImpl;
import io.debezium.heartbeat.Heartbeat;
import io.debezium.relational.RelationalDatabaseConnectorConfig;
import io.debezium.relational.TableId;
import org.junit.jupiter.api.Test;

/**
 * A job restores its CDC log position from a checkpoint. The replication slot
 * must still exist after the job stops, so that it keeps the changes made
 * while the job was down. Debezium reports its position on a heartbeat, so
 * that a checkpoint can confirm it to the slot while the captured table is
 * quiet. On Postgres 15 and later the slot sends nothing while the captured
 * table is quiet, so each heartbeat also writes the source's own row in
 * {@code cdc_heartbeat}, which every publication covers. The connector passes
 * every {@code debezium.} option to Debezium.
 */
class PostgresCdcSlotTest {

    private static final DatabaseConfig DATABASE = new DatabaseConfig("postgres", "5432", "flink", "secret", "cdp",
        null, null, 10);
    private static final String DEBEZIUM_PREFIX = "debezium.";
    private static final long HEARTBEAT_INTERVAL_MS = Duration.ofSeconds(30).toMillis();

    @Test
    void campaignNodesSlotSurvivesAStopAndSendsHeartbeats() {
        assertSlotSettings(CampaignNodeRepository.createCdcSourceDescriptor(DATABASE, "nodes_slot"),
            "nodes_slot");
    }

    @Test
    void transitionsSlotSurvivesAStopAndSendsHeartbeats() {
        assertSlotSettings(
            UserCampaignStateTransitionRepository.createCdcSourceDescriptor(DATABASE, "transitions_slot"),
            "transitions_slot");
    }

    @Test
    void campaignsSlotSurvivesAStopAndSendsHeartbeats() {
        assertSlotSettings(CampaignRepository.createCdcSourceDescriptor(DATABASE, "campaigns_slot"),
            "campaigns_slot");
    }

    @Test
    void metricDefinitionsSlotSurvivesAStopAndSendsHeartbeats() {
        assertSlotSettings(UserMetricDefinitionRepository.descriptor(DATABASE, "metric_defs_slot"),
            "metric_defs_slot");
    }

    @Test
    void catalogSlotsSurviveAStopAndSendHeartbeats() {
        assertSlotSettings(UserEventCatalogRepository.eventDescriptor(DATABASE, "catalog_events_slot"),
            "catalog_events_slot");
        assertSlotSettings(UserEventCatalogRepository.attributeDescriptor(DATABASE, "catalog_fields_slot"),
            "catalog_fields_slot");
    }

    @Test
    void heartbeatRowsNeverReachTheJobs() {
        List<TableDescriptor> sources = List
            .of(CampaignNodeRepository.createCdcSourceDescriptor(DATABASE, "nodes_slot"),
                UserCampaignStateTransitionRepository.createCdcSourceDescriptor(DATABASE, "transitions_slot"),
                CampaignRepository.createCdcSourceDescriptor(DATABASE, "campaigns_slot"),
                UserMetricDefinitionRepository.descriptor(DATABASE, "metric_defs_slot"),
                UserEventCatalogRepository.eventDescriptor(DATABASE, "catalog_events_slot"),
                UserEventCatalogRepository.attributeDescriptor(DATABASE, "catalog_fields_slot"));

        for (TableDescriptor source : sources) {
            String table = source.getOptions().get("table-name");
            assertTrue(captures(source, new TableId(null, "public", table)), table + " is not captured");
            assertFalse(captures(source, new TableId(null, "public", "cdc_heartbeat")),
                "The " + table + " source emits heartbeat rows");
        }
    }

    private static void assertSlotSettings(TableDescriptor source, String slotName) {
        Map<String, String> options = source.getOptions();
        Configuration debezium = Configuration.from(debeziumProperties(options));

        assertEquals(slotName, options.get("slot.name"));
        assertFalse(debezium.getBoolean(PostgresConnectorConfig.DROP_SLOT_ON_STOP),
            "Debezium drops slot " + slotName + " when the job stops");
        assertEquals(HEARTBEAT_INTERVAL_MS, debezium.getLong(Heartbeat.HEARTBEAT_INTERVAL));
        assertEquals("insert into \"cdc_heartbeat\" (\"slot_name\", \"beat_at\") values ('" + slotName
            + "', current_timestamp) on conflict (\"slot_name\") do update set \"beat_at\" = current_timestamp",
            debezium.getString(DatabaseHeartbeatImpl.HEARTBEAT_ACTION_QUERY));
    }

    /**
     * Whether Debezium turns a change to the table into a record. The slot
     * streams every table of its publication, and Debezium drops the changes to
     * tables outside {@code table.include.list}. The connector sets it to
     * {@code schema-name.table-name}, and the server name to
     * {@code postgres_cdc_source}.
     */
    private static boolean captures(TableDescriptor source, TableId table) {
        Map<String, String> options = source.getOptions();
        Configuration debezium = Configuration
            .from(debeziumProperties(options))
            .edit()
            .with(RelationalDatabaseConnectorConfig.SERVER_NAME, "postgres_cdc_source")
            .with(RelationalDatabaseConnectorConfig.TABLE_INCLUDE_LIST,
                options.get("schema-name") + "." + options.get("table-name"))
            .build();
        return new PostgresConnectorConfig(debezium).getTableFilters().dataCollectionFilter().isIncluded(table);
    }

    private static Map<String, String> debeziumProperties(Map<String, String> options) {
        return options
            .entrySet()
            .stream()
            .filter(option -> option.getKey().startsWith(DEBEZIUM_PREFIX))
            .collect(Collectors
                .toMap(option -> option.getKey().substring(DEBEZIUM_PREFIX.length()), Map.Entry::getValue));
    }
}
