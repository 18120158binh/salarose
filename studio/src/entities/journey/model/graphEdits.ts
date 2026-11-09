import {
  NO_EDGE,
  YES_EDGE,
  type BinaryEdgeKind,
  type CampaignConnection,
  type CampaignNode,
  type NodeType,
} from "./types";
import {
  appendToMainPath,
  canConnect,
  endPlaceholder,
  getBranchOptions,
  getSubtreeNodeIds,
  placeChannelOnBranch,
  type BranchConfig,
  type ChannelPlacementMode,
} from "./utils";

/**
 * The edits the journey builder makes to its canvas graph. Each one takes the graph and returns a
 * new one. The caller lays the result out. `stamp` names the new nodes, so a test can fix it.
 */

export interface JourneyGraph {
  nodes: CampaignNode[];
  connections: CampaignConnection[];
}

type NodeConfig = CampaignNode["config"];

/** The part of a palette item that makes a node. */
export interface PaletteItem {
  type: NodeType;
  subType: CampaignNode["subType"];
  label: string;
  defaultConfig: NodeConfig;
}

/** Where a channel added on a branching node goes, as the marketer chose it. */
export interface ChannelPlacement {
  sourceId: string;
  branchType: string;
  mode: ChannelPlacementMode;
}

/** A graph after an edit that added a node, and that node's id. */
export interface NodeAdded {
  graph: JourneyGraph;
  nodeId: string;
}

/** Whether a node of this type has more than one path. A delay watch has one. */
export function isBranchingType(type: NodeType, config?: NodeConfig): boolean {
  if (type === "watch" && config?.watchType === "DelayPath") return false;
  return type === "check" || type === "segment" || type === "watch";
}

function nodeFromItem(item: PaletteItem, id: string): CampaignNode {
  return {
    id,
    type: item.type,
    subType: item.subType,
    label: item.label,
    config: { ...item.defaultConfig },
    position: { x: 0, y: 0 },
  };
}

// A segment has no No path.
function hasNoPath(node: CampaignNode): boolean {
  return getBranchOptions(node).some((option) => option.value === NO_EDGE);
}

function withEnd(
  graph: JourneyGraph,
  from: string,
  endId: string,
  type: string,
  description?: string,
): JourneyGraph {
  return {
    nodes: [...graph.nodes, endPlaceholder(endId, description)],
    connections: [...graph.connections, { from, to: endId, type }],
  };
}

function withoutSubtree(graph: JourneyGraph, rootId: string): JourneyGraph {
  const ids = getSubtreeNodeIds(rootId, graph.connections);
  return {
    nodes: graph.nodes.filter((n) => !ids.has(n.id)),
    connections: graph.connections.filter((c) => !ids.has(c.from) && !ids.has(c.to)),
  };
}

function withoutPaths(graph: JourneyGraph, nodeId: string, drop: (c: CampaignConnection) => boolean): JourneyGraph {
  return graph.connections
    .filter((c) => c.from === nodeId && drop(c))
    .reduce((next, c) => withoutSubtree(next, c.to), graph);
}

function hasPath(graph: JourneyGraph, nodeId: string, type: string): boolean {
  return graph.connections.some((c) => c.from === nodeId && c.type === type);
}

/**
 * Adds a palette item. With a placement it goes on the chosen branch, otherwise at the end of the
 * main path. A branching node gets an End on Yes, and on No when it has a No path.
 */
export function addNode(
  graph: JourneyGraph,
  { item, stamp, placement }: { item: PaletteItem; stamp: number; placement?: ChannelPlacement },
): NodeAdded {
  const node = nodeFromItem(item, `node_${stamp}`);
  let next = placement
    ? placeChannelOnBranch(graph.nodes, graph.connections, placement.sourceId, node, placement.branchType, placement.mode)
    : appendToMainPath(graph.nodes, graph.connections, node);

  if (isBranchingType(item.type)) {
    next = withEnd(next, node.id, `end_yes_${stamp}`, YES_EDGE);
    if (hasNoPath(node)) next = withEnd(next, node.id, `end_no_${stamp}`, NO_EDGE);
  }
  return { graph: next, nodeId: node.id };
}

/**
 * Inserts a palette item on the edge from `from` to `to`. The edge into the new node keeps the old
 * edge's kind, and the new node's Yes path takes the old target. A branching node with a No path
 * gets an End on No. Returns null when either end of the edge is not on the canvas.
 */
