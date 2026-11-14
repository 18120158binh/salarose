package com.cdp.platform.jobs.importapplier;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * DIM-FR-26 and DIM-FR-27 hold by construction: the applier has no Kafka
 * producer, so no import reaches {@code journey-engine-matched-events}, and
 * the tables it names are the import store's, the run and dataset tables, and
 * {@code identity_graph}, which it only reads for the match rate.
 */
class ApplierBoundaryTest {

    private static final Path SOURCES = Path.of("src/main/java/com/cdp/platform/jobs/importapplier");
    private static final Pattern TABLE = Pattern.compile("\\b(\\w+Table)\\.");

    private static List<String> sources() throws IOException {
        try (Stream<Path> files = Files.list(SOURCES)) {
            return files.filter(file -> file.toString().endsWith(".java")).map(file -> {
                try {
                    return Files.readString(file);
                } catch (IOException e) {
                    throw new IllegalStateException(e);
                }
            }).toList();
        }
    }

    @Test
    void theApplierUsesNoKafkaAndNoFlink() throws IOException {
        List<String> sources = sources();
        assertTrue(sources.size() > 10, "the applier's sources were found");
        for (String source : sources) {
            assertTrue(!source.contains("org.apache.kafka") && !source.contains("org.apache.flink"),
                "an applier class imports Kafka or Flink");
        }
    }

    @Test
    void theApplierNamesNoIdentityTableButTheOneItReads() throws IOException {
        Set<String> named = new TreeSet<>();
        for (String source : sources()) {
            Matcher table = TABLE.matcher(source);
            while (table.find())
                named.add(table.group(1));
        }
        assertEquals(Set
            .of("IdentityGraphTable", "ImportIdentifiersTable", "ImportProfilesTable", "ImportRecordTypesTable",
                "ImportRecordsTable", "ImportRunCommitsTable", "ImportRunsTable", "PersonTombstonesTable"),
            named);
        String lookups = Files.readString(SOURCES.resolve("PostgresLookups.java"));
        assertTrue(!lookups.contains("INSERT") && !lookups.contains("UPDATE") && !lookups.contains("DELETE"),
            "the class that names identity_graph only reads");
    }
}
