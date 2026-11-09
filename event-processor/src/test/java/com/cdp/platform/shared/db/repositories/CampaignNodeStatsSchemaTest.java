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

// There is no Postgres in the tests, so these read infra/db/schema.sql. The builder reads
// campaign_node_stats by campaign_id and gets node_id and user_count.
class CampaignNodeStatsSchemaTest {

    private static final Path SCHEMA_SQL = Path.of("..", "infra", "db", "schema.sql");
    private static final Pattern STATS_VIEW = Pattern
        .compile("CREATE OR REPLACE VIEW campaign_node_stats \\(([^)]*)\\) AS(.*?);", Pattern.DOTALL);
    private static final Pattern TRIGGER_ON_TRANSITIONS = Pattern
        .compile("CREATE\\s+TRIGGER[^;]*?\\bON\\s+" + UserCampaignStateTransitionsTable.TABLE_NAME + "\\b",
            Pattern.CASE_INSENSITIVE);

    @Test
    void nodeStatsAreComputedFromTransitionsOnEveryBranch() throws IOException {
        Matcher view = STATS_VIEW.matcher(Files.readString(SCHEMA_SQL));
        assertTrue(view.find(), "schema.sql has no view campaign_node_stats");

        List<String> columns = Arrays.stream(view.group(1).split(",")).map(String::trim).toList();
        String query = view.group(2).replaceAll("\\s+", " ");

        assertEquals(List.of("campaign_id", "node_id", "user_count"), columns);
        assertTrue(query.contains("FROM " + UserCampaignStateTransitionsTable.TABLE_NAME), query);
        assertFalse(query.contains("branch"), () -> "the view filters on branch: " + query);
    }

    /** A person with two entries that completed a node counts twice (JEX-FR-11). */
    @Test
    void nodeStatsCountEachEntryOfAPerson() throws IOException {
        Matcher view = STATS_VIEW.matcher(Files.readString(SCHEMA_SQL));
        assertTrue(view.find(), "schema.sql has no view campaign_node_stats");

        String query = view.group(2).replaceAll("\\s+", "").toLowerCase(Locale.ROOT);

        assertTrue(query.contains("count(distinct(canon_id,entry_id))"), query);
    }

    @Test
    void writingATransitionFiresNoTrigger() throws IOException {
        Matcher trigger = TRIGGER_ON_TRANSITIONS.matcher(Files.readString(SCHEMA_SQL));

        assertFalse(trigger.find(), () -> "schema.sql defines a trigger on transitions: " + trigger.group());
    }
}
