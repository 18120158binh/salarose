import { flattenCampaignTree, graphToTree, treeToGraph } from "@/entities/journey/model/utils";
import type { CampaignTreeNode } from "@/entities/journey/model/types";

// JBD-FR-02: loading a saved journey gives back the same canvas, so saving it again gives back
// the same tree and the same node rows. The tree below has every node type and path type.
const filters = (field: string, value: unknown) => ({ groups: [{ conditions: [{ type: "event_property", field, op: "=", value }] }] });
const profile = { groups: [{ conditions: [{ type: "profile_property", field: "city", op: "IN", value: ["Hanoi"] }] }] };
const end = { type: "end", goalId: "goal_default" };
const push = (id: string, next: unknown = end) => ({
  type: "engagement", id, label: id,
  action: { type: "push", title: "Hi", body: "Come back", subject: "", url: "", payload: null, templateId: "", method: "POST" },
  next,
});
const check = (id: string, next: unknown) => ({
  type: "check", id, label: id, eventType: "user", eventName: "purchase",
  filters: filters("order.total", 1000), conditions: profile, description: `Check ${id}`, next,
});
const watch = (id: string, next: unknown) => ({
  type: "watch", id, label: id, eventName: "add_to_cart", filters: filters("product.brand", "acme"),
  timeLimitValue: 15, timeLimitUnit: "minutes", description: `Watch ${id}`, next,
});
const behavior = {
  groups: [{ conditions: [{ type: "behavior", event: "purchase", measure: "COUNT", window: { value: 30, unit: "DAYS" }, op: ">=", value: 2 }] }],
};

const stored = {
  type: "setup", id: "setup", label: "Start", description: "Define journey settings",
  triggerType: "user", triggerEventName: "view_product", filters: filters("product.price", 10), conditions: profile,
  next: check("yes_no", {
    type: "YesOrNoPath",
    yes: watch("success_timeout", {
      type: "SuccessOrTimeoutPath",
      success: end,
      timeout: {
        type: "engagement", id: "hook", label: "hook",
        action: { type: "webhook", title: "", body: "", subject: "", url: "https://example.com/hook", payload: "{}", templateId: "", method: "PUT" },
        next: end,
      },
    }),
    no: [
      check("yes_only", { type: "YesPath", yes: end }),
      check("no_only", { type: "NoPath", no: push("after_no") }),
      check("multi", {
        type: "MultiBranchPath",
        branches: [
          { branchKey: "vip", priority: 0, label: "VIP", filters: filters("order.total", 5000), conditions: behavior, next: end },
          { branchKey: "regular", priority: 1, label: "Regular", next: [push("regular_push"), end] },
        ],
      }),
      watch("success_only", { type: "SuccessPath", success: end }),
      watch("timeout_only", { type: "TimeoutPath", timeout: end }),
      {
        type: "watch", id: "delay", label: "delay", timeLimitValue: 1, timeLimitUnit: "days",
        description: "Wait a day", next: { type: "DelayPath", next: [push("after_delay"), end] },
      },
      { type: "segment", id: "segment", label: "segment", description: "Buyers", conditions: behavior, next: { type: "YesPath", yes: end } },
    ],
  }),
} as unknown as CampaignTreeNode;

const asSaved = (tree: CampaignTreeNode) => JSON.parse(JSON.stringify(tree));
const reload = (tree: CampaignTreeNode) => {
  const graph = treeToGraph(asSaved(tree));
  return graphToTree(graph.nodes, graph.connections);
};

describe("save and load", () => {
  it("gives back the same tree for every node and path type", () => {
    expect(asSaved(reload(stored))).toEqual(asSaved(stored));
  });

  it("gives back the same node rows", () => {
    expect(flattenCampaignTree("campaign-1", reload(stored))).toEqual(flattenCampaignTree("campaign-1", stored));
  });

  // JBD-KI-14: a check whose branches both end showed no outgoing edges after a reload.
  it("puts every End node on the canvas under the node_id it is saved with", () => {
    const savedEnds = flattenCampaignTree("campaign-1", stored)
      .filter((row) => row.node_type === "end")
      .map((row) => row.node_id);
    const graph = treeToGraph(asSaved(stored));
    const canvasEnds = graph.nodes.filter((node) => node.type === "end").map((node) => node.id);

    expect(canvasEnds.sort()).toEqual(savedEnds.sort());
    expect(graph.connections).toContainEqual({ from: "yes_only", to: "yes_only-yes-end", type: "required" });
    expect(graph.connections).toContainEqual({ from: "regular_push", to: "regular_push-next-end", type: "required" });
    expect(graph.connections).toContainEqual({ from: "multi", to: "multi-regular-1-end", type: "regular" });
  });

  it("shows the End node of a new journey", () => {
    const graph = treeToGraph({ type: "setup", id: "setup", label: "Setup", description: "", triggerEventName: "login_success", next: { type: "end" } });

    expect(graph.nodes.map((node) => [node.id, node.type])).toEqual([["setup", "setup"], ["setup-next-end", "end"]]);
    expect(graph.connections).toEqual([{ from: "setup", to: "setup-next-end", type: "required" }]);
  });

  it("loads a check that has neither a description nor a condition", () => {
    const tree = {
      type: "setup", id: "setup", label: "Start", description: "", triggerEventName: "view_product",
      next: { type: "check", id: "bare", label: "bare", next: { type: "YesPath", yes: end } },
    } as unknown as CampaignTreeNode;

    expect(treeToGraph(tree).nodes.map((node) => node.id)).toContain("bare");
  });
});
