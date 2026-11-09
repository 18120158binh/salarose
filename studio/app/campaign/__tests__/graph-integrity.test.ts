import { appendToMainPath, canConnect, flattenCampaignTree, graphToTree, placeChannelOnBranch, treeToGraph } from "@/entities/journey/model/utils";
import { CampaignConnection, CampaignNode, CampaignTreeNode } from "@/entities/journey/model/types";

const node = (id: string, type: CampaignNode["type"], config: Record<string, unknown> = {}): CampaignNode => ({
  id,
  type,
  subType: type === "engagement" ? "push" : type === "end" ? "custom-list" : type,
  label: id,
  config,
  position: { x: 0, y: 0 },
} as CampaignNode);

const edge = (from: string, to: string, type = "required"): CampaignConnection => ({ from, to, type });

// The rows a publish writes, without the End rows, as [node_id, parent_node_id, parent_branch].
const savedRows = (graph: { nodes: CampaignNode[]; connections: CampaignConnection[] }) =>
  flattenCampaignTree("campaign-1", graphToTree(graph.nodes, graph.connections))
    .filter(row => row.node_type !== "end")
    .map(row => [row.node_id, row.parent_node_id, row.parent_branch]);

// A node added from the palette takes the place of the End placeholder and is saved.
describe("appendToMainPath", () => {
  it("replaces the End placeholder on the Yes branch of a check", () => {
    const graph = {
      nodes: [
        node("setup-node", "setup"),
        node("check", "check", { checkType: "YesOrNoPath" }),
        node("end-yes", "end"),
        node("end-no", "end"),
      ],
      connections: [
        edge("setup-node", "check"),
        edge("check", "end-yes", "required"),
        edge("check", "end-no", "undefined"),
      ],
    };

    const appended = appendToMainPath(graph.nodes, graph.connections, node("push", "engagement"));

    expect(savedRows(appended)).toEqual([
      ["setup-node", null, null],
      ["check", "setup-node", "next"],
      ["push", "check", "yes"],
    ]);
  });

  it("follows the No branch of a check that has only a No path", () => {
    const graph = {
      nodes: [
        node("setup-node", "setup"),
        node("check", "check", { checkType: "NoPath" }),
        node("end-no", "end"),
      ],
      connections: [edge("setup-node", "check"), edge("check", "end-no", "undefined")],
    };

    const appended = appendToMainPath(graph.nodes, graph.connections, node("push", "engagement"));

    expect(savedRows(appended)).toEqual([
      ["setup-node", null, null],
      ["check", "setup-node", "next"],
      ["push", "check", "no"],
    ]);
  });

  it("appends to a generated journey whose setup node has another id", () => {
    const graph = {
      nodes: [node("setup-ai", "setup"), node("push-1", "engagement")],
      connections: [edge("setup-ai", "push-1")],
    };

    const appended = appendToMainPath(graph.nodes, graph.connections, node("push-2", "engagement"));

    expect(savedRows(appended)).toEqual([
      ["setup-ai", null, null],
      ["push-1", "setup-ai", "next"],
      ["push-2", "push-1", "next"],
    ]);
  });
});

// The canvas must stay a tree under one setup node (JBD-FR-11).
describe("canConnect", () => {
  const nodes = [
    node("setup-ai", "setup"),
    node("check", "check", { checkType: "YesPath" }),
    node("push", "engagement"),
    node("loose", "engagement"),
  ];
  const connections = [edge("setup-ai", "check"), edge("check", "push")];

  it("accepts an edge to a node with no parent", () => {
    expect(canConnect(nodes, connections, "push", "loose")).toBe(true);
  });

  it("rejects an edge back to an ancestor", () => {
    expect(canConnect(nodes, connections, "push", "check")).toBe(false);
  });

  it("rejects an edge from a node to itself", () => {
    expect(canConnect(nodes, connections, "loose", "loose")).toBe(false);
  });

  it("rejects an edge into a node that already has a parent", () => {
    expect(canConnect(nodes, connections, "loose", "push")).toBe(false);
  });

  it("rejects an edge into the setup node", () => {
    expect(canConnect(nodes, connections, "loose", "setup-ai")).toBe(false);
  });
});

describe("graphToTree on a graph that is not a tree", () => {
  it("names the node on a cycle", () => {
    const nodes = [node("setup-node", "setup"), node("Check", "check", { checkType: "YesPath" }), node("Push", "engagement")];
    const connections = [edge("setup-node", "Check"), edge("Check", "Push"), edge("Push", "Check")];

    expect(() => graphToTree(nodes, connections)).toThrow('"Check" is part of a cycle');
  });

  it("names the node with two parents", () => {
    const nodes = [
      node("setup-node", "setup"),
      node("Check", "check", { checkType: "YesOrNoPath" }),
      node("Push", "engagement"),
    ];
    const connections = [
      edge("setup-node", "Check"),
      edge("Check", "Push", "required"),
      edge("Check", "Push", "undefined"),
    ];

    expect(() => graphToTree(nodes, connections)).toThrow('"Push" has more than one parent');
  });
});