export function insertNode(
  graph: JourneyGraph,
  { from, to, item, stamp }: { from: string; to: string; item: PaletteItem; stamp: number },
): NodeAdded | null {
  if (!graph.nodes.some((n) => n.id === from) || !graph.nodes.some((n) => n.id === to)) return null;

  const node = nodeFromItem(item, `node_${stamp}`);
  const isOldEdge = (c: CampaignConnection) => c.from === from && c.to === to;
  const oldType = graph.connections.find(isOldEdge)?.type ?? YES_EDGE;

  let next: JourneyGraph = {
    nodes: [...graph.nodes, node],
    connections: [
      ...graph.connections.filter((c) => !isOldEdge(c)),
      { from, to: node.id, type: oldType },
      { from: node.id, to, type: YES_EDGE },
    ],
  };
  if (isBranchingType(item.type) && hasNoPath(node)) {
    next = withEnd(next, node.id, `end_no_${stamp}`, NO_EDGE);
  }
  return { graph: next, nodeId: node.id };
}

/** Deletes a node and everything below it. Returns null for the setup node, which stays. */
export function deleteNode(graph: JourneyGraph, id: string): JourneyGraph | null {
  if (graph.nodes.find((n) => n.id === id)?.type === "setup") return null;
  return withoutSubtree(graph, id);
}

/** The edge kind a canvas handle draws: the No handle draws NO_EDGE, a branch handle its key. */
export function edgeKindForHandle(handle: string | null | undefined): string {
  if (handle === "no") return NO_EDGE;
  if (handle && handle !== "yes") return handle;
  return YES_EDGE;
}

/**
 * Adds an edge the marketer drew. Returns null when the edge would break the tree, which
 * canConnect decides.
 */
export function connect(
  graph: JourneyGraph,
  { source, target, sourceHandle }: { source: string | null; target: string | null; sourceHandle?: string | null },
): JourneyGraph | null {
  if (!source || !target) return null;
  if (!canConnect(graph.nodes, graph.connections, source, target)) return null;
  return {
    nodes: graph.nodes,
    connections: [...graph.connections, { from: source, to: target, type: edgeKindForHandle(sourceHandle) }],
  };
}

const DEFAULT_BRANCHES: BranchConfig[] = [
  { branchKey: "branch_0", priority: 0, label: "Branch A" },
  { branchKey: "branch_1", priority: 1, label: "Branch B" },
];

function branchEndDescription(branch: BranchConfig): string {
  return `Journey ends (${branch.label || branch.branchKey})`;
}

// The path a single-path type drops, and so the one it keeps.
function droppedPath(pathType: string): BinaryEdgeKind | null {
  if (pathType === "YesPath" || pathType === "SuccessPath") return NO_EDGE;
  if (pathType === "NoPath" || pathType === "TimeoutPath") return YES_EDGE;
  return null;
}

function changePathType(
  graph: JourneyGraph,
  { nodeId, oldType, newType, config, stamp }: { nodeId: string; oldType: string; newType: string; config: NodeConfig; stamp: number },
): JourneyGraph {
  if (newType === "DelayPath") {
    const cleared = withoutPaths(graph, nodeId, () => true);
    return withEnd(cleared, nodeId, `end_delay_${stamp}`, YES_EDGE);
  }

  if (newType === "MultiBranchPath") {
    const branches: BranchConfig[] = config.branches || DEFAULT_BRANCHES;
    return branches.reduce(
      (next, b) => withEnd(next, nodeId, `end_${b.branchKey}_${stamp}`, b.branchKey, branchEndDescription(b)),
      withoutPaths(graph, nodeId, () => true),
    );
  }

  // Leaving a multi-branch check clears its branches, so there is no single path to drop.
  let next = graph;
  let drop = droppedPath(newType);
  if (oldType === "MultiBranchPath") {
    next = withoutPaths(next, nodeId, () => true);
    drop = null;
  }

  if (drop) {
    const dropped = next.connections.find((c) => c.from === nodeId && c.type === drop);
    if (dropped) next = withoutSubtree(next, dropped.to);
    const kept = drop === NO_EDGE ? YES_EDGE : NO_EDGE;
    if (!hasPath(next, nodeId, kept)) next = withEnd(next, nodeId, `end_${kept}_${stamp}`, kept);
  }

  if (newType === "YesOrNoPath" || newType === "SuccessOrTimeoutPath") {
    const hasYes = hasPath(next, nodeId, YES_EDGE);
    const hasNo = hasPath(next, nodeId, NO_EDGE);
    if (!hasYes) next = withEnd(next, nodeId, `end_yes_${stamp}`, YES_EDGE);
    if (!hasNo) next = withEnd(next, nodeId, `end_no_${stamp}`, NO_EDGE);
  }
  return next;
}

