package com.cdp.platform.shared.db.repositories;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

// The deployed database got schema.sql only at its first bootstrap, so the upgrade note must
// build exactly the indexes schema.sql defines for studio v2's reads (decision 0035).
class StudioReadIndexesSchemaTest {

    private static final Path SCHEMA_SQL = Path.of("..", "infra", "db", "schema.sql");
    private static final Path DEPLOYMENT_MD = Path.of("..", "docs", "internal", "operations", "deployment.md");
    private static final String NOTE_HEADING = "### Studio v2 read indexes";
    private static final Pattern CREATE_INDEX = Pattern
        .compile(
            "CREATE INDEX (?:CONCURRENTLY )?IF NOT EXISTS (\\w+)\\s+(ON[^;]*);", Pattern.CASE_INSENSITIVE);

    private static final Map<String, String> EXPECTED = Map
        .of(
            "idx_ucst_node_reach",
            "on user_campaign_state_transitions (campaign_id, node_id, branch, event_timestamp)"
                + " include (canon_id, entry_id)",
            "idx_ucst_type_event_time",
            "on user_campaign_state_transitions (node_type, event_timestamp) include (campaign_id, branch)",
            "idx_ucst_type_written",
            "on user_campaign_state_transitions (node_type, transitioned_at) include (event_timestamp, branch)",
            "idx_ig_canon",
            "on identity_graph (canon_id) include (domain_userid, user_id, created_at, updated_at)");

    @Test
    void schemaDefinesTheIndexesOfDecision0035() throws IOException {
        Map<String, String> schema = indexes(Files.readString(SCHEMA_SQL));

        EXPECTED.forEach((name, definition) -> assertEquals(definition, schema.get(name), name));
    }

    @Test
    void upgradeNoteBuildsTheSameIndexesConcurrently() throws IOException {
        Map<String, String> schema = indexes(Files.readString(SCHEMA_SQL));
        String note = upgradeNote(Files.readString(DEPLOYMENT_MD));
        Map<String, String> noted = indexes(note);

        assertEquals(EXPECTED.keySet(), noted.keySet());
        noted.forEach((name, definition) -> assertEquals(schema.get(name), definition, name));
        assertEquals(EXPECTED.size(), count(note, "CREATE INDEX CONCURRENTLY IF NOT EXISTS"));
    }

    @Test
    void olderNodeStatsIndexStaysUntilTheExplainDecides() throws IOException {
        Map<String, String> schema = indexes(Files.readString(SCHEMA_SQL));

        assertEquals("on user_campaign_state_transitions (campaign_id, node_id, canon_id, entry_id)",
            schema.get("idx_ucst_campaign_node"));
    }

    private static Map<String, String> indexes(String sql) {
        Map<String, String> found = new LinkedHashMap<>();
        Matcher m = CREATE_INDEX.matcher(sql);
        while (m.find()) {
            found.put(m.group(1), normalize(m.group(2)));
        }
        return found;
    }

    private static String normalize(String definition) {
        String flat = definition.replaceAll("--[^\\n]*", "").replaceAll("\\s+", " ").toLowerCase(Locale.ROOT);
        return flat.replaceAll("\\( ", "(").replaceAll(" \\)", ")").trim();
    }

    private static String upgradeNote(String markdown) {
        int start = markdown.indexOf(NOTE_HEADING);
        assertTrue(start >= 0, "deployment.md has no upgrade note " + NOTE_HEADING);
        int body = start + NOTE_HEADING.length();
        List<Integer> ends = List.of(markdown.indexOf("\n### ", body), markdown.indexOf("\n## ", body));
        int end = ends.stream().filter(i -> i >= 0).min(Integer::compare).orElse(markdown.length());
        return markdown.substring(body, end);
    }

    private static int count(String text, String needle) {
        return text.split(Pattern.quote(needle), -1).length - 1;
    }
}
