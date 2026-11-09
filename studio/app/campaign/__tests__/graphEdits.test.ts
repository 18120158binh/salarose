import type { CampaignConnection, CampaignNode, NodeType } from "@/entities/journey/model/types";
import { NO_EDGE, YES_EDGE } from "@/entities/journey/model/types";
import {
  addNode,
  connect,
  deleteNode,
  edgeKindForHandle,
  insertNode,
  isBranchingType,
  updateNodeConfig,
  type JourneyGraph,
  type PaletteItem,
} from "@/entities/journey/model/graphEdits";

const node = (id: string, type: NodeType, config: CampaignNode["config"] = {}): CampaignNode => ({
  id,
  type,
  subType: type === "engagement" ? "push" : type === "end" ? "custom-list" : type,
  label: id,
  config,
  position: { x: 0, y: 0 },
});
const edge = (from: string, to: string, type: string = YES_EDGE): CampaignConnection => ({ from, to, type });
const ids = (graph: JourneyGraph) => graph.nodes.map((n) => n.id);

const checkItem: PaletteItem = { type: "check", subType: "check", label: "Check", defaultConfig: {} };
const segmentItem: PaletteItem = { type: "segment", subType: "segment", label: "Segment", defaultConfig: {} };
const pushItem: PaletteItem = { type: "engagement", subType: "push", label: "Push", defaultConfig: { title: "Hi" } };

// setup -> check, with an email on Yes and an End on No.
const checkGraph = (checkConfig: CampaignNode["config"] = {}): JourneyGraph => ({
  nodes: [node("setup", "setup"), node("check", "check", checkConfig), node("email", "engagement"), node("email-end", "end"), node("no-end", "end")],
  connections: [edge("setup", "check"), edge("check", "email"), edge("email", "email-end"), edge("check", "no-end", NO_EDGE)],
});

describe("isBranchingType", () => {
  it("counts check, segment, and watch, but not a delay watch", () => {
    expect(isBranchingType("check")).toBe(true);
    expect(isBranchingType("segment")).toBe(true);
    expect(isBranchingType("watch")).toBe(true);
    expect(isBranchingType("watch", { watchType: "DelayPath" })).toBe(false);
    expect(isBranchingType("engagement")).toBe(false);
  });
});

describe("addNode", () => {
  const start: JourneyGraph = { nodes: [node("setup", "setup"), node("setup-end", "end")], connections: [edge("setup", "setup-end")] };

  it("puts a check at the end of the main path with a Yes and a No End", () => {
    const { graph, nodeId } = addNode(start, { item: checkItem, stamp: 7 });

    expect(nodeId).toBe("node_7");
    expect(ids(graph)).toEqual(["setup", "node_7", "end_yes_7", "end_no_7"]);
    expect(graph.connections).toEqual([edge("setup", "node_7"), edge("node_7", "end_yes_7"), edge("node_7", "end_no_7", NO_EDGE)]);
    expect(graph.nodes[1]).toMatchObject({ type: "check", subType: "check", label: "Check", config: {} });
  });

  it("gives a segment only a Yes End", () => {
    const { graph } = addNode(start, { item: segmentItem, stamp: 7 });

    expect(ids(graph)).toEqual(["setup", "node_7", "end_yes_7"]);
    expect(graph.connections).toEqual([edge("setup", "node_7"), edge("node_7", "end_yes_7")]);
  });

  it("gives a channel no End and copies its default config", () => {
    const { graph } = addNode(start, { item: pushItem, stamp: 7 });

    expect(graph.connections).toEqual([edge("setup", "node_7")]);
    expect(graph.nodes[1].config).toEqual({ title: "Hi" });
    expect(graph.nodes[1].config).not.toBe(pushItem.defaultConfig);
  });

  it("places a channel on the chosen branch in place of its End", () => {
    const { graph } = addNode(checkGraph(), {
      item: pushItem,
      stamp: 7,
      placement: { sourceId: "check", branchType: NO_EDGE, mode: "parallel" },
    });

    expect(ids(graph)).not.toContain("no-end");
    expect(graph.connections).toContainEqual(edge("check", "node_7", NO_EDGE));
  });
});

