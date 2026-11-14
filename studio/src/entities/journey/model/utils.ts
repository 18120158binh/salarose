import {
  CampaignTreeNode,
  CampaignNode,
  CampaignConnection,
  CampaignTreeRef,
  CheckNext,
  EventFilters,
  LimitUnit,
  MultiBranchPath,
  PathsRow,
  PersonConditions,
  NO_EDGE,
  NodeSubType,
  PushEngagement,
  Trigger,
  WatchNext,
  YES_EDGE,
} from "./types";
import { DbCampaignNode } from "@/lib/db";
import { savedGroups } from "./eventCondition";

/** A named branch of a multi-branch check, as the check's canvas config holds it. */
export interface BranchConfig {
  branchKey: string;
  priority: number;
  label?: string;
  filters?: EventFilters;
  conditions?: PersonConditions;
}

/**
 * Converts a recursive CampaignTreeNode tree ADT into a flat list of nodes and connections
 * for React Flow visualization, laid out by alignNodes.
 */
export function treeToGraph(root: CampaignTreeNode): {
  nodes: CampaignNode[];
  connections: CampaignConnection[];
} {
  const nodes: CampaignNode[] = [];
  const connections: CampaignConnection[] = [];

  if (!root) {
    return { nodes, connections };
  }

  // edgeType is the canvas edge kind, branch the parent_branch that flattenCampaignTree saves.
  function addChildren(parentId: string, target: CampaignTreeRef | undefined, edgeType: string, branch: string) {
    if (!target) return;
    const children = Array.isArray(target) ? target : [target];
    children.forEach((child, i) => {
      if (!child) return;
      const index = Array.isArray(target) ? i : undefined;
      const childId = visit(child, parentId, branch, index);
      connections.push({ from: parentId, to: childId, type: edgeType });
    });
  }

  // Returns the canvas id of the node.
  function visit(node: CampaignTreeNode, parentId: string | null, branch: string | null, index?: number): string {
    const position = { x: 0, y: 0 };

    switch (node.type) {
      case "end": {
        // The node_id that flattenCampaignTree saves for this End node, so that its count shows.
        const id = [
          ...(parentId === null ? [] : [parentId, branch]),
          ...(index === undefined ? [] : [index]),
          "end",
        ].join("-");
        nodes.push({
          id,
          type: "end",
          subType: "custom-list",
          label: "End",
          config: { description: "Journey ends", ...(node.goalId ? { goalId: node.goalId } : {}) },
          position,
        });
        return id;
      }

      case "setup":
        nodes.push({
          id: node.id,
          type: "setup",
          subType: "setup",
          label: node.label,
          config: {
            description: node.description,
            triggerType: node.triggerType || "user",
            triggerEventName: node.triggerEventName,
            eventId: node.eventId,
            filters: node.filters,
            conditions: node.conditions,
          },
          position,
        });
        addChildren(node.id, node.next, YES_EDGE, "next");
        return node.id;

      case "check": {
        nodes.push({
          id: node.id,
          type: "check",
          subType: "check",
          label: node.label,
          config: {
            description: node.description || `Check if: ${node.eventName || "event"}`,
            filters: node.filters,
            conditions: node.conditions,
            checkType: node.next.type,
            eventType: node.eventType,
            eventName: node.eventName,
            eventId: node.eventId,
            branches: node.next.type === "MultiBranchPath"
              ? node.next.branches.map((b) => ({ branchKey: b.branchKey, priority: b.priority, label: b.label, filters: b.filters, conditions: b.conditions }))
              : undefined,
          },
          position,
        });
        if (node.next.type === "MultiBranchPath") {
          node.next.branches.forEach((branch) => addChildren(node.id, branch.next, branch.branchKey, branch.branchKey));
        } else {
          if ("yes" in node.next) addChildren(node.id, node.next.yes, YES_EDGE, "yes");
          if ("no" in node.next) addChildren(node.id, node.next.no, NO_EDGE, "no");
        }
        return node.id;
      }

      case "segment":
        nodes.push({
          id: node.id,
          type: "segment",
          subType: "segment",
          label: node.label,
          config: {
            description: node.description,
            conditions: node.conditions,
            checkType: node.next.type,
          },
          position,
        });
        if ("yes" in node.next) addChildren(node.id, node.next.yes, YES_EDGE, "yes");
        if ("no" in node.next) addChildren(node.id, node.next.no, NO_EDGE, "no");
        return node.id;

      case "watch": {
        const isDelay = node.next.type === "DelayPath";
        nodes.push({
          id: node.id,
          type: "watch",
          subType: "watch",
          label: node.label,
          config: {
            description: node.description || (isDelay ? `Delay ${node.timeLimitValue} ${node.timeLimitUnit}` : `Watch for event: ${node.eventName || "event"}`),
            eventName: node.eventName,
            eventId: node.eventId,
            filters: node.filters,
            conditions: node.conditions,
            timeLimitValue: node.timeLimitValue,
            timeLimitUnit: node.timeLimitUnit,
            watchType: node.next.type,
          },
          position,
        });
        if (node.next.type === "DelayPath") {
          addChildren(node.id, node.next.next, YES_EDGE, "next");
        } else {
          if ("success" in node.next) addChildren(node.id, node.next.success, YES_EDGE, "success");
          if ("timeout" in node.next) addChildren(node.id, node.next.timeout, NO_EDGE, "timeout");
        }
        return node.id;
      }

      case "engagement": {
        const action: Partial<PushEngagement> = node.action || {};
        nodes.push({
          id: node.id,
          type: "engagement",
          subType: (action.type || "push") as NodeSubType,
          label: node.label,
          config: {
            title: action.title || "",
            body: action.body || "",
            subject: action.subject || "",
            url: action.url || "",
            payload: action.payload || null,
            templateId: action.templateId || "",
            method: action.method || "POST",
          },
          position,
        });
        addChildren(node.id, node.next, YES_EDGE, "next");
        return node.id;
      }
    }
  }

  visit(root, null, null);
  return { nodes: alignNodes(nodes, connections), connections };
}

