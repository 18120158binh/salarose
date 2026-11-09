import {
  addNode,
  insertNode,
  removeStep,
  updateNodeConfig,
  type JourneyGraph,
  type PaletteItem,
} from "@/entities/journey/model/graphEdits";
import type { CampaignNode, CampaignTreeNode } from "@/entities/journey/model/types";
import { graphToTree, treeToGraph } from "@/entities/journey/model/utils";

// The builder's state: the draft's name and graph, the selected step, the undo history, and where
// the autosave stands. Every edit goes through builderReducer, which bumps `revision`. Autosave
// sends a revision and records which one the server holds.

export interface LoadedDraft {
  name: string;
  version: number;
  graph: JourneyGraph;
  /** When the server last saved it, in epoch milliseconds. */
  savedAt: number;
}

export type SaveStatus =
  | { kind: "saved"; at: number }
  | { kind: "saving" }
  /** The save of `revision` failed. A later edit or Retry tries again. */
  | { kind: "failed"; revision: number }
  /** Another tab or computer saved first. Nothing saves until the marketer picks one. */
  | { kind: "conflict"; stored: LoadedDraft }
  /** The deployment changed under the open page, so its server action is gone. */
  | { kind: "stale" };

interface Snapshot {
  name: string;
  graph: JourneyGraph;
}

export interface BuilderState extends Snapshot {
  id: string;
  description: string;
  version: number;
  selected: string | null;
  past: Snapshot[];
  future: Snapshot[];
  revision: number;
  savedRevision: number;
  save: SaveStatus;
}

/** Where a palette item goes: on the edge from `from` to `to`. */
export interface InsertAt {
  from: string;
  to: string;
}

export type BuilderAction =
  | { type: "add"; item: PaletteItem; at: InsertAt | null; stamp: number }
  | { type: "configure"; nodeId: string; config: CampaignNode["config"]; stamp: number }
  | { type: "channel"; nodeId: string; channel: CampaignNode["subType"] }
  | { type: "rename"; name: string }
  | { type: "remove"; nodeId: string }
  | { type: "select"; nodeId: string | null }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "saveStarted" }
  | { type: "saved"; revision: number; version: number; at: number }
  | { type: "saveFailed"; revision: number }
  | { type: "saveConflict"; stored: LoadedDraft }
  | { type: "saveStale" }
  | { type: "retry" }
  | { type: "loadLatest" }
  | { type: "keepMine" };

const HISTORY = 100;

/** The canvas graph of a stored root, or null when the root is not a journey. */
export function graphFromRoot(root: Record<string, unknown>): JourneyGraph | null {
  if (root.type !== "setup") return null;
  return treeToGraph(root as unknown as CampaignTreeNode);
}

/** The saved format of the graph, which the draft actions store as `root`. */
export function rootOfGraph(graph: JourneyGraph): Record<string, unknown> {
  return graphToTree(graph.nodes, graph.connections) as unknown as Record<string, unknown>;
}

export function initialState(draft: LoadedDraft & { id: string; description: string }): BuilderState {
  return {
    id: draft.id,
    description: draft.description,
    name: draft.name,
    graph: draft.graph,
    version: draft.version,
    selected: null,
    past: [],
    future: [],
    revision: 0,
    savedRevision: 0,
    save: { kind: "saved", at: draft.savedAt },
  };
}

function edit(state: BuilderState, next: Snapshot, selected = state.selected): BuilderState {
  return {
    ...state,
    ...next,
    selected,
    past: [...state.past, { name: state.name, graph: state.graph }].slice(-HISTORY),
    future: [],
    revision: state.revision + 1,
  };
}

function stillThere(graph: JourneyGraph, id: string | null): string | null {
  return id !== null && graph.nodes.some((n) => n.id === id) ? id : null;
}

