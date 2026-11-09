package com.cdp.platform.shared.db.repositories;

import java.util.Map;

import org.apache.flink.api.connector.source.Source;
import org.apache.flink.cdc.connectors.postgres.source.PostgresSourceBuilder.PostgresIncrementalSource;
import org.apache.flink.configuration.Configuration;
import org.apache.flink.table.api.DataTypes;
import org.apache.flink.table.api.EnvironmentSettings;
import org.apache.flink.table.api.Schema;
import org.apache.flink.table.api.TableDescriptor;
import org.apache.flink.table.api.TableEnvironment;
import org.apache.flink.table.catalog.CatalogTable;
import org.apache.flink.table.catalog.ObjectIdentifier;
import org.apache.flink.table.catalog.ResolvedCatalogTable;
import org.apache.flink.table.catalog.ResolvedSchema;
import org.apache.flink.table.connector.source.DynamicTableSource;
import org.apache.flink.table.connector.source.ScanTableSource;
import org.apache.flink.table.connector.source.ScanTableSource.ScanRuntimeProvider;
import org.apache.flink.table.connector.source.SourceProvider;
import org.apache.flink.table.factories.FactoryUtil;
import org.apache.flink.table.runtime.connector.source.ScanRuntimeProviderContext;

import com.cdp.platform.shared.config.DatabaseConfig;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;

import org.junit.jupiter.api.Test;

class PostgresCdcTest {

    private static final DatabaseConfig DATABASE = new DatabaseConfig("db.internal", "6432", "flink", "secret", "cdp",
        "jdbc:postgresql://db.internal:6432/cdp", "jdbc:postgresql://db.internal:6432/cdp", 7);
    private static final Schema SCHEMA = Schema
        .newBuilder()
        .column("id", DataTypes.STRING().notNull())
        .primaryKey("id")
        .build();

    @Test
    void aSourceReadsTheTableThroughItsPublicationAndTheJobsSlot() {
        TableDescriptor source = PostgresCdc.source(DATABASE, "campaigns", "campaigns_pub", "decision_slot", SCHEMA);
        Map<String, String> options = source.getOptions();

        assertEquals("postgres-cdc", options.get("connector"));
        assertEquals("db.internal", options.get("hostname"));
        assertEquals("6432", options.get("port"));
        assertEquals("flink", options.get("username"));
        assertEquals("secret", options.get("password"));
        assertEquals("cdp", options.get("database-name"));
        assertEquals("public", options.get("schema-name"));
        assertEquals("campaigns", options.get("table-name"));
        assertEquals("pgoutput", options.get("decoding.plugin.name"));
        assertEquals("decision_slot", options.get("slot.name"));
        assertEquals("campaigns_pub", options.get("debezium.publication.name"));
        assertEquals("true", options.get("debezium.slot.failover"));
        assertEquals(SCHEMA, source.getSchema().orElseThrow());
    }

    /**
     * A restore from an older checkpoint, or from a savepoint taken before a
     * deploy, needs the slot to still hold the changes after it. Only the
     * connector's incremental snapshot source delays the position it confirms to
     * the slot, by the number of completed checkpoints in
     * {@code scan.lsn-commit.checkpoints-num-delay}. The other source confirms the
     * position of every checkpoint as it completes. The connector rejects an
     * option it does not know, so building the source also checks the option
     * names.
     */
    @Test
    void aSourceConfirmsALogPositionToTheSlotTheConfiguredCheckpointsLater() {
        TableDescriptor descriptor = PostgresCdc
            .source(DATABASE, "campaigns", "campaigns_pub", "decision_slot", SCHEMA);

        assertInstanceOf(PostgresIncrementalSource.class, runtimeSource(descriptor));
        assertEquals("7", descriptor.getOptions().get("scan.lsn-commit.checkpoints-num-delay"));
    }

    /**
     * The source the connector builds for the table, as the planner asks for it.
     */
    private static Source<?, ?, ?> runtimeSource(TableDescriptor descriptor) {
        TableEnvironment tables = TableEnvironment.create(EnvironmentSettings.inStreamingMode());
        tables.createTemporaryTable("cdc_source", descriptor);
        ResolvedSchema schema = tables.from("cdc_source").getResolvedSchema();
        CatalogTable table = CatalogTable
            .newBuilder()
            .schema(descriptor.getSchema().orElseThrow())
            .options(descriptor.getOptions())
            .build();
        DynamicTableSource source = FactoryUtil
            .createDynamicTableSource(null, ObjectIdentifier.of("default_catalog", "default_database", "cdc_source"),
                new ResolvedCatalogTable(table, schema), Map.of(), new Configuration(),
                PostgresCdcTest.class.getClassLoader(), true);
        ScanRuntimeProvider provider = assertInstanceOf(ScanTableSource.class, source)
            .getScanRuntimeProvider(ScanRuntimeProviderContext.INSTANCE);
        return assertInstanceOf(SourceProvider.class, provider).createSource();
    }
}
