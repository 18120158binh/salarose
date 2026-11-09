import { LAYOUT, alignNodes, flattenCampaignTree, getBranchOptions, graphToTree, treeToGraph } from "@/entities/journey/model/utils";
import { CampaignNode, CampaignConnection, CampaignTreeNode } from "@/entities/journey/model/types";

describe("alignNodes Layout Algorithm", () => {
  it("should correctly position multi-branch nodes vertically without looping backwards", () => {
    // Setup a parent Check node with 3 branches, all pointing to End nodes
    const placed = (id: string, type: CampaignNode["type"]): CampaignNode =>
      ({ id, type, subType: type === "end" ? "custom-list" : type, label: id, config: {}, position: { x: 0, y: 0 } }) as CampaignNode;
    const nodes: CampaignNode[] = [
      placed("setup-node", "setup"),
      placed("check-node", "check"),
      placed("end-A", "end"),
      placed("end-B", "end"),
      placed("end-C", "end"),
    ];

    const connections: CampaignConnection[] = [
      { from: "setup-node", to: "check-node", type: "required" },
      { from: "check-node", to: "end-A", type: "branch_0" },
      { from: "check-node", to: "end-B", type: "branch_1" },
      { from: "check-node", to: "end-C", type: "branch_2" },
    ];

    const alignedNodes = alignNodes(nodes, connections);

    const setupNode = alignedNodes.find(n => n.id === "setup-node")!;
    const checkNode = alignedNodes.find(n => n.id === "check-node")!;
    const endA = alignedNodes.find(n => n.id === "end-A")!;
    const endB = alignedNodes.find(n => n.id === "end-B")!;
    const endC = alignedNodes.find(n => n.id === "end-C")!;

    // Each level sits one column to the right of its parent.
    expect(checkNode.position.x).toBe(setupNode.position.x + LAYOUT.stepX);

    // All End nodes are one column to the right of the check, not orphans at the left edge.
    expect(endA.position.x).toBe(checkNode.position.x + LAYOUT.stepX);
    expect(endB.position.x).toBe(checkNode.position.x + LAYOUT.stepX);
    expect(endC.position.x).toBe(checkNode.position.x + LAYOUT.stepX);

    // Each branch gets its own lane, in branch order.
    expect(endB.position.y - endA.position.y).toBe(LAYOUT.laneHeight);
    expect(endC.position.y - endB.position.y).toBe(LAYOUT.laneHeight);
    expect(endB.position.y).toBe(checkNode.position.y); // The middle branch should be aligned horizontally with the parent
  });
});

// The runtime matches these parent_branch values against the branches it emits.
// See the branch table in docs/internal/features/journey-builder.md#saved-format.
describe("flattenCampaignTree parent_branch", () => {
  const end = (id: string) => ({ type: "end", id });
  const tree = {
    type: "setup", id: "setup", triggerEventName: "view_product",
    next: {
      type: "check", id: "check", eventName: "add_to_cart",
      next: {
        type: "YesOrNoPath",
        yes: {
          type: "watch", id: "watch", eventName: "purchase", timeLimitValue: 15, timeLimitUnit: "minutes",
          next: {
            type: "SuccessOrTimeoutPath",
            success: end("watch-success"),
            timeout: { type: "engagement", id: "sms", action: { channel: "sms" }, next: end("sms-next") },
          },
        },
        no: {
          type: "check", id: "multi", eventName: "purchase",
          next: {
            type: "MultiBranchPath",
            branches: [{ branchKey: "branch_0", priority: 0, next: end("multi-branch-0") }],
          },
        },
      },
    },
  } as unknown as CampaignTreeNode;

  it("saves each child under the branch its parent completes on", () => {
    const saved = flattenCampaignTree("campaign-1", tree).map(row => [row.node_id, row.parent_node_id, row.parent_branch]);

    expect(saved).toEqual([
      ["setup", null, null],
      ["check", "setup", "next"],
      ["watch", "check", "yes"],
      ["watch-success", "watch", "success"],
      ["sms", "watch", "timeout"],
      ["sms-next", "sms", "next"],
      ["multi", "check", "no"],
      ["multi-branch-0", "multi", "branch_0"],
    ]);
  });

  it("saves the child of a delay watch under next", () => {
    const delay = {
      type: "watch", id: "delay", timeLimitValue: 1, timeLimitUnit: "days",
      next: { type: "DelayPath", next: end("after-delay") },
    } as unknown as CampaignTreeNode;

    const saved = flattenCampaignTree("campaign-1", delay).map(row => [row.node_id, row.parent_branch]);

    expect(saved).toEqual([["delay", null], ["after-delay", "next"]]);
  });
});

