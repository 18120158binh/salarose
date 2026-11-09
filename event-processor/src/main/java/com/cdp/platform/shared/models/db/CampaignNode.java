package com.cdp.platform.shared.models.db;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;

import org.apache.flink.types.Row;

import com.cdp.platform.shared.db.repositories.CampaignNodesTable;
import com.cdp.platform.shared.models.node.BranchCondition;
import com.cdp.platform.shared.models.node.NodeType;
import com.cdp.platform.shared.models.node.PersonConditions;
import com.cdp.platform.shared.models.node.Predicate;
import com.cdp.platform.shared.models.node.RuleDocuments;
import com.cdp.platform.shared.utils.ParseResult;

import com.fasterxml.jackson.annotation.JsonProperty;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Validated representation of one {@code campaign_nodes} row.
 *
 * <p>
 * {@code condition} is the trigger as a predicate on the event, null when the
 * node has none. {@code conditions} are the conditions on the person, and
 * {@code branches} a multi-branch check's branches, in their saved order.
 * {@code graphVersion} is the version of the graph that the row's save wrote.
 */
public record CampaignNode(
    @JsonProperty("campaignId") String campaignId,
    @JsonProperty("nodeId") String nodeId,
    @JsonProperty("nodeType") NodeType nodeType,
    @JsonProperty("parentNodeId") String parentNodeId,
    @JsonProperty("parentBranch") String parentBranch,
    @JsonProperty("condition") Predicate condition,
    @JsonProperty("conditions") PersonConditions conditions,
    @JsonProperty("actionJson") String actionJson,
    @JsonProperty("goalId") String goalId,
    @JsonProperty("branches") List<BranchCondition> branches,
    @JsonProperty("pathType") String pathType,
    @JsonProperty("graphVersion") long graphVersion) {

    private static final Logger LOG = LoggerFactory.getLogger(CampaignNode.class);

    private static final String DELAY_PATH = "DelayPath";

    public CampaignNode {
        if (campaignId == null || campaignId.isBlank()) {
            throw new IllegalArgumentException("Campaign node campaign_id is required");
        }
        if (nodeId == null || nodeId.isBlank()) {
            throw new IllegalArgumentException("Campaign node node_id is required");
        }
        if (nodeType == null) throw new IllegalArgumentException("Campaign node node_type is required");
        if (conditions == null) conditions = PersonConditions.NONE;
        if (nodeType == NodeType.segment && (condition != null || conditions.metricIds().isEmpty())) {
            throw new IllegalArgumentException("Segment node needs a behavior condition and no trigger");
        }
        if (branches != null) {
            if (branches.stream().anyMatch(branch -> branch == null)) {
                throw new IllegalArgumentException("Campaign node branches cannot contain null entries");
            }
            branches = List.copyOf(branches);
        }
    }

    public static ParseResult<CampaignNode> fromRow(Row row) {
        String campaignId = (String) row.getField(CampaignNodesTable.CAMPAIGN_ID);
        String nodeId = (String) row.getField(CampaignNodesTable.NODE_ID);

        ParseResult<NodeType> nodeType = NodeType.fromValue((String) row.getField(CampaignNodesTable.NODE_TYPE));
        if (!nodeType.isValid()) return invalid(nodeType);

        ParseResult<Predicate> trigger = RuleDocuments.trigger((String) row.getField(CampaignNodesTable.TRIGGER_JSON));
        if (!trigger.isValid()) return invalid(trigger);

        ParseResult<PersonConditions> conditions = RuleDocuments
            .conditions((String) row.getField(CampaignNodesTable.CONDITIONS_JSON));
        if (!conditions.isValid()) return invalid(conditions);

        ParseResult<RuleDocuments.Paths> paths = RuleDocuments
            .paths((String) row.getField(CampaignNodesTable.PATHS_JSON));
        if (!paths.isValid()) return invalid(paths);

        if (!(row.getField(CampaignNodesTable.GRAPH_VERSION) instanceof Long graphVersion)) {
            return ParseResult.failure(new IllegalArgumentException("Campaign node graph_version is required"));
        }

        try {
            String pathType = paths.valueOrThrow().pathType();
            // A delay waits for no event, so a trigger saved on it never applies.
            Predicate condition = DELAY_PATH.equals(pathType) ? null : trigger.valueOrThrow();
            return ParseResult
                .success(new CampaignNode(
                    campaignId,
                    nodeId,
                    nodeType.valueOrThrow(),
                    (String) row.getField(CampaignNodesTable.PARENT_NODE_ID),
                    (String) row.getField(CampaignNodesTable.PARENT_BRANCH),
                    condition,
                    conditions.valueOrThrow(),
                    (String) row.getField(CampaignNodesTable.ACTION_JSON),
                    (String) row.getField(CampaignNodesTable.GOAL_ID),
                    paths.valueOrThrow().branches(),
                    pathType,
                    graphVersion));
        } catch (IllegalArgumentException exception) {
            return ParseResult.failure(new IllegalArgumentException("Invalid campaign node", exception));
        }
    }

    public static Optional<CampaignNode> load(Row row) {
        ParseResult<CampaignNode> parsedNode = fromRow(row);
        if (!parsedNode.isValid()) {
            LOG
                .warn("Ignoring invalid campaign node {}:{}: {}", row.getField(CampaignNodesTable.CAMPAIGN_ID),
                    row.getField(CampaignNodesTable.NODE_ID), parsedNode.failureMessage());
            return Optional.empty();
        }

        CampaignNode node = parsedNode.valueOrThrow();
        if (node.isDecisionNode()) return Optional.of(node);
        if (node.nodeType().needsTrigger() && !node.isDelay()) {
            LOG.warn("Ignoring campaign node {}:{}, which has no trigger", node.campaignId(), node.nodeId());
        }
        return Optional.empty();
    }

    public static String stateKey(Row row) {
        return stateKey((String) row.getField(CampaignNodesTable.CAMPAIGN_ID),
            (String) row.getField(CampaignNodesTable.NODE_ID));
    }

    public static String stateKey(String campaignId, String nodeId) {
        return "%s:%s".formatted(campaignId, nodeId);
    }

    public String stateKey() {
        return stateKey(campaignId, nodeId);
    }

    /**
     * Whether customer decision evaluates the node: a node that needs a trigger and
     * has one.
     */
    public boolean isDecisionNode() {
        return nodeType.needsTrigger() ? condition != null : nodeType == NodeType.segment;
    }

    public boolean isDelay() {
        return DELAY_PATH.equals(pathType);
    }

    /**
     * The conditions that must pass for the node to fire on {@code branch}: its
     * own, and those of the branch when it is one of a multi-branch check's.
     */
    public PersonConditions conditionsOn(String branch) {
        if (branches == null) return conditions;
        return branches
            .stream()
            .filter(candidate -> candidate.branchKey().equals(branch))
            .findFirst()
            .map(candidate -> conditions.and(candidate.conditions()))
            .orElse(conditions);
    }

    /** The ids of the metrics that the node's conditions and its branches' read. */
    public Set<String> metricIds() {
        Set<String> metricIds = new LinkedHashSet<>(conditions.metricIds());
        if (branches != null) branches.forEach(branch -> metricIds.addAll(branch.conditions().metricIds()));
        return metricIds;
    }

    /**
     * The ids of the segments that the node's conditions and its branches' name.
     */
    public Set<String> segmentIds() {
        Set<String> segmentIds = new LinkedHashSet<>(conditions.segmentIds());
        if (branches != null) branches.forEach(branch -> segmentIds.addAll(branch.conditions().segmentIds()));
        return segmentIds;
    }

    private static <T> ParseResult<T> invalid(ParseResult<?> result) {
        return ParseResult.failure(new IllegalArgumentException(result.failureMessage()));
    }
}
