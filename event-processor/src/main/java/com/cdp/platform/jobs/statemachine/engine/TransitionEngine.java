package com.cdp.platform.jobs.statemachine.engine;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import com.cdp.platform.jobs.statemachine.model.CampaignGraph;
import com.cdp.platform.jobs.statemachine.model.GraphNode;
import com.cdp.platform.shared.models.JourneyTriggerEvent;
import com.cdp.platform.shared.models.SegmentCheck;
import com.cdp.platform.shared.models.db.UserCampaignState;
import com.cdp.platform.shared.models.db.WatchChild;
import com.cdp.platform.shared.models.node.Branch;
import com.cdp.platform.shared.models.node.NodeType;
import com.cdp.platform.shared.models.node.WatchLimit;
import com.cdp.platform.shared.utils.JacksonMapper;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Pure BFS transition logic. Event ordering and durability are handled by Flink
 * around this engine.
 */
public final class TransitionEngine {

    private static final Logger LOG = LoggerFactory.getLogger(TransitionEngine.class);
    private final ObjectMapper mapper = JacksonMapper.instance();

    /**
     * Applies a trigger to one entry of its journey key, whose completed nodes
     * are given by node id. The nodes the trigger completes are added to them.
     */
    public Evaluation evaluate(JourneyTriggerEvent event, String entryId, CampaignGraph graph,
        Map<String, UserCampaignState> completedNodes) {
        GraphNode node = graph.node(event.nodeId());
        // The graph arrives one row at a time, so the node may not be here yet.
        if (node == null) return Evaluation.deferred();
        if (completedNodes.containsKey(event.nodeId())) return Evaluation.ignored();

        UserCampaignState parent = null;
        if (node.parentNodeId() != null) {
            parent = completedNodes.get(node.parentNodeId());
            if (parent == null) return Evaluation.deferred();
            boolean onParentBranch = CampaignGraph.hangsOff(node, parent.branch());
            if (parent.eventTimestamp() > event.eventTimestamp()) {
                return onParentBranch && node.nodeType() == NodeType.segment
                    ? Evaluation.recheck(segmentCheck(event, node, parent.eventTimestamp()))
                    : Evaluation.deferred();
            }
            if (!onParentBranch) return Evaluation.wrongBranch();
            if (afterWatchDeadline(event, node, parent)) return Evaluation.ignored();
        }

        String branch = blankToDefault(event.branch(), Branch.next.name());
        String mergedContext = mergeContext(parent == null ? null : parent.contextJson(), event);
        UserCampaignState first = transition(event, entryId, node, branch, event.eventTimestamp(), mergedContext,
            graph);

        List<UserCampaignState> emitted = new ArrayList<>();
        List<SegmentCheck> segmentChecks = new ArrayList<>();
        ArrayDeque<UserCampaignState> queue = new ArrayDeque<>();
        completedNodes.put(first.nodeId(), first);
        emitted.add(first);
        queue.add(first);

        while (!queue.isEmpty()) {
            UserCampaignState current = queue.removeFirst();
            for (GraphNode child : graph.children(current.nodeId(), current.branch())) {
                if (completedNodes.containsKey(child.nodeId())) continue;
                if (child.nodeType() == NodeType.segment) {
                    segmentChecks.add(segmentCheck(event, child, current.eventTimestamp()));
                    continue;
                }
                if (!isAutomatic(child)) continue;
                UserCampaignState automatic = transition(event, entryId, child, Branch.next.name(),
                    current.eventTimestamp(),
                    current.contextJson(), graph);
                completedNodes.put(automatic.nodeId(), automatic);
                emitted.add(automatic);
                queue.addLast(automatic);
            }
        }
        return Evaluation.applied(emitted, segmentChecks);
    }

    private static boolean isAutomatic(GraphNode node) {
        return node.nodeType() == NodeType.engagement || node.nodeType() == NodeType.end;
    }

    /**
     * Asks customer decision to evaluate a segment the person just reached, as of
     * its parent's completion, with the trigger that completed the parent.
     */
    private static SegmentCheck segmentCheck(JourneyTriggerEvent event, GraphNode segment,
        long parentCompletedAt) {
        return new SegmentCheck(SegmentCheck.SCHEMA_VERSION, event.eventId(), event.canonId(), event.domainUserId(),
            event.networkUserId(), event.userId(), event.campaignId(), segment.nodeId(), event.eventName(),
            parentCompletedAt);
    }