// The rule columns of each node row, in the saved format of
// docs/internal/features/journey-builder.md#saved-format.
const json = (text: string | null) => (text === null ? null : JSON.parse(text));
const rowOf = (root: CampaignTreeNode, id: string) => flattenCampaignTree("campaign-1", root).find(r => r.node_id === id)!;
const saved = (tree: unknown) => JSON.parse(JSON.stringify(tree)) as CampaignTreeNode;
const canvasNode = (id: string, type: CampaignNode["type"], config: Record<string, unknown>, subType: string = type) =>
  ({ id, type, subType, label: id, config, position: { x: 0, y: 0 } }) as CampaignNode;

describe("condition split rows", () => {
  // "purchase COUNT >= 2 in the last 30 days", as the condition split editor sets it.
  const purchasedTwice = {
    groups: [{
      conditions: [{ type: "behavior", event: "purchase", measure: "COUNT", window: { value: 30, unit: "DAYS" }, op: ">=", value: 2 }],
    }],
  };
  const nodes = [
    canvasNode("setup-1", "setup", { triggerEventName: "view_product" }),
    canvasNode("segment-1", "segment", { conditions: purchasedTwice, checkType: "YesPath", description: "Buyers" }),
    canvasNode("push-1", "engagement", { title: "Thanks", body: "Here is a coupon" }, "push"),
  ];
  const connections: CampaignConnection[] = [
    { from: "setup-1", to: "segment-1", type: "required" },
    { from: "segment-1", to: "push-1", type: "required" },
  ];
  const tree = () => saved(graphToTree(nodes, connections));

  // JBD-FR-02, JBD-FR-14
  it("keeps the event, measure, window, operator, and value through save and load", () => {
    const reloaded = treeToGraph(tree());

    expect(reloaded.nodes.find(node => node.id === "segment-1")?.config).toEqual(
      expect.objectContaining({ conditions: purchasedTwice, checkType: "YesPath" }),
    );
    expect(reloaded.connections).toContainEqual({ from: "segment-1", to: "push-1", type: "required" });
  });

  // JBD-FR-03, JBD-FR-14
  it("saves its condition in conditions_json and no trigger_json", () => {
    const row = rowOf(tree(), "segment-1");

    expect(row.trigger_json).toBeNull();
    expect(json(row.conditions_json)).toEqual(purchasedTwice);
    expect(row.paths_json).toBeNull();
  });
});

