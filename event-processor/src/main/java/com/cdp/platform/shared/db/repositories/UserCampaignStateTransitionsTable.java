package com.cdp.platform.shared.db.repositories;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.apache.flink.table.api.DataTypes;
import org.apache.flink.table.api.Schema;
import org.apache.flink.types.Row;

import com.cdp.platform.shared.models.db.UserCampaignState;
import com.cdp.platform.shared.models.db.WatchChild;
import com.cdp.platform.shared.models.node.Branch;
import com.cdp.platform.shared.models.node.NodeType;
import com.cdp.platform.shared.models.node.WatchLimit;
import com.cdp.platform.shared.utils.JacksonMapper;
import com.cdp.platform.shared.utils.ParseResult;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import org.jooq.Field;
import org.jooq.JSONB;
import org.jooq.Table;
import org.jooq.impl.DSL;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The table {@code user_campaign_state_transitions}: one row per completed
 * journey node in one entry. The state machine writes it, and the outbox job
 * reads it through CDC. {@code transitioned_at} is filled by the database when
 * the row is written, so no job names it.
 */
public final class UserCampaignStateTransitionsTable {

    public static final String TABLE_NAME = "user_campaign_state_transitions";
    public static final String PUBLICATION_NAME = "outbox_transitions_pub";

    public static final String CANON_ID = "canon_id";
    public static final String DOMAIN_USER_ID = "domain_userid";
    public static final String NETWORK_USER_ID = "network_userid";
    public static final String USER_ID = "user_id";
    public static final String CAMPAIGN_ID = "campaign_id";
    public static final String ENTRY_ID = "entry_id";
    public static final String NODE_ID = "node_id";
    public static final String BRANCH = "branch";
    public static final String EVENT_TIMESTAMP = "event_timestamp";
    public static final String NODE_TYPE = "node_type";
    public static final String ACTION_JSON = "action_json";
    public static final String CONTEXT_JSON = "context_json";
    public static final String CHILDREN = "children";
    public static final String EVENT_ID = "event_id";

    /** The keys of each watch child in {@link #CHILDREN}. */
    static final String CHILD_NODE_ID = "node_id";
    static final String CHILD_LIMIT_MILLIS = "limit_millis";
    static final String CHILD_DEADLINE_BRANCH = "deadline_branch";
    static final String CHILD_GRAPH_VERSION = "graph_version";

    static final Table<?> TABLE = DSL.table(DSL.name(TABLE_NAME));
    static final Field<String> CANON_ID_FIELD = DSL.field(DSL.name(CANON_ID), String.class);
    static final Field<String> DOMAIN_USER_ID_FIELD = DSL.field(DSL.name(DOMAIN_USER_ID), String.class);
    static final Field<String> NETWORK_USER_ID_FIELD = DSL.field(DSL.name(NETWORK_USER_ID), String.class);
    static final Field<String> USER_ID_FIELD = DSL.field(DSL.name(USER_ID), String.class);
    static final Field<String> CAMPAIGN_ID_FIELD = DSL.field(DSL.name(CAMPAIGN_ID), String.class);
    static final Field<String> ENTRY_ID_FIELD = DSL.field(DSL.name(ENTRY_ID), String.class);
    static final Field<String> NODE_ID_FIELD = DSL.field(DSL.name(NODE_ID), String.class);
    static final Field<String> BRANCH_FIELD = DSL.field(DSL.name(BRANCH), String.class);
    static final Field<Long> EVENT_TIMESTAMP_FIELD = DSL.field(DSL.name(EVENT_TIMESTAMP), Long.class);
    static final Field<String> NODE_TYPE_FIELD = DSL.field(DSL.name(NODE_TYPE), String.class);
    static final Field<String> ACTION_JSON_FIELD = DSL.field(DSL.name(ACTION_JSON), String.class);
    static final Field<String> CONTEXT_JSON_FIELD = DSL.field(DSL.name(CONTEXT_JSON), String.class);
    static final Field<JSONB> CHILDREN_FIELD = DSL.field(DSL.name(CHILDREN), JSONB.class);
    static final Field<UUID> EVENT_ID_FIELD = DSL.field(DSL.name(EVENT_ID), UUID.class);

    private static final Logger LOG = LoggerFactory.getLogger(UserCampaignStateTransitionsTable.class);

    private UserCampaignStateTransitionsTable() {
    }