export function builderReducer(state: BuilderState, action: BuilderAction): BuilderState {
  switch (action.type) {
    case "add": {
      const added = addStep(state.graph, action);
      return added ? edit(state, { name: state.name, graph: added.graph }, added.nodeId) : state;
    }
    case "configure": {
      const node = state.graph.nodes.find((n) => n.id === action.nodeId);
      const updated = updateNodeConfig(state.graph, { nodeId: action.nodeId, config: action.config, label: node?.label, stamp: action.stamp });
      return updated ? edit(state, { name: state.name, graph: updated.graph }) : state;
    }
    case "channel": {
      // Switching keeps the text both channels share: SMS has a body only.
      const nodes = state.graph.nodes.map((n) => {
        if (n.id !== action.nodeId || n.type !== "engagement") return n;
        const { title, url, ...shared } = n.config;
        const config = action.channel === "sms" ? shared : { ...shared, title: title ?? "", url: url ?? "" };
        return { ...n, subType: action.channel, config };
      });
      return edit(state, { name: state.name, graph: { nodes, connections: state.graph.connections } });
    }
    case "rename":
      return action.name === state.name ? state : edit(state, { name: action.name, graph: state.graph });
    case "remove": {
      const graph = removeStep(state.graph, action.nodeId);
      return graph ? edit(state, { name: state.name, graph }, stillThere(graph, state.selected)) : state;
    }
    case "select":
      return { ...state, selected: stillThere(state.graph, action.nodeId) };
    case "undo": {
      const target = state.past.at(-1);
      if (!target) return state;
      return {
        ...state,
        ...target,
        past: state.past.slice(0, -1),
        future: [...state.future, { name: state.name, graph: state.graph }],
        selected: stillThere(target.graph, state.selected),
        revision: state.revision + 1,
      };
    }
    case "redo": {
      const target = state.future.at(-1);
      if (!target) return state;
      return {
        ...state,
        ...target,
        future: state.future.slice(0, -1),
        past: [...state.past, { name: state.name, graph: state.graph }],
        selected: stillThere(target.graph, state.selected),
        revision: state.revision + 1,
      };
    }
    case "saveStarted":
      return { ...state, save: { kind: "saving" } };
    case "saved":
      return { ...state, version: action.version, savedRevision: action.revision, save: { kind: "saved", at: action.at } };
    case "saveFailed":
      return { ...state, save: { kind: "failed", revision: action.revision } };
    case "saveConflict":
      return { ...state, save: { kind: "conflict", stored: action.stored } };
    case "saveStale":
      return { ...state, save: { kind: "stale" } };
    case "retry":
      return state.save.kind === "failed" ? { ...state, save: { kind: "saving" }, savedRevision: -1 } : state;
    case "loadLatest": {
      if (state.save.kind !== "conflict") return state;
      const { stored } = state.save;
      return {
        ...state,
        name: stored.name,
        graph: stored.graph,
        version: stored.version,
        selected: stillThere(stored.graph, state.selected),
        past: [],
        future: [],
        revision: state.revision + 1,
        savedRevision: state.revision + 1,
        save: { kind: "saved", at: stored.savedAt },
      };
    }
    case "keepMine":
      if (state.save.kind !== "conflict") return state;
      return { ...state, version: state.save.stored.version, savedRevision: -1, save: { kind: "saved", at: state.save.stored.savedAt } };
  }
}

// A Branch by event starts as a two-path check, then takes its named branches, so each branch
// gets its own End.
function addStep(graph: JourneyGraph, { item, at, stamp }: { item: PaletteItem; at: InsertAt | null; stamp: number }) {
  const multi = item.defaultConfig.checkType === "MultiBranchPath";
  // Named branches replace every path, so on an edge they would drop the steps below it.
  if (multi && at) return null;
  const base = multi ? { ...item, defaultConfig: { ...item.defaultConfig, checkType: "YesOrNoPath" } } : item;
  const added = at ? insertNode(graph, { from: at.from, to: at.to, item: base, stamp }) : addNode(graph, { item: base, stamp });
  if (!added || !multi) return added;
  const node = added.graph.nodes.find((n) => n.id === added.nodeId);
  if (!node) return added;
  const updated = updateNodeConfig(added.graph, { nodeId: node.id, config: { ...node.config, checkType: "MultiBranchPath" }, stamp });
  return updated ? { graph: updated.graph, nodeId: node.id } : added;
}

/** Whether the server holds every edit. */
export function isSaved(state: BuilderState): boolean {
  return state.revision === state.savedRevision;
}
