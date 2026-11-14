import { nodeCompletedQuery, parseNodeCompleted } from "../queries";

describe("node Completed counts (JBD-FR-09)", () => {
  it("reads campaign_node_stats for one campaign with no owner filter", () => {
    expect(nodeCompletedQuery("CAMP-1")).toEqual({
      text: "SELECT node_id, user_count FROM campaign_node_stats WHERE campaign_id = $1",
      values: ["CAMP-1"],
    });
  });

  it("parses bigint counts, which node-postgres returns as strings", () => {
    expect(parseNodeCompleted([{ node_id: "start", user_count: "12408" }, { node_id: "waitev-success-end", user_count: 3120 }])).toEqual({
      start: 12408,
      "waitev-success-end": 3120,
    });
  });
});
