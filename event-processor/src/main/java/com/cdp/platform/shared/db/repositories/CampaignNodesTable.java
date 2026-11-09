package com.cdp.platform.shared.db.repositories;

import org.apache.flink.table.api.DataTypes;
import org.apache.flink.table.api.Schema;

/**
 * The table {@code campaign_nodes}: one row per journey node. Studio writes
 * it, and customer decision and the state machine read it through CDC.
 */
public final class CampaignNodesTable {

    public static final String TABLE_NAME = "campaign_nodes";
    public static final String PUBLICATION_NAME = "campaign_nodes_pub";

    public static final String CAMPAIGN_ID = "campaign_id";
    public static final String NODE_ID = "node_id";
    public static final String NODE_TYPE = "node_type";
    public static final String PARENT_NODE_ID = "parent_node_id";
    public static final String PARENT_BRANCH = "parent_branch";
    public static final String TRIGGER_JSON = "trigger_json";
    public static final String CONDITIONS_JSON = "conditions_json";
    public static final String PATHS_JSON = "paths_json";
    public static final String ACTION_JSON = "action_json";
    public static final String GOAL_ID = "goal_id";
    /** The number of nodes in the save that wrote the row. */
    public static final String CAMPAIGN_NODE_COUNT = "campaign_node_count";
    /**
     * The version of the campaign graph that the save wrote. A later publish
     * writes a higher one, and a resume keeps it.
     */
    public static final String GRAPH_VERSION = "graph_version";

    private CampaignNodesTable() {
    }

    /** The columns customer decision reads through CDC. */
    public static Schema cdcSchema() {
        return nodeColumns().build();
    }

    /**
     * The columns the state machine reads through CDC: the node columns and the
     * size of the save, so that it can apply a save as one change.
     */
    public static Schema graphCdcSchema() {
        return nodeColumns().column(CAMPAIGN_NODE_COUNT, DataTypes.INT().notNull()).build();
    }

    private static Schema.Builder nodeColumns() {
        return Schema
            .newBuilder()
            .column(CAMPAIGN_ID, DataTypes.STRING().notNull())
            .column(NODE_ID, DataTypes.STRING().notNull())
            .column(NODE_TYPE, DataTypes.STRING().notNull())
            .column(PARENT_NODE_ID, DataTypes.STRING())
            .column(PARENT_BRANCH, DataTypes.STRING())
            .column(TRIGGER_JSON, DataTypes.STRING())
            .column(CONDITIONS_JSON, DataTypes.STRING())
            .column(PATHS_JSON, DataTypes.STRING())
            .column(ACTION_JSON, DataTypes.STRING())
            .column(GOAL_ID, DataTypes.STRING())
            .column(GRAPH_VERSION, DataTypes.BIGINT().notNull())
            .primaryKey(CAMPAIGN_ID, NODE_ID);
    }
}