describe("insertNode", () => {
  it("keeps the old edge's kind into the new node and hands the old target to its Yes path", () => {
    const inserted = insertNode(checkGraph(), { from: "check", to: "no-end", item: checkItem, stamp: 9 });

    expect(inserted?.nodeId).toBe("node_9");
    expect(ids(inserted!.graph)).toEqual(["setup", "check", "email", "email-end", "no-end", "node_9", "end_no_9"]);
    expect(inserted!.graph.connections).toEqual([
      edge("setup", "check"),
      edge("check", "email"),
      edge("email", "email-end"),
      edge("check", "node_9", NO_EDGE),
      edge("node_9", "no-end"),
      edge("node_9", "end_no_9", NO_EDGE),
    ]);
  });

  it("adds no End for a segment or a channel", () => {
    const segment = insertNode(checkGraph(), { from: "check", to: "email", item: segmentItem, stamp: 9 });
    const push = insertNode(checkGraph(), { from: "check", to: "email", item: pushItem, stamp: 9 });

    expect(ids(segment!.graph)).toHaveLength(6);
    expect(ids(push!.graph)).toHaveLength(6);
  });

  it("returns null when an end of the edge is missing", () => {
    expect(insertNode(checkGraph(), { from: "check", to: "gone", item: pushItem, stamp: 9 })).toBeNull();
  });
});

describe("deleteNode", () => {
  it("removes the node and its subtree", () => {
    const next = deleteNode(checkGraph(), "check");

    expect(next).toEqual({ nodes: [node("setup", "setup")], connections: [] });
  });

  it("keeps the setup node", () => {
    expect(deleteNode(checkGraph(), "setup")).toBeNull();
  });
});

describe("connect", () => {
  const withOrphan = (): JourneyGraph => {
    const graph = checkGraph({ checkType: "MultiBranchPath" });
    return { ...graph, nodes: [...graph.nodes, node("orphan", "engagement")] };
  };

  it("maps a canvas handle to an edge kind", () => {
    expect(edgeKindForHandle("yes")).toBe(YES_EDGE);
    expect(edgeKindForHandle(null)).toBe(YES_EDGE);
    expect(edgeKindForHandle("no")).toBe(NO_EDGE);
    expect(edgeKindForHandle("branch_1")).toBe("branch_1");
  });

  it("adds the drawn edge", () => {
    const next = connect(withOrphan(), { source: "check", target: "orphan", sourceHandle: "branch_1" });

    expect(next?.connections.at(-1)).toEqual(edge("check", "orphan", "branch_1"));
  });

  it("refuses an edge that breaks the tree or lacks an end", () => {
    expect(connect(withOrphan(), { source: "check", target: "email", sourceHandle: "no" })).toBeNull();
    expect(connect(withOrphan(), { source: "orphan", target: "setup" })).toBeNull();
    expect(connect(withOrphan(), { source: null, target: "orphan" })).toBeNull();
  });
});

