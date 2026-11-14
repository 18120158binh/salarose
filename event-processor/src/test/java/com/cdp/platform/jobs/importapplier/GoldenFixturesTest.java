package com.cdp.platform.jobs.importapplier;

import java.io.IOException;
import java.io.InputStream;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;

import com.cdp.platform.shared.models.imports.DatasetVersion;
import com.cdp.platform.shared.utils.PlaceholderIds;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

/**
 * Runs every golden fixture in {@code test-fixtures/data-import}: an input
 * file, the dataset version it is read with, and the report it must give.
 * Studio's dry run reads the same folder (DIM-FR-16), so a fixture is the
 * contract between the two.
 */
class GoldenFixturesTest {

    private static final Path FIXTURES = Path.of("..", "test-fixtures", "data-import");
    private static final ObjectMapper JSON = new ObjectMapper();

    @TestFactory
    Stream<DynamicTest> everyFixtureGivesItsExpectedReport() throws IOException {
        List<Path> cases;
        try (Stream<Path> folders = Files.list(FIXTURES)) {
            cases = folders.filter(Files::isDirectory).sorted().toList();
        }
        assertTrue(cases.size() >= 10, "the golden fixtures are missing");
        return cases
            .stream()
            .map(folder -> DynamicTest
                .dynamicTest(folder.getFileName().toString(),
                    () -> check(folder)));
    }

    private static void check(Path folder) throws Exception {
        JsonNode spec = JSON.readTree(folder.resolve("case.json").toFile());
        JsonNode expected = JSON.readTree(folder.resolve("expected.json").toFile());
        String format = spec.get("format").asText();
        Path input = folder.resolve("input." + format);
        DatasetVersion version = DatasetVersion
            .parse("00000000-0000-0000-0000-000000000001", 1,
                spec.get("kind").asText(), spec.get("columns"), spec.get("roles"), spec.get("deliveryMode").asText(),
                spec.get("timeZone").asText(), spec.get("delimiter").asText());
        String tombstoneKey = spec.get("tombstoneKey").asText();
        Set<String> hashes = new HashSet<>();
        spec.get("tombstonedKeys").forEach(key -> hashes.add(Tombstones.of(tombstoneKey, key.asText())));
        List<String> placeholders = new ArrayList<>();
        spec.get("placeholders").forEach(value -> placeholders.add(value.asText()));
        RowValidator validator = new RowValidator(version, new Contacts(spec.get("phoneCountry").asText()),
            PlaceholderIds.parse(String.join(",", placeholders)), new Tombstones(tombstoneKey, hashes),
            Instant.parse(spec.get("startedAt").asText()), Limits.DEFAULT.historyLimit(),
            Limits.DEFAULT.futureLimit());
        RecordingRejects rejects = new RecordingRejects();
        RecordingLookups lookups = new RecordingLookups();
        FileValidation validation = new FileValidation(version, validator, lookups, rejects,
            valid -> lookups.byKey.put(valid.customerKey(), valid), LockGuard.none());
        byte[] bytes = Files.readAllBytes(input);
        FileValidation.Delivered delivered = new FileValidation.Delivered(format, bytes.length, sha256(bytes));

        List<String> failures = new ArrayList<>();
        ValidationStats stats = null;
        try (InputStream in = Files.newInputStream(input)) {
            stats = validation.validate(delivered, in);
        } catch (FileFailure failure) {
            failures = failure.reasons();
        }
        assertEquals(strings(expected.get("fileFailures")), failures, "file-level failures");
        if (stats == null) return;

        ObjectNode counts = RunReport.counts(stats);
        JsonNode expectedCounts = expected.get("counts");
        expectedCounts
            .fieldNames()
            .forEachRemaining(name -> assertTrue(
                expectedCounts.get(name).equals(NUMERIC, counts.get(name)),
                "count " + name + ": " + counts.get(name) + " is not " + expectedCounts.get(name)));
        List<Map<String, Object>> expectedRejects = new ArrayList<>();
        expected
            .get("rejects")
            .forEach(reject -> expectedRejects
                .add(Map
                    .of("line", reject.get("line").asLong(),
                        "reason", reject.get("reason").asText())));
        assertEquals(expectedRejects, rejects.rows, "rejects");
        List<Map<String, Object>> samples = stats.samples
            .stream()
            .map(sample -> Map.<String, Object>of("line", sample.line(), "reason", sample.reason()))
            .toList();
        assertEquals(expectedRejects.subList(0, Math.min(ValidationStats.SAMPLE_LIMIT, expectedRejects.size())),
            samples, "report samples");
        assertEquals(strings(expected.get("conditions")),
            Decision.conditions(stats, version, true, null, 0, Limits.DEFAULT), "quarantine conditions");

        JsonNode validRows = expected.get("validRows");
        if (validRows == null) return;
        for (JsonNode row : validRows) {
            RowValidator.Valid valid = lookups.byKey.get(row.get("customerKey").asText());
            if (valid == null) fail("no valid row for line " + row.get("line"));
            if (row.has("recordId")) assertEquals(row.get("recordId").asText(), valid.recordId());
            if (!row.get("data").equals(NUMERIC, valid.data())) {
                fail("line " + row.get("line") + ": data " + valid.data() + " is not " + row.get("data"));
            }
            if (row.has("emails")) assertEquals(strings(row.get("emails")), valid.emails());
            if (row.has("phones")) assertEquals(strings(row.get("phones")), valid.phones());
        }
    }

    /** Numbers compare by value, so 120.50 in a file equals 120.5 in a fixture. */
    private static final Comparator<JsonNode> NUMERIC = (a, b) -> {
        if (a.isNumber() && b.isNumber()) return new BigDecimal(a.asText()).compareTo(new BigDecimal(b.asText()));
        return a.equals(b) ? 0 : 1;
    };

    private static List<String> strings(JsonNode array) {
        List<String> values = new ArrayList<>();
        if (array != null) array.forEach(value -> values.add(value.asText()));
        return values;
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static final class RecordingRejects implements RejectsSink {
        final List<Map<String, Object>> rows = new ArrayList<>();

        @Override
        public void write(long line, String reason, Map<String, JsonNode> raw) {
            rows.add(Map.of("line", line, "reason", reason));
        }
    }

    /** Lookups with an empty store, and the valid rows the file gave. */
    static final class RecordingLookups implements Lookups {
        final Map<String, RowValidator.Valid> byKey = new HashMap<>();

        @Override
        public int matchedUserIds(List<String> customerKeys) {
            return 0;
        }

        @Override
        public int storedRecordIds(String recordTypeId, List<String> recordIds) {
            return 0;
        }

        @Override
        public Shared sharedContacts(List<Contact> contacts) {
            return new Shared(0, 0);
        }

        @Override
        public long storedRecords() {
            return 0;
        }
    }
}