/**
 * Thrown by graphToTree when the canvas is not a tree.
 */
export class InvalidJourneyGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidJourneyGraphError";
  }
}

/**
 * Reconstructs a recursive CampaignTreeNode tree ADT from flat nodes and connections.
 * Traces outgoing connections starting from the root 'setup' node.
 */
export function graphToTree(
  nodes: CampaignNode[],
  connections: CampaignConnection[]
): CampaignTreeNode {
  const rootNode = nodes.find((n) => n.subType === "setup");
  if (!rootNode) return { type: "end" };

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const outgoingMap = new Map<string, CampaignConnection[]>();
  
  connections.forEach((conn) => {
    const list = outgoingMap.get(conn.from) || [];
    list.push(conn);
    outgoingMap.set(conn.from, list);
  });

  // A step with no child ends the journey with the goal a drawn End gets, so the first save
  // matches every later save (JBD-FR-02).
  function getNextNodes(conns: CampaignConnection[]): CampaignTreeRef {
    if (!conns || conns.length === 0) return { type: "end", goalId: "goal_default" };
    if (conns.length === 1) return buildNode(conns[0].to);
    return conns.map(c => buildNode(c.to));
  }

  // The children on the yes or success edges, and on the no or timeout edges.
  const binaryChildren = (outgoing: CampaignConnection[]) => ({
    first: () => getNextNodes(outgoing.filter((c) => c.type === YES_EDGE)),
    second: () => getNextNodes(outgoing.filter((c) => c.type === NO_EDGE)),
  });

  function checkPaths(checkType: string, outgoing: CampaignConnection[]): CheckNext {
    const { first, second } = binaryChildren(outgoing);
    if (checkType === "YesPath") return { type: "YesPath", yes: first() };
    if (checkType === "NoPath") return { type: "NoPath", no: second() };
    return { type: "YesOrNoPath", yes: first(), no: second() };
  }

  function watchPaths(watchType: string, outgoing: CampaignConnection[]): WatchNext {
    const { first, second } = binaryChildren(outgoing);
    if (watchType === "SuccessPath") return { type: "SuccessPath", success: first() };
    if (watchType === "TimeoutPath") return { type: "TimeoutPath", timeout: second() };
    return { type: "SuccessOrTimeoutPath", success: first(), timeout: second() };
  }

  // A node reached twice would be saved as two rows with one node_id.
  const built = new Set<string>();
  const onPath = new Set<string>();

  function buildNode(nodeId: string): CampaignTreeNode {
    const node = nodeMap.get(nodeId);
    if (!node) return { type: "end" };
    if (onPath.has(nodeId)) {
      throw new InvalidJourneyGraphError(`"${node.label}" is part of a cycle. Remove the edge that leads back to it.`);
    }
    if (built.has(nodeId)) {
      throw new InvalidJourneyGraphError(`"${node.label}" has more than one parent. Remove one of the edges into it.`);
    }
    built.add(nodeId);
    onPath.add(nodeId);
    const tree = toTreeNode(node);
    onPath.delete(nodeId);
    return tree;
  }

  function toTreeNode(node: CampaignNode): CampaignTreeNode {
    const outgoing = outgoingMap.get(node.id) || [];

    switch (node.type) {
      case "setup":
        return {
          type: "setup",
          id: node.id,
          label: node.label,
          description: node.config.description || "Define journey settings",
          triggerType: node.config.triggerType || "user",
          triggerEventName: node.config.triggerEventName || "login_success",
          eventId: node.config.eventId,
          filters: node.config.filters,
          conditions: node.config.conditions,
          next: getNextNodes(outgoing),
        };

      case "check":
        if (node.config.checkType === "MultiBranchPath" && node.config.branches) {
          // Multi-branch: reconstruct branches with their children
          const multiBranches = (node.config.branches as BranchConfig[]).map((b) => {
            return {
              branchKey: b.branchKey,
              priority: b.priority,
              label: b.label,
              filters: b.filters,
              conditions: b.conditions,
              next: getNextNodes(outgoing.filter((c) => c.type === b.branchKey)),
            };
          });
          return {
            type: "check",
            id: node.id,
            label: node.label,
            eventType: node.config.eventType || "user",
            eventName: node.config.eventName || "",
            eventId: node.config.eventId,
            filters: node.config.filters,
            conditions: node.config.conditions,
            description: node.config.description,
            next: { type: "MultiBranchPath", branches: multiBranches } satisfies MultiBranchPath,
          };
        }
        return {
          type: "check",
          id: node.id,
          label: node.label,
          eventType: node.config.eventType || "user",
          eventName: node.config.eventName || "",
          eventId: node.config.eventId,
          filters: node.config.filters,
          conditions: node.config.conditions,
          description: node.config.description,
          next: checkPaths(node.config.checkType || "YesOrNoPath", outgoing),
        };

      case "segment": {
        // A segment takes only Yes. A No path saved by an older build stays while it has nodes,
        // and the builder offers Yes even on an older No Only segment, so both edges are read.
        const yes = getNextNodes(outgoing.filter((c) => c.type === YES_EDGE));
        const noConns = outgoing.filter((c) => c.type === NO_EDGE);
        return {
          type: "segment",
          id: node.id,
          label: node.label,
          conditions: node.config.conditions,
          description: node.config.description,
          next: noConns.length > 0
            ? { type: "YesOrNoPath", yes, no: getNextNodes(noConns) }
            : { type: "YesPath", yes },
        };
      }

      case "watch":
        if (node.config.watchType === "DelayPath") {
          return {
            type: "watch",
            id: node.id,
            label: node.label,
            timeLimitValue: node.config.timeLimitValue !== undefined ? Number(node.config.timeLimitValue) : 15,
            timeLimitUnit: node.config.timeLimitUnit || "minutes",
            description: node.config.description,
            next: { type: "DelayPath", next: getNextNodes(outgoing) }
          };
        }
        return {
          type: "watch",
          id: node.id,
          label: node.label,
          eventName: node.config.eventName,
          eventId: node.config.eventId,
          filters: node.config.filters,
          conditions: node.config.conditions,
          timeLimitValue: node.config.timeLimitValue !== undefined ? Number(node.config.timeLimitValue) : 15,
          timeLimitUnit: node.config.timeLimitUnit || "minutes",
          description: node.config.description,
          next: watchPaths(node.config.watchType || "SuccessOrTimeoutPath", outgoing),
        };

      case "engagement":
        return {
          type: "engagement",
          id: node.id,
          label: node.label,
          action: {
            type: node.subType || "push",
            title: node.config.title || node.config.subject || "",
            body: node.config.body || "",
            subject: node.config.subject || "",
            url: node.config.url || "",
            payload: node.config.payload || null,
            templateId: node.config.templateId || "",
            method: node.config.method || "POST",
          },
          next: getNextNodes(outgoing),
        };

      case "end":
        return {
          type: "end",
          goalId: node.config.goalId || "goal_default",
        };

      default:
        return { type: "end" };
    }
  }

  return buildNode(rootNode.id);
}

