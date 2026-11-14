package com.cdp.platform.shared.db.repositories;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * The metamodel of each data import table names exactly the columns its DDL
 * file creates, in order: {@code customer_attributes} in the main
 * {@code schema.sql}, and the import store's tables in its own file. A renamed
 * column fails here, not when a job starts.
 */
class ImportTablesSchemaTest {

    private static final Path MAIN_SCHEMA = Path.of("..", "infra", "db", "schema.sql");
    private static final Path IMPORT_STORE_SCHEMA = Path.of("..", "infra", "db", "import-store", "schema.sql");

    @Test
    void customerAttributesMatchesTheMainSchema() throws IOException {
        assertEquals(definedColumns(MAIN_SCHEMA, CustomerAttributesTable.TABLE_NAME), CustomerAttributesTable.COLUMNS);
    }

    @Test
    void importRecordsMatchesTheImportStoreSchema() throws IOException {
        assertEquals(definedColumns(IMPORT_STORE_SCHEMA, ImportRecordsTable.TABLE_NAME), ImportRecordsTable.COLUMNS);
    }

    @Test
    void importProfilesMatchesTheImportStoreSchema() throws IOException {
        assertEquals(definedColumns(IMPORT_STORE_SCHEMA, ImportProfilesTable.TABLE_NAME), ImportProfilesTable.COLUMNS);
    }

    @Test
    void importIdentifiersMatchesTheImportStoreSchema() throws IOException {
        assertEquals(definedColumns(IMPORT_STORE_SCHEMA, ImportIdentifiersTable.TABLE_NAME),
            ImportIdentifiersTable.COLUMNS);
    }

    @Test
    void importRunCommitsMatchesTheImportStoreSchema() throws IOException {
        assertEquals(definedColumns(IMPORT_STORE_SCHEMA, ImportRunCommitsTable.TABLE_NAME),
            ImportRunCommitsTable.COLUMNS);
    }

    /**
     * The first word of each column line in the table's {@code CREATE TABLE},
     * in order, without the table constraint lines.
     */
    private static List<String> definedColumns(Path schema, String table) throws IOException {
        Matcher create = Pattern
            .compile("CREATE TABLE IF NOT EXISTS " + table + " \\((.*?)\\n\\s*\\);", Pattern.DOTALL)
            .matcher(Files.readString(schema));
        assertTrue(create.find(), () -> schema + " has no CREATE TABLE for " + table);
        return Arrays
            .stream(create.group(1).split("\\n"))
            .map(String::trim)
            .filter(line -> !line.isEmpty() && !line.startsWith("--"))
            .map(line -> line.split("[\\s,(]+")[0].toLowerCase(Locale.ROOT))
            .filter(word -> !List.of("primary", "unique", "foreign", "check", "constraint").contains(word))
            .toList();
    }
}