describe("trigger_json and conditions_json", () => {
  const price = { type: "event_property", field: "product.price", op: ">", value: 500000 };
  const brand = { type: "event_property", field: "product.brand", op: "=", value: "Auroracy" };
  const city = { type: "profile_property", field: "city", op: "IN", value: ["Hanoi", "Ho Chi Minh City"] };
  const addedThrice = { type: "behavior", event: "add_to_cart", measure: "COUNT", window: { value: 7, unit: "DAYS" }, op: ">=", value: 3 };

  // JBD-FR-05, JBD-FR-13
  it("saves a setup node's filters ORed in one group under its trigger event", () => {
    const setup = saved({
      type: "setup", id: "setup", label: "Start", description: "", triggerEventName: "view_product",
      filters: { groups: [{ conditions: [price, brand] }] },
      next: { type: "end" },
    });
    const row = rowOf(setup, "setup");

    expect(json(row.trigger_json)).toEqual({
      kind: "event",
      event: "view_product",
      filters: { groups: [{ conditions: [price, brand] }] },
    });
    expect(row.conditions_json).toBeNull();
    expect(row.paths_json).toBeNull();
  });

  // JBD-FR-13
  it("saves a check's profile and behavior conditions as two groups", () => {
    const setup = saved({
      type: "setup", id: "setup", label: "Start", description: "", triggerEventName: "view_product",
      next: {
        type: "check", id: "check", label: "check", eventName: "add_to_cart",
        filters: { groups: [{ conditions: [price] }] },
        conditions: { groups: [{ conditions: [city] }, { conditions: [addedThrice] }] },
        next: { type: "YesPath", yes: { type: "end" } },
      },
    });
    const row = rowOf(setup, "check");

    expect(json(row.trigger_json)).toEqual({ kind: "event", event: "add_to_cart", filters: { groups: [{ conditions: [price] }] } });
    expect(json(row.conditions_json)).toEqual({ groups: [{ conditions: [city] }, { conditions: [addedThrice] }] });
    expect(row.paths_json).toBeNull();
  });

  it("saves a catalog default row as a plain filter", () => {
    const setup = saved({
      type: "setup", id: "setup", label: "Start", description: "", triggerEventName: "view_product",
      filters: { groups: [{ conditions: [{ type: "event_property", field: "product.category", op: "=", value: "phones", isDefault: true }] }] },
      next: { type: "end" },
    });

    expect(json(rowOf(setup, "setup").trigger_json).filters).toEqual({
      groups: [{ conditions: [{ type: "event_property", field: "product.category", op: "=", value: "phones" }] }],
    });
  });

  it("saves the trigger event alone when the node has no filters", () => {
    const setup = saved({ type: "setup", id: "setup", label: "Start", description: "", triggerEventName: "view_product", next: { type: "end" } });

    expect(json(rowOf(setup, "setup").trigger_json)).toEqual({ kind: "event", event: "view_product" });
  });

  // JBD-FR-02, JBD-FR-03
  it("saves contains as LIKE with the text between %", () => {
    const setup = saved({
      type: "setup", id: "setup", label: "Start", description: "", triggerEventName: "view_product",
      filters: { groups: [{ conditions: [{ type: "event_property", field: "product.name", op: "LIKE", value: "%iphone%" }] }] },
      next: { type: "end" },
    });

    expect(json(rowOf(setup, "setup").trigger_json).filters.groups[0].conditions[0]).toEqual(
      { type: "event_property", field: "product.name", op: "LIKE", value: "%iphone%" },
    );
  });
});

describe("paths_json", () => {
  const vipFilters = { groups: [{ conditions: [{ type: "event_property", field: "order.total", op: ">", value: 1000 }] }] };

  // JBD-FR-03
  it("saves a multi-branch check's branches, and vip's filters", () => {
    const setup = saved({
      type: "setup", id: "setup", label: "Start", description: "", triggerEventName: "view_product",
      next: {
        type: "check", id: "multi", label: "multi", eventName: "purchase",
        next: {
          type: "MultiBranchPath",
          branches: [
            { branchKey: "vip", priority: 0, filters: vipFilters, next: { type: "end" } },
            { branchKey: "regular", priority: 1, next: { type: "end" } },
          ],
        },
      },
    });
    const rows = flattenCampaignTree("campaign-1", setup);
    const row = rows.find(r => r.node_id === "multi")!;

    expect(json(row.paths_json)).toEqual({
      path_type: "MultiBranchPath",
      branches: [{ key: "vip", filters: vipFilters }, { key: "regular" }],
    });
    expect(json(row.trigger_json)).toEqual({ kind: "event", event: "purchase" });
    expect(rows.filter(r => r.parent_node_id === "multi").map(r => r.parent_branch)).toEqual(["vip", "regular"]);
  });

  // JBD-FR-04
  it("saves a watch's limit in upper case, and its children under success and timeout", () => {
    const setup = saved({
      type: "setup", id: "setup", label: "Start", description: "", triggerEventName: "view_product",
      next: {
        type: "watch", id: "watch", label: "watch", eventName: "purchase", timeLimitValue: 1, timeLimitUnit: "days",
        next: { type: "SuccessOrTimeoutPath", success: { type: "end" }, timeout: { type: "end" } },
      },
    });
    const rows = flattenCampaignTree("campaign-1", setup);
    const row = rows.find(r => r.node_id === "watch")!;

    expect(json(row.paths_json)).toEqual({ path_type: "SuccessOrTimeoutPath", limit: { value: 1, unit: "DAYS" } });
    expect(json(row.trigger_json)).toEqual({ kind: "event", event: "purchase" });
    expect(rows.filter(r => r.parent_node_id === "watch").map(r => r.parent_branch)).toEqual(["success", "timeout"]);
  });

  it("saves a delay with its limit and no trigger", () => {
    const delay = saved({
      type: "watch", id: "delay", label: "delay", timeLimitValue: 15, timeLimitUnit: "minutes",
      next: { type: "DelayPath", next: { type: "end" } },
    });
    const row = rowOf(delay, "delay");

    expect(row.trigger_json).toBeNull();
    expect(row.conditions_json).toBeNull();
    expect(json(row.paths_json)).toEqual({ path_type: "DelayPath", limit: { value: 15, unit: "MINUTES" } });
  });

  it("saves no rule for an engagement or an end node", () => {
    const setup = saved({
      type: "setup", id: "setup", label: "Start", description: "", triggerEventName: "view_product",
      next: { type: "engagement", id: "push", label: "push", action: { type: "push" }, next: { type: "end" } },
    });
    for (const row of flattenCampaignTree("campaign-1", setup).filter(r => r.node_type !== "setup")) {
      expect([row.trigger_json, row.conditions_json, row.paths_json]).toEqual([null, null, null]);
    }
  });
});

