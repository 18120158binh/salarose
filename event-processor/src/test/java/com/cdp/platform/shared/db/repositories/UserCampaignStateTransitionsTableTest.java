package com.cdp.platform.shared.db.repositories;

import java.io.IOException;
import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.PreparedStatement;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

import org.apache.flink.table.api.Schema;
import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;

import com.cdp.platform.shared.models.db.UserCampaignState;
import com.cdp.platform.shared.models.db.WatchChild;
import com.cdp.platform.shared.models.node.Branch;
import com.cdp.platform.shared.models.node.NodeType;
import com.cdp.platform.shared.models.node.WatchLimit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * The sink, the CDC source, and the row parser of
 * {@code user_campaign_state_transitions} must name the columns that
 * {@code schema.sql} defines, so a renamed column fails here, not at runtime.
 */
class UserCampaignStateTransitionsTableTest {

    private static final Path SCHEMA_SQL = Path.of("..", "infra", "db", "schema.sql");
    private static final Pattern CREATE_TABLE = Pattern
        .compile("CREATE TABLE IF NOT EXISTS " + UserCampaignStateTransitionsTable.TABLE_NAME
            + " \\((.*?)\\n\\);", Pattern.DOTALL);
    private static final Pattern ALIAS = Pattern.compile(" as \"[^\"]+\"");
    private static final Pattern QUOTED_IDENTIFIER = Pattern.compile("\"([^\"]+)\"");
    private static final Pattern INSERT_COLUMNS = Pattern.compile("^insert into \"[^\"]+\" \\(([^)]*)\\)");
    private static final Pattern NOT_EXISTS = Pattern.compile("where not exists \\((.*)\\)");
    private static final Pattern PARAMETER_COLUMN = Pattern.compile("\"([^\"]+)\" = \\?");
    private static final Pattern PRIMARY_KEY = Pattern.compile("(?i)primary key \\(([^)]*)\\)");
    /** Filled by the database when the row is written. */
    private static final String WRITE_TIME = "transitioned_at";

    @Test
    void theSinkWritesEveryColumnButTheWriteTime() throws IOException {
        String sql = ALIAS.matcher(UserCampaignStateTransitionRepository.insertQuery().getSQL()).replaceAll("");
        Set<String> written = QUOTED_IDENTIFIER
            .matcher(sql)
            .results()
            .map(identifier -> identifier.group(1))
            .collect(Collectors.toCollection(LinkedHashSet::new));
        written.remove(UserCampaignStateTransitionsTable.TABLE_NAME);

        assertEquals(columnsButTheWriteTime(), written);
    }

    @Test
    void theCdcSourceReadsEveryColumnButTheWriteTime() throws IOException {
        Set<String> read = UserCampaignStateTransitionsTable
            .cdcSchema()
            .getColumns()
            .stream()
            .filter(Schema.UnresolvedPhysicalColumn.class::isInstance)
            .map(Schema.UnresolvedColumn::getName)
            .collect(Collectors.toSet());

        assertEquals(columnsButTheWriteTime(), read);
    }

    @Test
    void aCdcRowParsesIntoTheTransitionItHolds() {
        UserCampaignState expected = new UserCampaignState("canon-1", "domain-1", "network-1", "user-1",
            "campaign-1", "be-1", "node-1", "next", 1_760_346_764_120L, NodeType.engagement, "{\"channel\":\"sms\"}",
            "{}",
            List.of(), "5f0c1a2e-0000-0000-0000-000000000000");

        assertEquals(Optional.of(expected), UserCampaignStateTransitionsTable.transition(row(1_760_346_764_120L)));
    }

    @Test
    void aCdcRowWithoutATimestampIsDropped() {
        assertEquals(Optional.empty(), UserCampaignStateTransitionsTable.transition(row(null)));
    }

    @Test
    void aCdcRowWithoutAnEntryIdIsDropped() {
        Row row = row(1_760_346_764_120L);
        row.setField("entry_id", null);

        assertEquals(Optional.empty(), UserCampaignStateTransitionsTable.transition(row));
    }

    /**
     * The sink binds each value of a transition to its own column, and skips the
     * row only when the same entry already completed the node, on any branch: the
     * table's primary key without the branch (JEX-FR-01, JEX-FR-10).
     */
    @Test
    void theSinkWritesEachValueToItsColumnAndSkipsANodeItsEntryCompleted() throws Exception {
        String sql = UserCampaignStateTransitionRepository.insertQuery().getSQL();
        Matcher insertColumns = INSERT_COLUMNS.matcher(sql);
        assertTrue(insertColumns.find(), sql);
        List<String> parameters = new ArrayList<>(QUOTED_IDENTIFIER
            .matcher(insertColumns.group(1))
            .results()
            .map(identifier -> identifier.group(1))
            .toList());
        int written = parameters.size();
        Matcher notExists = NOT_EXISTS.matcher(sql);
        assertTrue(notExists.find(), sql);
        PARAMETER_COLUMN.matcher(notExists.group(1)).results().forEach(column -> parameters.add(column.group(1)));
        Map<Integer, Object> bound = new HashMap<>();
        PreparedStatement statement = (PreparedStatement) Proxy
            .newProxyInstance(PreparedStatement.class.getClassLoader(), new Class<?>[] {PreparedStatement.class},
                (proxy, method, args) -> bound.put((Integer) args[0], args[1]));

        Row cdc = row(1_760_346_764_120L);

        UserCampaignStateTransitionRepository
            .bind(statement, UserCampaignStateTransitionsTable.transition(cdc).orElseThrow());

        for (int index = 0; index < parameters.size(); index++) {
            String column = parameters.get(index);
            assertEquals(cdc.getField(column), bound.get(index + 1), column);
        }
        assertEquals(parameters.size(), bound.size());
        Set<String> skippedOn = new LinkedHashSet<>(parameters.subList(written, parameters.size()));
        Set<String> keyWithoutBranch = primaryKey();
        keyWithoutBranch.remove("branch");
        assertEquals(keyWithoutBranch, skippedOn);
    }

