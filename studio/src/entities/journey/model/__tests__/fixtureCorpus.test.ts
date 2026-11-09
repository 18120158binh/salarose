import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { validateJourney } from "@/entities/journey/model/parseCampaign";
import { RUNTIME_REGISTRY } from "@/entities/journey/model/registry";
import type { CampaignTreeNode } from "@/entities/journey/model/types";
import { flattenCampaignTree, graphToTree, treeToGraph } from "@/entities/journey/model/utils";

// Each file is one saved root: the classic builder's test trees, and published roots exported
// from the cluster.
const CORPUS = path.join(__dirname, "..", "__fixtures__", "journeys");
const corpus = existsSync(CORPUS)
  ? readdirSync(CORPUS)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({ name: file.replace(/\.json$/, ""), saved: JSON.parse(readFileSync(path.join(CORPUS, file), "utf8")) as CampaignTreeNode }))
  : [];

const asSaved = (tree: CampaignTreeNode) => JSON.parse(JSON.stringify(tree));
const reload = (tree: CampaignTreeNode) => {
  const graph = treeToGraph(asSaved(tree));
  return graphToTree(graph.nodes, graph.connections);
};

// JBD-FR-02: loading a saved journey gives back the same canvas, so saving it again gives back the
// same tree and the same node rows.
describe("the journey fixture corpus", () => {
  it("holds the classic tree with every node type and path type", () => {
    expect(corpus.map(({ name }) => name)).toContain("classic-every-node-and-path");
  });

  for (const { name, saved } of corpus) {
    describe(name, () => {
      const { root, problems } = validateJourney(saved, RUNTIME_REGISTRY);

      it("loads with no shape problem", () => {
        expect(problems.filter((found) => found.rule === "shape")).toEqual([]);
        expect(root).toBeDefined();
      });

      it("saves the same tree it loaded", () => {
        expect(asSaved(reload(root as CampaignTreeNode))).toEqual(asSaved(saved));
      });

      it("saves the same node rows", () => {
        expect(flattenCampaignTree("campaign-1", reload(root as CampaignTreeNode))).toEqual(flattenCampaignTree("campaign-1", saved));
      });
    });
  }
});