// Older builds saved a fixed phone on SMS and WhatsApp steps, and the outbox never sent it.
// A draft or stored journey that has one opens without it and saves without it.
describe("engagement phone from older builds", () => {
  const stored = {
    type: "setup", id: "setup", label: "Start", description: "", triggerEventName: "add_to_cart",
    next: { type: "engagement", id: "sms-1", label: "SMS", action: { type: "sms", body: "Come back", phone: "0912345678" }, next: { type: "end" } },
  } as unknown as CampaignTreeNode;

  it("opens the step without the phone", () => {
    const sms = treeToGraph(stored).nodes.find(n => n.id === "sms-1")!;
    expect(sms.config).not.toHaveProperty("phone");
  });

  it("saves the step's action without the phone", () => {
    const graph = treeToGraph(stored);
    const row = flattenCampaignTree("campaign-1", graphToTree(graph.nodes, graph.connections)).find(r => r.node_id === "sms-1")!;
    expect(JSON.parse(row.action_json!)).not.toHaveProperty("phone");
  });
});

// A segment fires only yes, so the builder offers only its Yes path. A segment saved by an older
// build with a No path keeps it, so that opening the journey loses nothing.
describe("segment paths", () => {
  const metric = { groups: [{ conditions: [{ type: "behavior", event: "purchase", measure: "COUNT", op: ">=", value: 2 }] }] };
  const segment = (checkType: string) => ({
    id: "segment-1", type: "segment", subType: "segment", label: "Buyers",
    config: { conditions: metric, checkType }, position: { x: 0, y: 0 },
  }) as CampaignNode;

  it.each(["YesPath", "YesOrNoPath", "NoPath", undefined])("offers only Yes for a segment with path type %p", (checkType) => {
    expect(getBranchOptions(segment(checkType as string)).map(o => o.label)).toEqual(["Yes"]);
  });

  const push = (id: string) => ({ type: "engagement", id, label: id, action: { type: "push", title: "Hi" }, next: { type: "end" } });
  const storedWith = (next: unknown) => ({
    type: "setup", id: "setup", label: "Start", description: "", triggerEventName: "add_to_cart",
    next: { type: "segment", id: "segment-1", label: "Buyers", conditions: metric, next },
  }) as unknown as CampaignTreeNode;
  const resaved = (tree: CampaignTreeNode, edit: (g: ReturnType<typeof treeToGraph>) => void = () => {}) => {
    const graph = treeToGraph(tree);
    edit(graph);
    return flattenCampaignTree("campaign-1", graphToTree(graph.nodes, graph.connections))
      .filter(r => r.parent_node_id === "segment-1")
      .map(r => [r.node_id, r.parent_branch]);
  };

  it("keeps the No path of a segment saved by an older build", () => {
    expect(resaved(storedWith({ type: "YesOrNoPath", yes: push("yes-push"), no: push("no-push") }))).toEqual([
      ["yes-push", "yes"],
      ["no-push", "no"],
    ]);
  });

  // The builder offers Yes for a No Only segment, so a node added on Yes must be saved.
  it("saves a node added on Yes to a No Only segment from an older build", () => {
    const tree = storedWith({ type: "NoPath", no: push("no-push") });
    expect(resaved(tree, (g) => {
      g.nodes.push({ id: "yes-push", type: "engagement", subType: "push", label: "Yes", config: {}, position: { x: 0, y: 0 } } as CampaignNode);
      g.connections.push({ from: "segment-1", to: "yes-push", type: "required" });
    })).toEqual([
      ["yes-push", "yes"],
      ["no-push", "no"],
    ]);
  });
});