    /**
     * The state machine writes each watch child with its parsed limit, so the
     * timer flow reads back the same limit and deadline branch without parsing
     * the watch's condition.
     */
    @Test
    void theWatchChildrenTheSinkWritesReadBackFromCdc() {
        List<WatchChild> watches = List
            .of(new WatchChild("n3_cart", new WatchLimit(15 * 60_000L), Branch.timeout, 7L),
                new WatchChild("n9_delay", new WatchLimit(3 * 86_400_000L), Branch.next, 7L));
        Row row = row(1_760_346_764_120L);
        row.setField("children", UserCampaignStateTransitionsTable.childrenJson(watches));

        assertEquals(watches, UserCampaignStateTransitionsTable.transition(row).orElseThrow().watchChildren());
    }

    /** Postgres returns {@code jsonb} with its own spacing and key order. */
    @Test
    void watchChildrenParseInTheFormPostgresReturns() {
        Row row = row(1_760_346_764_120L);
        row.setField("children", """
            [{"node_id": "n3_cart", "graph_version": 7, "limit_millis": 900000, "deadline_branch": "timeout"}]""");

        assertEquals(List.of(new WatchChild("n3_cart", new WatchLimit(900_000L), Branch.timeout, 7L)),
            UserCampaignStateTransitionsTable.transition(row).orElseThrow().watchChildren());
    }

    @Test
    void aCdcRowWhoseWatchChildrenDoNotParseIsDropped() {
        List<String> invalid = List
            .of("{not json", "{}",
                "[{\"node_id\":\"n3_cart\",\"limit_millis\":0,\"deadline_branch\":\"timeout\",\"graph_version\":7}]",
                "[{\"node_id\":\"n3_cart\",\"limit_millis\":900000,\"deadline_branch\":\"later\",\"graph_version\":7}]",
                "[{\"node_id\":\"n3_cart\",\"limit_millis\":900000,\"deadline_branch\":\"timeout\"}]",
                "[{\"node_id\":\"n3_cart\",\"node_type\":\"watch\",\"condition_json\":{\"timeLimitValue\":15}}]");
        for (String children : invalid) {
            Row row = row(1_760_346_764_120L);
            row.setField("children", children);

            assertEquals(Optional.empty(), UserCampaignStateTransitionsTable.transition(row), children);
        }
    }

    @Test
    void aCdcRowWithANodeTypeTheEngineDoesNotKnowIsDropped() {
        Row row = row(1_760_346_764_120L);
        row.setField("node_type", "webhook");

        assertEquals(Optional.empty(), UserCampaignStateTransitionsTable.transition(row));
    }

    private static Row row(Long eventTimestamp) {
        Row row = Row.withNames(RowKind.INSERT);
        row.setField("canon_id", "canon-1");
        row.setField("domain_userid", "domain-1");
        row.setField("network_userid", "network-1");
        row.setField("user_id", "user-1");
        row.setField("campaign_id", "campaign-1");
        row.setField("entry_id", "be-1");
        row.setField("node_id", "node-1");
        row.setField("branch", "next");
        row.setField("event_timestamp", eventTimestamp);
        row.setField("node_type", "engagement");
        row.setField("action_json", "{\"channel\":\"sms\"}");
        row.setField("context_json", "{}");
        row.setField("children", "[]");
        row.setField("event_id", "5f0c1a2e-0000-0000-0000-000000000000");
        return row;
    }

    private static Set<String> primaryKey() throws IOException {
        Matcher table = CREATE_TABLE.matcher(Files.readString(SCHEMA_SQL));
        assertTrue(table.find(), "schema.sql has no CREATE TABLE for the transitions table");
        Matcher key = PRIMARY_KEY.matcher(table.group(1));
        assertTrue(key.find(), "the transitions table has no primary key");
        return Arrays
            .stream(key.group(1).split(","))
            .map(String::trim)
            .collect(Collectors.toCollection(LinkedHashSet::new));
    }

    private static Set<String> columnsButTheWriteTime() throws IOException {
        Matcher table = CREATE_TABLE.matcher(Files.readString(SCHEMA_SQL));
        assertTrue(table.find(), "schema.sql has no CREATE TABLE for the transitions table");
        String columnDefinitions = table.group(1).split("(?i)primary key")[0];
        Set<String> columns = Arrays
            .stream(columnDefinitions.split("\\n"))
            .map(String::trim)
            .filter(line -> !line.isEmpty() && !line.startsWith("--"))
            .map(line -> line.split("\\s+")[0])
            .collect(Collectors.toSet());
        assertTrue(columns.remove(WRITE_TIME), "schema.sql has no " + WRITE_TIME);
        return columns;
    }
}