    /**
     * A watch completes on {@code success} only up to its deadline, its parent's
     * completion plus the watch limit. After that, its timeout completes it. The
     * limit is the one the parent's transition listed, which the timer flow
     * fires at, so a later change to the node's row does not move the deadline.
     * A watch whose row arrived after its parent completed is not listed and has
     * no timer, so its own row gives the limit.
     */
    private static boolean afterWatchDeadline(JourneyTriggerEvent event, GraphNode node,
        UserCampaignState parent) {
        if (node.watch() == null || !Branch.success.name().equals(event.branch())) return false;
        WatchLimit limit = parent
            .watchChildren()
            .stream()
            .filter(child -> child.nodeId().equals(node.nodeId()))
            .findFirst()
            .map(WatchChild::limit)
            .orElse(node.watch().limit());
        return event.eventTimestamp() > limit.deadlineAfter(parent.eventTimestamp());
    }

    private static UserCampaignState transition(JourneyTriggerEvent event, String entryId, GraphNode node,
        String branch, long timestamp, String contextJson, CampaignGraph graph) {
        return new UserCampaignState(event.canonId(), event.domainUserId(), event.networkUserId(), event.userId(),
            event.campaignId(), entryId, node.nodeId(), branch, timestamp, node.nodeType(),
            node.nodeType() == NodeType.engagement ? node.actionJson() : null, contextJson,
            watchChildren(graph, node.nodeId(), branch), event.eventId());
    }

    /**
     * Merges the trigger's context over the parent's. When either is not a
     * JSON object, the trigger's context is kept as it is and the parent's keys
     * are lost, which is logged.
     */
    private String mergeContext(String parentContext, JourneyTriggerEvent event) {
        String eventContext = event.contextJson();
        if (blankJson(parentContext)) {
            return eventContext;
        }
        if (blankJson(eventContext)) {
            return parentContext;
        }
        try {
            JsonNode parent = mapper.readTree(parentContext);
            JsonNode trigger = mapper.readTree(eventContext);
            if (parent.isObject() && trigger.isObject()) {
                ObjectNode merged = ((ObjectNode) parent).deepCopy();
                trigger.fields().forEachRemaining(field -> merged.set(field.getKey(), field.getValue()));
                return mapper.writeValueAsString(merged);
            }
        } catch (JsonProcessingException invalid) {
            // Logged below with the ids.
        }
        LOG
            .warn("Keeping only the trigger's context for {}:{}:{}: a context is not a JSON object",
                event.canonId(), event.campaignId(), event.nodeId());
        return eventContext;
    }

    /** The watches that hang off a branch of a node, for the timer flow. */
    private static List<WatchChild> watchChildren(CampaignGraph graph, String nodeId, String branch) {
        List<WatchChild> watches = new ArrayList<>();
        for (GraphNode child : graph.children(nodeId, branch)) {
            if (child.watch() != null) {
                watches
                    .add(new WatchChild(child.nodeId(), child.watch().limit(), child.watch().deadlineBranch(),
                        graph.getGraphVersion()));
            }
        }
        return watches;
    }

    private static boolean blankJson(String value) {
        return value == null || value.isBlank();
    }

    private static String blankToDefault(String value, String fallback) {
        return value == null || value.isBlank() ? fallback : value;
    }

    /**
     * The outcome of one trigger: the nodes it completed, and a check for each
     * segment that a completed node led the person to.
     */
    public record Evaluation(Status status, List<UserCampaignState> transitions, List<SegmentCheck> segmentChecks) {
        public static Evaluation applied(List<UserCampaignState> transitions, List<SegmentCheck> segmentChecks) {
            return new Evaluation(Status.APPLIED, List.copyOf(transitions), List.copyOf(segmentChecks));
        }

        public static Evaluation deferred() {
            return new Evaluation(Status.DEFERRED, List.of(), List.of());
        }

        public static Evaluation ignored() {
            return new Evaluation(Status.IGNORED, List.of(), List.of());
        }

        /** The parent completed on another branch than the node hangs off. */
        public static Evaluation wrongBranch() {
            return new Evaluation(Status.WRONG_BRANCH, List.of(), List.of());
        }

        /**
         * A segment trigger from before its parent completed. The metric change it
         * reports came in after the segment was checked on arrival, so the segment
         * is checked again at the parent's completion, and the trigger itself
         * completes nothing.
         */
        public static Evaluation recheck(SegmentCheck check) {
            return new Evaluation(Status.IGNORED, List.of(), List.of(check));
        }
    }

    public enum Status {
        APPLIED, DEFERRED, IGNORED, WRONG_BRANCH
    }
}
