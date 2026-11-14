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
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * The segment membership pass's tables: the metamodel names exactly the
 * columns that {@code schema.sql} and migration V0007 create, and neither
 * table joins a publication (SMP-NFR-03).
 */
class SegmentImportTablesSchemaTest {

    private static final Path SCHEMA = Path.of("..", "infra", "db", "schema.sql");
    private static final Path MIGRATION = Path
        .of("..", "infra", "db", "migrations",
            "V0007__segment_import_members.sql");

    @Test
    void segmentImportMembersMatchesTheSchemaAndTheMigration() throws IOException {
        assertEquals(SegmentImportMembersTable.COLUMNS, columns(SCHEMA, SegmentImportMembersTable.TABLE_NAME));
        assertEquals(SegmentImportMembersTable.COLUMNS, columns(MIGRATION, SegmentImportMembersTable.TABLE_NAME));
    }

    @Test
    void segmentMembershipPassesMatchesTheSchemaAndTheMigration() throws IOException {
        assertEquals(SegmentMembershipPassesTable.COLUMNS, columns(SCHEMA, SegmentMembershipPassesTable.TABLE_NAME));
        assertEquals(SegmentMembershipPassesTable.COLUMNS,
            columns(MIGRATION, SegmentMembershipPassesTable.TABLE_NAME));
    }

    @Test
    void neitherTableJoinsAPublication() throws IOException {
        String publications = Files
            .readString(SCHEMA)
            .lines()
            .filter(line -> line.toLowerCase(Locale.ROOT).contains("publication"))
            .reduce("", String::concat);
        assertFalse(publications.contains(SegmentImportMembersTable.TABLE_NAME));
        assertFalse(publications.contains(SegmentMembershipPassesTable.TABLE_NAME));
    }

    private static List<String> columns(Path file, String table) throws IOException {
        Matcher create = Pattern
            .compile("CREATE TABLE IF NOT EXISTS " + table + " \\((.*?)\\n\\s*\\);", Pattern.DOTALL)
            .matcher(Files.readString(file).replace("\r\n", "\n"));
        assertTrue(create.find(), () -> file + " has no CREATE TABLE for " + table);
        return Arrays
            .stream(create.group(1).split("\\n"))
            .map(String::trim)
            .filter(line -> !line.isEmpty() && !line.startsWith("--"))
            .map(line -> line.split("[\\s,(]+")[0].toLowerCase(Locale.ROOT))
            .filter(word -> !List.of("primary", "unique", "foreign", "check", "constraint").contains(word))
            .toList();
    }
}
