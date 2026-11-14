import type { CampaignConnection, CampaignNode } from "@/entities/journey/model/types";
import { graphToTree, treeToGraph } from "@/entities/journey/model/utils";

const node = (id: string, type: CampaignNode["type"], subType: CampaignNode["subType"], config: CampaignNode["config"] = {}): CampaignNode =>
  ({ id, type, subType, label: id, config, position: { x: 0, y: 0 } }) as CampaignNode;

// JBD-KI-28, JBD-FR-02: a step with no child ends the journey with the same goal a drawn End gets,
// so the first save already matches every later save.
describe("an implicit End", () => {
  const nodes = [
    node("setup", "setup", "setup", { triggerEventName: "add_to_cart" }),
    node("push-1", "engagement", "push", { title: "Your cart", body: "Still there?" }),
  ];
  const connections: CampaignConnection[] = [{ from: "setup", to: "push-1", type: "yes" }];

  it("saves goal_default on the first save", () => {
    const tree = graphToTree(nodes, connections);
    expect(tree.next).toMatchObject({ next: { type: "end", goalId: "goal_default" } });
  });

  it("saves the same tree after a load", () => {
    const first = JSON.parse(JSON.stringify(graphToTree(nodes, connections)));
    const graph = treeToGraph(first);
    expect(JSON.parse(JSON.stringify(graphToTree(graph.nodes, graph.connections)))).toEqual(first);
  });
});