    /** The columns the outbox job reads through CDC. */
    public static Schema cdcSchema() {
        return Schema
            .newBuilder()
            .column(CANON_ID, DataTypes.STRING().notNull())
            .column(DOMAIN_USER_ID, DataTypes.STRING())
            .column(NETWORK_USER_ID, DataTypes.STRING())
            .column(USER_ID, DataTypes.STRING())
            .column(CAMPAIGN_ID, DataTypes.STRING().notNull())
            .column(ENTRY_ID, DataTypes.STRING().notNull())
            .column(NODE_ID, DataTypes.STRING().notNull())
            .column(BRANCH, DataTypes.STRING().notNull())
            .column(EVENT_TIMESTAMP, DataTypes.BIGINT())
            .column(NODE_TYPE, DataTypes.STRING().notNull())
            .column(ACTION_JSON, DataTypes.STRING())
            .column(CONTEXT_JSON, DataTypes.STRING())
            .column(CHILDREN, DataTypes.STRING())
            .column(EVENT_ID, DataTypes.STRING())
            .columnByExpression("proctime", "PROCTIME()")
            .primaryKey(CANON_ID, CAMPAIGN_ID, ENTRY_ID, NODE_ID, BRANCH)
            .build();
    }

    /**
     * Parses a transition row from CDC. The timestamp column is NOT NULL in the
     * table, so a null timestamp is a parse failure, and so are a null entry id,
     * a node type the engine does not know, and watch children it did not write.
     * Such a row is logged and dropped.
     */
    public static Optional<UserCampaignState> transition(Row row) {
        Long eventTimestamp = row.getFieldAs(EVENT_TIMESTAMP);
        if (eventTimestamp == null) return invalid(row, "no " + EVENT_TIMESTAMP);
        String entryId = row.getFieldAs(ENTRY_ID);
        if (entryId == null) return invalid(row, "no " + ENTRY_ID);
        ParseResult<NodeType> nodeType = NodeType.fromValue(row.getFieldAs(NODE_TYPE));
        if (!nodeType.isValid()) return invalid(row, nodeType.failureMessage());
        ParseResult<List<WatchChild>> watchChildren = watchChildren(row.getFieldAs(CHILDREN));
        if (!watchChildren.isValid()) return invalid(row, watchChildren.failureMessage());
        return Optional
            .of(new UserCampaignState(row.getFieldAs(CANON_ID), row.getFieldAs(DOMAIN_USER_ID),
                row.getFieldAs(NETWORK_USER_ID), row.getFieldAs(USER_ID), row.getFieldAs(CAMPAIGN_ID), entryId,
                row.getFieldAs(NODE_ID), row.getFieldAs(BRANCH), eventTimestamp, nodeType.valueOrThrow(),
                row.getFieldAs(ACTION_JSON), row.getFieldAs(CONTEXT_JSON), watchChildren.valueOrThrow(),
                row.getFieldAs(EVENT_ID)));
    }

    /**
     * The {@link #CHILDREN} column of a transition: one object per watch child,
     * with its node id, its limit in milliseconds, the branch its deadline
     * completes it on, and the graph version that listed it.
     */
    public static String childrenJson(List<WatchChild> watchChildren) {
        ArrayNode children = JacksonMapper.instance().createArrayNode();
        for (WatchChild watch : watchChildren) {
            children
                .addObject()
                .put(CHILD_NODE_ID, watch.nodeId())
                .put(CHILD_LIMIT_MILLIS, watch.limit().millis())
                .put(CHILD_DEADLINE_BRANCH, watch.deadlineBranch().name())
                .put(CHILD_GRAPH_VERSION, watch.graphVersion());
        }
        return children.toString();
    }

    private static ParseResult<List<WatchChild>> watchChildren(String json) {
        if (json == null || json.isBlank()) return ParseResult.success(List.of());
        try {
            JsonNode children = JacksonMapper.readTree(json);
            if (!children.isArray()) throw new IllegalArgumentException("children is not a JSON array");
            List<WatchChild> watches = new ArrayList<>();
            for (JsonNode child : children) {
                watches
                    .add(new WatchChild(text(child, CHILD_NODE_ID),
                        new WatchLimit(integer(child, CHILD_LIMIT_MILLIS)),
                        Branch.valueOf(text(child, CHILD_DEADLINE_BRANCH)), integer(child, CHILD_GRAPH_VERSION)));
            }
            return ParseResult.success(watches);
        } catch (IllegalArgumentException invalid) {
            return ParseResult
                .failure(new IllegalArgumentException("Invalid watch children: " + invalid.getMessage(), invalid));
        }
    }

    private static String text(JsonNode child, String key) {
        JsonNode value = child.path(key);
        if (!value.isTextual()) throw new IllegalArgumentException(key + " is not text");
        return value.asText();
    }

    private static long integer(JsonNode child, String key) {
        JsonNode value = child.path(key);
        if (!value.isIntegralNumber() || !value.canConvertToLong()) {
            throw new IllegalArgumentException(key + " is not a whole number");
        }
        return value.longValue();
    }

    private static Optional<UserCampaignState> invalid(Row row, String reason) {
        LOG
            .warn("Ignoring transition {}:{}:{}:{}:{}: {}", row.getField(CANON_ID), row.getField(CAMPAIGN_ID),
                row.getField(ENTRY_ID), row.getField(NODE_ID), row.getField(BRANCH), reason);
        return Optional.empty();
    }
}
