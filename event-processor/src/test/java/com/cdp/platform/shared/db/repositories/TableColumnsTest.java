package com.cdp.platform.shared.db.repositories;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

import org.apache.flink.table.api.Schema;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * Every column a CDC source reads, and every column a jOOQ query of a
 * {@code *Table} class names, must exist in {@code schema.sql}, so a renamed
 * column fails here and not when the job starts. There is no Postgres in the
 * tests, so this reads the file.
 */
class TableColumnsTest {

    private static final Path SCHEMA_SQL = Path.of("..", "infra", "db", "schema.sql");
    private static final Pattern ALIAS = Pattern.compile(" as \"[^\"]+\"");
    private static final Pattern QUOTED_IDENTIFIER = Pattern.compile("\"([^\"]+)\"");

    @Test
    void campaignsSourceReadsOnlyDefinedColumns() throws IOException {
        assertDefined(CampaignsTable.TABLE_NAME, CampaignsTable.cdcSchema());
    }

    @Test
    void campaignNodesSourcesReadOnlyDefinedColumns() throws IOException {
        assertDefined(CampaignNodesTable.TABLE_NAME, CampaignNodesTable.cdcSchema());
        assertDefined(CampaignNodesTable.TABLE_NAME, CampaignNodesTable.graphCdcSchema());
    }

    @Test
    void theGraphSourceAddsOnlyTheSaveSizeToTheNodeColumns() {
        Set<String> nodeColumns = physicalColumns(CampaignNodesTable.cdcSchema());
        Set<String> graphColumns = physicalColumns(CampaignNodesTable.graphCdcSchema());

        graphColumns.removeAll(nodeColumns);
        assertEquals(Set.of(CampaignNodesTable.CAMPAIGN_NODE_COUNT), graphColumns);
    }

    @Test
    void metricDefinitionsSourceReadsOnlyDefinedColumns() throws IOException {
        assertDefined(UserMetricDefinitionsTable.TABLE_NAME, UserMetricDefinitionsTable.cdcSchema());
    }

    @Test
    void catalogSourcesReadOnlyDefinedColumns() throws IOException {
        assertDefined(UserEventsTable.TABLE_NAME, UserEventsTable.cdcSchema());
        assertDefined(UserEventFieldsTable.TABLE_NAME, UserEventFieldsTable.cdcSchema());
    }

    @Test
    void transitionsSourceReadsOnlyDefinedColumns() throws IOException {
        assertDefined(UserCampaignStateTransitionsTable.TABLE_NAME, UserCampaignStateTransitionsTable.cdcSchema());
    }

    @Test
    void identityGraphSinkWritesOnlyDefinedColumns() throws IOException {
        assertDefined(IdentityGraphTable.TABLE_NAME,
            columns(IdentityGraphTable.TABLE_NAME, IdentityGraphTable.upsertQuery().getSQL()));
    }

    @Test
    void identityGraphLookupReadsOnlyDefinedColumns() throws IOException {
        assertDefined(IdentityGraphTable.TABLE_NAME,
            columns(IdentityGraphTable.TABLE_NAME, IdentityGraphTable.lookupQuery("d2", "u1").getSQL()));
    }

    private static void assertDefined(String table, Schema schema) throws IOException {
        assertDefined(table, physicalColumns(schema));
    }

    private static void assertDefined(String table, Set<String> columns) throws IOException {
        Set<String> missing = new LinkedHashSet<>(columns);
        missing.removeAll(definedColumns(table));
        assertEquals(Set.of(), missing, () -> table + " columns missing from schema.sql");
    }

    /**
     * The quoted identifiers of a query on {@code table}, without its aliases and
     * the table's own name.
     */
    private static Set<String> columns(String table, String sql) {
        Set<String> identifiers = QUOTED_IDENTIFIER
            .matcher(ALIAS.matcher(sql).replaceAll(""))
            .results()
            .map(identifier -> identifier.group(1))
            .collect(Collectors.toCollection(LinkedHashSet::new));
        identifiers.remove(table);
        return identifiers;
    }

    private static Set<String> physicalColumns(Schema schema) {
        return schema
            .getColumns()
            .stream()
            .filter(Schema.UnresolvedPhysicalColumn.class::isInstance)
            .map(Schema.UnresolvedColumn::getName)
            .collect(Collectors.toSet());
    }

    /**
     * The first word of each line in the table's {@code CREATE TABLE}, lower
     * case. Constraint lines add words that are not columns, which is harmless
     * for a check that every read column is among them.
     */
    private static Set<String> definedColumns(String table) throws IOException {
        Matcher create = Pattern
            .compile("CREATE TABLE IF NOT EXISTS " + table + " \\((.*?)\\n\\s*\\);", Pattern.DOTALL)
            .matcher(Files.readString(SCHEMA_SQL));
        assertTrue(create.find(), "schema.sql has no CREATE TABLE for " + table);
        return Arrays
            .stream(create.group(1).split("\\n"))
            .map(String::trim)
            .filter(line -> !line.isEmpty() && !line.startsWith("--"))
            .map(line -> line.split("[\\s,(]+")[0].toLowerCase(Locale.ROOT))
            .collect(Collectors.toSet());
    }
}