describe("updateNodeConfig", () => {
  it("applies the config and keeps the label when none is given", () => {
    const result = updateNodeConfig(checkGraph(), { nodeId: "email", config: { title: "New" }, stamp: 1 });

    expect(result?.pathsChanged).toBe(false);
    expect(result?.graph.nodes[2]).toMatchObject({ label: "email", config: { title: "New" } });
    expect(result?.graph.connections).toEqual(checkGraph().connections);
  });

  it("returns null for a node that is not on the canvas", () => {
    expect(updateNodeConfig(checkGraph(), { nodeId: "gone", config: {}, stamp: 1 })).toBeNull();
  });

  it("drops the No subtree when a check becomes Yes only", () => {
    const result = updateNodeConfig(checkGraph(), { nodeId: "check", config: { checkType: "YesPath" }, stamp: 1 });

    expect(result?.pathsChanged).toBe(true);
    expect(ids(result!.graph)).toEqual(["setup", "check", "email", "email-end"]);
  });

  it("drops the Yes subtree and keeps the No End when a check becomes No only", () => {
    const result = updateNodeConfig(checkGraph(), { nodeId: "check", config: { checkType: "NoPath" }, stamp: 1 });

    expect(ids(result!.graph)).toEqual(["setup", "check", "no-end"]);
    expect(result!.graph.connections).toEqual([edge("setup", "check"), edge("check", "no-end", NO_EDGE)]);
  });

  it("adds an End for the kept path when it has none", () => {
    const graph = checkGraph({ checkType: "NoPath" });
    const noYes = { ...graph, connections: graph.connections.filter((c) => c.to !== "email") };

    const result = updateNodeConfig(noYes, { nodeId: "check", config: { checkType: "YesPath" }, stamp: 1 });

    expect(result!.graph.connections).toContainEqual(edge("check", "end_required_1"));
    expect(ids(result!.graph)).toContain("end_required_1");
  });

  it("adds the missing path's End when a check goes back to Yes or No", () => {
    const yesOnly = updateNodeConfig(checkGraph(), { nodeId: "check", config: { checkType: "YesPath" }, stamp: 1 })!.graph;
    const withYesOnlyConfig = { ...yesOnly, nodes: yesOnly.nodes.map((n) => (n.id === "check" ? { ...n, config: { checkType: "YesPath" } } : n)) };

    const result = updateNodeConfig(withYesOnlyConfig, { nodeId: "check", config: { checkType: "YesOrNoPath" }, stamp: 2 });

    expect(result!.graph.connections.at(-1)).toEqual(edge("check", "end_no_2", NO_EDGE));
  });

  it("clears every path and adds one End when a watch becomes a delay", () => {
    const graph: JourneyGraph = {
      nodes: [node("setup", "setup"), node("watch", "watch"), node("s-end", "end"), node("t-end", "end")],
      connections: [edge("setup", "watch"), edge("watch", "s-end"), edge("watch", "t-end", NO_EDGE)],
    };

    const result = updateNodeConfig(graph, { nodeId: "watch", config: { watchType: "DelayPath" }, stamp: 3 });

    expect(ids(result!.graph)).toEqual(["setup", "watch", "end_delay_3"]);
    expect(result!.graph.connections).toEqual([edge("setup", "watch"), edge("watch", "end_delay_3")]);
  });

  it("leaves a delay watch's paths alone", () => {
    const graph: JourneyGraph = {
      nodes: [node("setup", "setup"), node("watch", "watch", { watchType: "DelayPath" }), node("end", "end")],
      connections: [edge("setup", "watch"), edge("watch", "end")],
    };

    const result = updateNodeConfig(graph, { nodeId: "watch", config: { watchType: "SuccessPath" }, stamp: 3 });

    expect(result?.pathsChanged).toBe(false);
    expect(result?.graph.connections).toEqual(graph.connections);
  });

  it("gives a check that becomes multi-branch one End per branch, with two default branches", () => {
    const result = updateNodeConfig(checkGraph(), { nodeId: "check", config: { checkType: "MultiBranchPath" }, stamp: 4 });

    expect(ids(result!.graph)).toEqual(["setup", "check", "end_branch_0_4", "end_branch_1_4"]);
    expect(result!.graph.connections.slice(1)).toEqual([edge("check", "end_branch_0_4", "branch_0"), edge("check", "end_branch_1_4", "branch_1")]);
    expect(result!.graph.nodes[2].config).toEqual({ description: "Journey ends (Branch A)" });
  });

  it("clears the branches and adds a Yes and a No End when a multi-branch check goes back to Yes or No", () => {
    const graph: JourneyGraph = {
      nodes: [node("setup", "setup"), node("check", "check", { checkType: "MultiBranchPath" }), node("a", "end")],
      connections: [edge("setup", "check"), edge("check", "a", "branch_0")],
    };

    const result = updateNodeConfig(graph, { nodeId: "check", config: { checkType: "YesPath" }, stamp: 5 });

    expect(ids(result!.graph)).toEqual(["setup", "check"]);
    expect(result!.graph.connections).toEqual([edge("setup", "check")]);

    const both = updateNodeConfig(graph, { nodeId: "check", config: { checkType: "YesOrNoPath" }, stamp: 5 });
    expect(ids(both!.graph)).toEqual(["setup", "check", "end_yes_5", "end_no_5"]);
  });

  it("follows a multi-branch check's branch list", () => {
    const graph: JourneyGraph = {
      nodes: [node("setup", "setup"), node("check", "check", { checkType: "MultiBranchPath" }), node("a", "end"), node("b", "end")],
      connections: [edge("setup", "check"), edge("check", "a", "branch_0"), edge("check", "b", "branch_1")],
    };
    const branches = [
      { branchKey: "branch_0", priority: 0, label: "A" },
      { branchKey: "branch_2", priority: 1 },
    ];

    const result = updateNodeConfig(graph, { nodeId: "check", config: { checkType: "MultiBranchPath", branches }, stamp: 6 });

    expect(result?.pathsChanged).toBe(true);
    expect(ids(result!.graph)).toEqual(["setup", "check", "a", "end_branch_2_6_0"]);
    expect(result!.graph.connections.at(-1)).toEqual(edge("check", "end_branch_2_6_0", "branch_2"));
    expect(result!.graph.nodes[3].config).toEqual({ description: "Journey ends (branch_2)" });

    const same = updateNodeConfig(graph, {
      nodeId: "check",
      config: { checkType: "MultiBranchPath", branches: [branches[0], { branchKey: "branch_1", priority: 1 }] },
      stamp: 6,
    });
    expect(same?.pathsChanged).toBe(false);
  });

  it("uses a new label", () => {
    const result = updateNodeConfig(checkGraph(), { nodeId: "check", config: {}, label: "Bought?", stamp: 1 });

    expect(result?.graph.nodes[1].label).toBe("Bought?");
    expect(result?.pathsChanged).toBe(false);
  });
});
