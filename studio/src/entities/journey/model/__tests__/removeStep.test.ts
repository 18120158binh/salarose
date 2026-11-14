import { removeStep, stepsBelow, type JourneyGraph } from "@/entities/journey/model/graphEdits";
import { YES_EDGE, type CampaignNode } from "@/entities/journey/model/types";

const node = (id: string, type: CampaignNode["type"], config: CampaignNode["config"] = {}): CampaignNode =>
  ({ id, type, subType: type, label: id, config, position: { x: 0, y: 0 } }) as CampaignNode;

// The contract's JBD-FR-42 example: setup, check, Yes: Wait for time 1 day, SMS, End.
const graph: JourneyGraph = {
  nodes: [
    node("setup", "setup"),
    node("check", "check", { checkType: "YesPath" }),
    node("wait", "watch", { watchType: "DelayPath" }),
    node("sms", "engagement"),
    node("end", "end"),
  ],
  connections: [
    { from: "setup", to: "check", type: YES_EDGE },
    { from: "check", to: "wait", type: YES_EDGE },
    { from: "wait", to: "sms", type: YES_EDGE },
    { from: "sms", to: "end", type: YES_EDGE },
  ],
};

describe("removing a step (JBD-FR-42)", () => {
  it("moves the SMS up to the check's yes path when the wait goes", () => {
    const next = removeStep(graph, "wait")!;
    expect(next.connections.filter((c) => c.to === "sms")).toEqual([{ from: "check", to: "sms", type: YES_EDGE }]);
    const targets = next.connections.map((c) => c.to);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it("counts 3 steps below the check, and removing it leaves only the setup node", () => {
    expect(stepsBelow(graph, "check")).toBe(3);
    expect(removeStep(graph, "check")!.nodes.map((n) => n.id)).toEqual(["setup"]);
  });
});