// A multi-branch check keeps one path per branch: a removed branch drops its subtree, and a new
// branch gets an End.
function syncBranches(
  graph: JourneyGraph,
  { nodeId, branches, stamp }: { nodeId: string; branches: BranchConfig[]; stamp: number },
): { graph: JourneyGraph; changed: boolean } {
  const outgoing = graph.connections.filter((c) => c.from === nodeId);
  const removed = outgoing.filter((c) => !branches.some((b) => b.branchKey === c.type));
  const existingKeys = new Set(outgoing.map((c) => c.type));
  const added = branches.filter((b) => !existingKeys.has(b.branchKey));

  const pruned = removed.reduce((next, c) => withoutSubtree(next, c.to), graph);
  const next = added.reduce(
    (acc, b, i) => withEnd(acc, nodeId, `end_${b.branchKey}_${stamp}_${i}`, b.branchKey, branchEndDescription(b)),
    pruned,
  );
  return { graph: next, changed: removed.length > 0 || added.length > 0 };
}

/**
 * Applies an editor's config and label to a node. When a branching node's path type changes, or a
 * multi-branch check's branches change, its paths follow: a dropped path loses its subtree and a
 * new path gets an End. `pathsChanged` says whether the paths moved, so the caller lays out again.
 * Returns null when the node is not on the canvas.
 */
export function updateNodeConfig(
  graph: JourneyGraph,
  { nodeId, config, label, stamp }: { nodeId: string; config: NodeConfig; label?: string; stamp: number },
): { graph: JourneyGraph; pathsChanged: boolean } | null {
  const oldNode = graph.nodes.find((n) => n.id === nodeId);
  if (!oldNode) return null;

  const updated: JourneyGraph = {
    nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, config, label: label || n.label } : n)),
    connections: graph.connections,
  };
  if (!isBranchingType(oldNode.type, oldNode.config)) return { graph: updated, pathsChanged: false };

  const oldType =
    oldNode.config.checkType ||
    oldNode.config.watchType ||
    (oldNode.type === "watch" ? "SuccessOrTimeoutPath" : "YesOrNoPath");
  const newType = config.checkType || config.watchType || oldType;

  if (oldType !== newType) {
    return { graph: changePathType(updated, { nodeId, oldType, newType, config, stamp }), pathsChanged: true };
  }
  if (newType === "MultiBranchPath") {
    const synced = syncBranches(updated, { nodeId, branches: config.branches || [], stamp });
    return { graph: synced.graph, pathsChanged: synced.changed };
  }
  return { graph: updated, pathsChanged: false };
}

/** How many steps sit below a node, End steps included. */
export function stepsBelow(graph: JourneyGraph, id: string): number {
  return getSubtreeNodeIds(id, graph.connections).size - 1;
}

/**
 * Removes a step the v2 builder's way (JBD-FR-42). A branching step goes with everything below
 * it. A one-path step goes alone, and its children hang from its parent on the branch it hung
 * from, so the tree keeps one parent per node. Returns null for the setup node, and for a step
 * with no parent.
 */
export function removeStep(graph: JourneyGraph, id: string): JourneyGraph | null {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node || node.type === "setup") return null;
  if (isBranchingType(node.type, node.config)) return withoutSubtree(graph, id);

  const incoming = graph.connections.find((c) => c.to === id);
  if (!incoming) return null;
  const moved = graph.connections
    .filter((c) => c.from === id)
    .map((c) => ({ from: incoming.from, to: c.to, type: incoming.type }));
  return {
    nodes: graph.nodes.filter((n) => n.id !== id),
    connections: [...graph.connections.filter((c) => c.from !== id && c.to !== id), ...moved],
  };
}