// campaign_node_stats is keyed on node_id, so saving the same tree must not rename nodes (JBD-FR-12).
describe("flattenCampaignTree node ids", () => {
  const tree = {
    type: "setup", id: "setup", triggerEventName: "view_product",
    next: {
      type: "check", id: "check",
      next: {
        type: "YesOrNoPath",
        yes: [
          { type: "end", goalId: "goal_default" },
          { type: "engagement", id: "push", action: { type: "push" }, next: { type: "end", goalId: "goal_default" } },
        ],
        no: { type: "end", goalId: "goal_default" },
      },
    },
  } as unknown as CampaignTreeNode;

  it("gives an End node an id from its parent and branch", () => {
    const saved = flattenCampaignTree("campaign-1", tree).map(row => [row.node_id, row.parent_node_id, row.parent_branch]);

    expect(saved).toEqual([
      ["setup", null, null],
      ["check", "setup", "next"],
      ["check-yes-0-end", "check", "yes"],
      ["push", "check", "yes"],
      ["push-next-end", "push", "next"],
      ["check-no-end", "check", "no"],
    ]);
  });
});

// Placing an engagement in parallel on a named branch adds a second edge with that branch key.
describe("parallel children under a named multi-branch branch", () => {
  const multiBranch = node("mb", "check", {
    description: "Split by tier",
    checkType: "MultiBranchPath",
    branches: [
      { branchKey: "branch_0", priority: 0 },
      { branchKey: "branch_1", priority: 1 },
    ],
  });
  const graph = {
    nodes: [node("s", "setup"), multiBranch, node("p1", "engagement"), node("end-1", "end")],
    connections: [edge("s", "mb"), edge("mb", "p1", "branch_0"), edge("mb", "end-1", "branch_1")],
  };
  const allRows = (g: { nodes: CampaignNode[]; connections: CampaignConnection[] }) =>
    flattenCampaignTree("campaign-1", graphToTree(g.nodes, g.connections))
      .map(row => [row.node_id, row.parent_node_id, row.parent_branch]);

  it("saves every child of the branch, in order", () => {
    const placed = placeChannelOnBranch(graph.nodes, graph.connections, "mb", node("p2", "engagement"), "branch_0", "parallel");

    expect(allRows(placed)).toEqual([
      ["s", null, null],
      ["mb", "s", "next"],
      ["p1", "mb", "branch_0"],
      ["p1-next-end", "p1", "next"],
      ["p2", "mb", "branch_0"],
      ["p2-next-end", "p2", "next"],
      ["mb-branch_1-end", "mb", "branch_1"],
    ]);
  });

  it("saves a single child as before", () => {
    expect(allRows(graph)).toEqual([
      ["s", null, null],
      ["mb", "s", "next"],
      ["p1", "mb", "branch_0"],
      ["p1-next-end", "p1", "next"],
      ["mb-branch_1-end", "mb", "branch_1"],
    ]);
  });

  it("restores every child of the branch on load", () => {
    const placed = placeChannelOnBranch(graph.nodes, graph.connections, "mb", node("p2", "engagement"), "branch_0", "parallel");

    const loaded = treeToGraph(graphToTree(placed.nodes, placed.connections));

    expect(loaded.connections.filter(c => c.from === "mb" && c.type === "branch_0")).toEqual([
      { from: "mb", to: "p1", type: "branch_0" },
      { from: "mb", to: "p2", type: "branch_0" },
    ]);
  });

  it("gives a parallel End child an id from its position", () => {
    const tree = {
      type: "setup", id: "s", triggerEventName: "view_product",
      next: {
        type: "check", id: "mb",
        next: {
          type: "MultiBranchPath",
          branches: [{
            branchKey: "branch_0", priority: 0,
            next: [
              { type: "end", goalId: "goal_default" },
              { type: "engagement", id: "p1", action: { type: "push" }, next: { type: "end", goalId: "goal_default" } },
            ],
          }],
        },
      },
    } as unknown as CampaignTreeNode;

    const saved = flattenCampaignTree("campaign-1", tree).map(row => [row.node_id, row.parent_node_id, row.parent_branch]);

    expect(saved).toEqual([
      ["s", null, null],
      ["mb", "s", "next"],
      ["mb-branch_0-0-end", "mb", "branch_0"],
      ["p1", "mb", "branch_0"],
      ["p1-next-end", "p1", "next"],
    ]);
  });
});