// The trigger_json of a node that fires on an event. Catalog default rows save as plain filters.
function eventTrigger(event: string, filters: EventFilters | undefined): Trigger {
  const saved = savedGroups(filters);
  return { kind: "event", event, ...(saved ? { filters: saved } : {}) };
}

function json(value: object | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

export function flattenCampaignTree(campaignId: string, root: CampaignTreeNode): DbCampaignNode[] {
  const dbNodes: DbCampaignNode[] = [];

  function traverse(
    node: CampaignTreeNode | undefined | null,
    parentId: string | null,
    parentBranch: string | null,
    index?: number
  ) {
    if (!node) return;

    // graphToTree builds an End node with no id. Naming a node by its place in
    // the tree gives it the same node_id on every publish and resume, which
    // keeps its campaign_node_stats row.
    const nodeId = node.id || [
      ...(parentId === null ? [] : [parentId, parentBranch]),
      ...(index === undefined ? [] : [index]),
      node.type,
    ].join("-");

    const baseNode: DbCampaignNode = {
      campaign_id: campaignId,
      node_id: nodeId,
      node_type: node.type,
      parent_node_id: parentId,
      parent_branch: parentBranch,
      trigger_json: null,
      conditions_json: null,
      paths_json: null,
      action_json: null,
      goal_id: null,
    };

    const traverseChildren = (target: CampaignTreeRef, branch: string) => {
      if (Array.isArray(target)) {
        target.forEach((t, i) => traverse(t, nodeId, branch, i));
      } else {
        traverse(target, nodeId, branch);
      }
    };

    switch (node.type) {
      case "setup": {
        baseNode.trigger_json = json(eventTrigger(node.triggerEventName, node.filters));
        baseNode.conditions_json = json(savedGroups(node.conditions));
        dbNodes.push(baseNode);
        if (node.next) traverseChildren(node.next, "next");
        break;
      }

      case "check": {
        baseNode.trigger_json = json(eventTrigger(node.eventName || "", node.filters));
        baseNode.conditions_json = json(savedGroups(node.conditions));
        if (node.next.type === "MultiBranchPath") {
          const paths: PathsRow = {
            path_type: "MultiBranchPath",
            branches: node.next.branches.map((b) => {
              const filters = savedGroups(b.filters);
              const conditions = savedGroups(b.conditions);
              return { key: b.branchKey, ...(filters ? { filters } : {}), ...(conditions ? { conditions } : {}) };
            }),
          };
          baseNode.paths_json = json(paths);
        }
        dbNodes.push(baseNode);
        if (node.next.type === "MultiBranchPath") {
          node.next.branches.forEach((b) => traverseChildren(b.next, b.branchKey));
        } else {
          if ("yes" in node.next) traverseChildren(node.next.yes, "yes");
          if ("no" in node.next) traverseChildren(node.next.no, "no");
        }
        break;
      }

      case "segment":
        baseNode.conditions_json = json(savedGroups(node.conditions));
        dbNodes.push(baseNode);
        if ("yes" in node.next) traverseChildren(node.next.yes, "yes");
        if ("no" in node.next) traverseChildren(node.next.no, "no");
        break;

      case "watch": {
        // A delay watches no event, so it has no trigger and no conditions, only its limit.
        if (node.next.type !== "DelayPath") {
          baseNode.trigger_json = json(eventTrigger(node.eventName || "", node.filters));
          baseNode.conditions_json = json(savedGroups(node.conditions));
        }
        const paths: PathsRow = {
          path_type: node.next.type,
          limit: {
            value: node.timeLimitValue !== undefined ? Number(node.timeLimitValue) : 15,
            unit: (node.timeLimitUnit || "minutes").toUpperCase() as LimitUnit,
          },
        };
        baseNode.paths_json = json(paths);
        dbNodes.push(baseNode);
        if (node.next.type === "DelayPath") {
          traverseChildren(node.next.next, "next");
        } else {
          if ("success" in node.next) traverseChildren(node.next.success, "success");
          if ("timeout" in node.next) traverseChildren(node.next.timeout, "timeout");
        }
        break;
      }

      case "engagement":
        baseNode.action_json = node.action ? JSON.stringify(node.action) : null;
        dbNodes.push(baseNode);
        if (node.next) traverseChildren(node.next, "next");
        break;

      case "end":
        baseNode.goal_id = node.goalId || null;
        dbNodes.push(baseNode);
        break;
    }
  }

  traverse(root, null, null);
  return dbNodes;
}

/** The tree layout: one column per level, one lane per leaf. */
export const LAYOUT = { stepX: 320, laneHeight: 132 } as const;

/**
 * An End node for a new branch. Its position is set by the next alignNodes.
 */
export function endPlaceholder(id: string, description = "Journey ends"): CampaignNode {
  return {
    id,
    type: "end",
    subType: "custom-list",
    label: "End",
    config: { description },
    position: { x: 0, y: 0 },
  };
}

/**
 * Aligns an array of nodes based on their connections using a BFS layout algorithm.
 */
export function alignNodes(
  nodes: CampaignNode[],
  connections: CampaignConnection[]
): CampaignNode[] {
  if (nodes.length === 0) return [];

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const positions = new Map<string, { x: number; y: number }>();
  const outgoingMap = new Map<string, CampaignConnection[]>();
  const { stepX, laneHeight } = LAYOUT;

  const edgeRank = (connection: CampaignConnection) => {
    if (connection.type === YES_EDGE) return 0;
    if (connection.type === NO_EDGE) return 2;
    return 1;
  };

  connections.forEach((connection) => {
    const outgoing = outgoingMap.get(connection.from) || [];
    outgoing.push(connection);
    outgoing.sort((left, right) => edgeRank(left) - edgeRank(right));
    outgoingMap.set(connection.from, outgoing);
  });

  const measured = new Map<string, number>();
  const measuring = new Set<string>();
  const measure = (id: string): number => {
    if (measured.has(id)) return measured.get(id)!;
    if (measuring.has(id)) return 1;
    measuring.add(id);
    const children = (outgoingMap.get(id) || []).filter((connection) => nodeMap.has(connection.to));
    const height = Math.max(1, children.reduce((sum, connection) => sum + measure(connection.to), 0));
    measuring.delete(id);
    measured.set(id, height);
    return height;
  };

  const visited = new Set<string>();
  const place = (id: string, depth: number, topLane: number) => {
    if (visited.has(id) || !nodeMap.has(id)) return;
    visited.add(id);
    const subtreeLanes = measure(id);
    positions.set(id, {
      x: 40 + depth * stepX,
      y: 72 + (topLane + subtreeLanes / 2 - 0.5) * laneHeight
    });

    let childTop = topLane;
    for (const connection of outgoingMap.get(id) || []) {
      const childLanes = measure(connection.to);
      place(connection.to, depth + 1, childTop);
      childTop += childLanes;
    }
  };

  const rootId = nodes.find((node) => node.type === "setup")?.id || nodes[0].id;
  place(rootId, 0, 0);

  let orphanLane = measure(rootId) + 1;
  nodes.forEach((n) => {
    if (!positions.has(n.id)) {
      positions.set(n.id, { x: 40, y: 72 + orphanLane * laneHeight });
      orphanLane += measure(n.id);
    }
  });

  return nodes.map((node) => ({
    ...node,
    position: positions.get(node.id) ?? { x: 40, y: 200 }
  }));
}

export type ChannelPlacementMode = "parallel" | "sequence";

export interface BranchOption {
  value: string;
  label: string;
  tone: "success" | "danger" | "branch" | "neutral";
}

export function getBranchOptions(node: CampaignNode): BranchOption[] {
  if (node.type === "watch") {
    if (node.config.watchType === "DelayPath") {
      return [{ value: YES_EDGE, label: "Next", tone: "neutral" }];
    }
    const options: BranchOption[] = [];
    if (node.config.watchType !== "TimeoutPath") {
      options.push({ value: YES_EDGE, label: "Success", tone: "success" });
    }
    if (node.config.watchType !== "SuccessPath") {
      options.push({ value: NO_EDGE, label: "Timeout", tone: "danger" });
    }
    return options;
  }

  if (node.type === "check" && node.config.checkType === "MultiBranchPath") {
    return ((node.config.branches || []) as BranchConfig[]).map((branch) => ({
      value: branch.branchKey,
      label: branch.label || branch.branchKey,
      tone: "branch" as const,
    }));
  }

  // A segment fires only yes. See the node types in docs/internal/features/journey-builder.md.
  if (node.type === "segment") {
    return [{ value: YES_EDGE, label: "Yes", tone: "success" }];
  }

  if (node.type === "check") {
    const options: BranchOption[] = [];
    if (node.config.checkType !== "NoPath") {
      options.push({ value: YES_EDGE, label: "Yes", tone: "success" });
    }
    if (node.config.checkType !== "YesPath") {
      options.push({ value: NO_EDGE, label: "No", tone: "danger" });
    }
    return options;
  }

  return [{ value: YES_EDGE, label: "Next", tone: "neutral" }];
}

export function placeChannelOnBranch(
  nodes: CampaignNode[],
  connections: CampaignConnection[],
  sourceId: string,
  channelNode: CampaignNode,
  branchType: string,
  mode: ChannelPlacementMode
): { nodes: CampaignNode[]; connections: CampaignConnection[] } {
  const branchConnections = connections.filter(
    (connection) => connection.from === sourceId && connection.type === branchType
  );
  const placeholderIds = new Set(
    branchConnections
      .map((connection) => nodes.find((node) => node.id === connection.to))
      .filter((node): node is CampaignNode => node?.type === "end")
      .map((node) => node.id)
  );
  const retainedBranchConnections = branchConnections.filter(
    (connection) => !placeholderIds.has(connection.to)
  );
  const baseConnections = connections.filter(
    (connection) =>
      !placeholderIds.has(connection.from) &&
      !placeholderIds.has(connection.to) &&
      !(mode === "sequence" && connection.from === sourceId && connection.type === branchType)
  );
  const nextConnections = [
    ...baseConnections,
    { from: sourceId, to: channelNode.id, type: branchType },
  ];

  if (mode === "sequence") {
    retainedBranchConnections.forEach((connection) => {
      nextConnections.push({ from: channelNode.id, to: connection.to, type: YES_EDGE });
    });
  }

  return {
    nodes: [...nodes.filter((node) => !placeholderIds.has(node.id)), channelNode],
    connections: nextConnections,
  };
}

export interface BranchEnd {
  sourceId: string;
  branchType: string;
}

/**
 * The node and branch the palette appends to: the end of the main path, which
 * follows the first branch of each node. End placeholders are not part of it.
 */
export function findMainPathTail(
  nodes: CampaignNode[],
  connections: CampaignConnection[]
): BranchEnd | undefined {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  let current = nodes.find((n) => n.type === "setup");
  const visited = new Set<string>();

  while (current) {
    visited.add(current.id);
    const sourceId = current.id;
    const branchType = getBranchOptions(current)[0]?.value ?? YES_EDGE;
    const next = connections
      .filter((c) => c.from === sourceId && c.type === branchType)
      .map((c) => nodeMap.get(c.to))
      .find((n) => n !== undefined && n.type !== "end" && !visited.has(n.id));
    if (!next) return { sourceId, branchType };
    current = next;
  }
  return undefined;
}

/**
 * Appends a node from the palette after the last node on the main path, in
 * place of the End placeholder on that branch.
 */
export function appendToMainPath(
  nodes: CampaignNode[],
  connections: CampaignConnection[],
  newNode: CampaignNode
): { nodes: CampaignNode[]; connections: CampaignConnection[] } {
  const tail = findMainPathTail(nodes, connections);
  if (!tail) return { nodes, connections };
  return placeChannelOnBranch(nodes, connections, tail.sourceId, newNode, tail.branchType, "parallel");
}

/**
 * The ids of a node and every node below it.
 */
export function getSubtreeNodeIds(
  startId: string,
  connections: CampaignConnection[]
): Set<string> {
  const ids = new Set<string>();
  const queue = [startId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (ids.has(id)) continue;
    ids.add(id);
    connections.filter((c) => c.from === id).forEach((c) => queue.push(c.to));
  }
  return ids;
}

/**
 * Whether the canvas accepts a new edge from source to target. The journey
 * must stay a tree under its setup node: no edge into the setup node, one
 * parent per node, and no cycle.
 */
export function canConnect(
  nodes: CampaignNode[],
  connections: CampaignConnection[],
  source: string,
  target: string
): boolean {
  if (nodes.find((n) => n.id === target)?.type === "setup") return false;
  if (connections.some((c) => c.to === target)) return false;
  return !getSubtreeNodeIds(target, connections).has(source);
}
