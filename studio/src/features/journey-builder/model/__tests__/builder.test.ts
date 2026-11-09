import { RUNTIME_REGISTRY } from "@/entities/journey/model/registry";
import { NO_EDGE, YES_EDGE } from "@/entities/journey/model/types";
import { builderReducer, graphFromRoot, initialState, rootOfGraph, type BuilderState } from "../builder";
import { cardText } from "../labels";
import { paletteEntries } from "../palette";
import { CART_ROOT, EVENTS } from "../__fixtures__/cart";

function start(): BuilderState {
  const graph = graphFromRoot(CART_ROOT);
  if (!graph) throw new Error("fixture does not load");
  return initialState({ id: "CAMP-1", name: "Abandoned cart", description: "", version: 3, graph, savedAt: 0 });
}

const entry = (key: string) => {
  const found = paletteEntries(RUNTIME_REGISTRY, "").find((e) => e.key === key);
  if (!found?.item) throw new Error(key);
  return found.item;
};

const eventName = (name: string | undefined) => EVENTS.find((e) => e.name === name)?.label ?? name ?? null;
const labels = (state: BuilderState) => state.graph.nodes.map((n) => cardText(n, eventName).label);
const parentOf = (state: BuilderState, id: string) => state.graph.connections.find((c) => c.to === id);

describe("the palette", () => {
  it("offers Push and SMS as the only channels, and no Zalo", () => {
    const messages = paletteEntries(RUNTIME_REGISTRY, "").filter((e) => e.group === "MESSAGES").map((e) => e.label);
    expect(messages).toEqual(["Push", "SMS"]);
  });

  it("narrows to the search text", () => {
    expect(paletteEntries(RUNTIME_REGISTRY, "wait").map((e) => e.label)).toEqual(["Wait for event", "Wait for time"]);
  });
});

describe("builderReducer", () => {
  it("adds a palette step at the end of the main path and selects it", () => {
    const state = builderReducer(start(), { type: "add", item: entry("sms"), at: null, stamp: 1 });
    expect(state.selected).toBe("node_1");
    expect(parentOf(state, "node_1")).toMatchObject({ from: "waitev", type: YES_EDGE });
    expect(state.revision).toBe(1);
  });

  it("inserts a palette step on the edge the marketer chose", () => {
    const state = builderReducer(start(), { type: "add", item: entry("wait-for-time"), at: { from: "push", to: "wait2" }, stamp: 2 });
    expect(parentOf(state, "node_2")?.from).toBe("push");
    expect(parentOf(state, "wait2")?.from).toBe("node_2");
  });

  it("gives Branch by event an End on each named branch", () => {
    const state = builderReducer(start(), { type: "add", item: entry("branch-by-event"), at: null, stamp: 3 });
    const branches = state.graph.connections.filter((c) => c.from === "node_3").map((c) => c.type);
    expect(branches).toEqual(["branch_0", "branch_1"]);
  });

  it("writes a panel edit into the saved draft", () => {
    const state = builderReducer(start(), {
      type: "configure",
      nodeId: "sms",
      config: { ...start().graph.nodes.find((n) => n.id === "sms")!.config, body: "Mua ngay nhé" },
      stamp: 4,
    });
    expect(JSON.stringify(rootOfGraph(state.graph))).toContain("Mua ngay nhé");
  });

  it("removes a one-path step alone and moves the step below it up (JBD-FR-42)", () => {
    const state = builderReducer(start(), { type: "remove", nodeId: "wait2" });
    expect(parentOf(state, "sms")).toMatchObject({ from: "push", type: YES_EDGE });
    expect(state.graph.nodes.some((n) => n.id === "wait2")).toBe(false);
  });

  it("removes a branching step with everything below it", () => {
    const state = builderReducer(start(), { type: "remove", nodeId: "waitev" });
    expect(state.graph.nodes.map((n) => n.type)).toEqual(["setup"]);
  });

  it("never removes the start step", () => {
    const before = start();
    expect(builderReducer(before, { type: "remove", nodeId: "start" })).toBe(before);
  });

  it("drops a removed branch when the path type changes", () => {
    const before = start();
    const watch = before.graph.nodes.find((n) => n.id === "waitev")!;
    const state = builderReducer(before, { type: "configure", nodeId: "waitev", config: { ...watch.config, watchType: "SuccessPath" }, stamp: 5 });
    expect(state.graph.connections.some((c) => c.from === "waitev" && c.type === NO_EDGE)).toBe(false);
    expect(state.graph.nodes.some((n) => n.id === "push")).toBe(false);
  });

  it("keeps the shared text when a push becomes an SMS", () => {
    const state = builderReducer(start(), { type: "channel", nodeId: "push", channel: "sms" });
    const node = state.graph.nodes.find((n) => n.id === "push")!;
    expect(node.subType).toBe("sms");
    expect(node.config.body).toBe("Sản phẩm bạn chọn vẫn đang chờ.");
    expect(node.config.title).toBeUndefined();
  });

  it("undoes and redoes an edit", () => {
    const edited = builderReducer(start(), { type: "rename", name: "Giỏ hàng" });
    const undone = builderReducer(edited, { type: "undo" });
    expect(undone.name).toBe("Abandoned cart");
    expect(builderReducer(undone, { type: "redo" }).name).toBe("Giỏ hàng");
  });

  it("labels the board's steps by type and setting (JBD-FR-22)", () => {
    expect(labels(start())).toEqual([
      "Start: Added to cart",
      "Wait for Order completed",
      "End",
      "Push “Bạn quên giỏ hàng?”",
      "Wait 1 day",
      "SMS",
      "End",
    ]);
  });

  describe("a version conflict", () => {
    const conflicted = () => {
      const edited = builderReducer(start(), { type: "rename", name: "Mine" });
      return builderReducer(edited, { type: "saveConflict", stored: { name: "Theirs", version: 9, graph: start().graph, savedAt: 1 } });
    };

    it("Load latest shows the stored draft and has nothing to save", () => {
      const state = builderReducer(conflicted(), { type: "loadLatest" });
      expect(state).toMatchObject({ name: "Theirs", version: 9, save: { kind: "saved" } });
      expect(state.revision).toBe(state.savedRevision);
    });

    it("Keep mine saves the open draft over the stored version", () => {
      const state = builderReducer(conflicted(), { type: "keepMine" });
      expect(state).toMatchObject({ name: "Mine", version: 9, save: { kind: "saved" } });
      expect(state.revision).not.toBe(state.savedRevision);
    });
  });
});
