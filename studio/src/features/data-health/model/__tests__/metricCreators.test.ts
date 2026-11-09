import { metricCreatorsQuery, parseMetricCreators } from "../metricCreators";

describe("metric creators", () => {
  it("reads the creator's email, and none for a metric whose creator is not known", () => {
    expect(parseMetricCreators([
      { id: "m_3f9c1a2b7d4e5f60", created_by: "lan@example.com", created_at: new Date("2026-10-20T03:00:00Z") },
      { id: "m_514afd5c430cce3b", created_by: null, created_at: null },
      { id: 7 },
    ])).toEqual([
      { metricId: "m_3f9c1a2b7d4e5f60", createdBy: "lan@example.com", createdAt: "2026-10-20T03:00:00.000Z" },
      { metricId: "m_514afd5c430cce3b", createdBy: null, createdAt: null },
    ]);
  });

  it("asks only for the named metrics", () => {
    expect(metricCreatorsQuery(["m_3f9c1a2b7d4e5f60"]).values).toEqual([["m_3f9c1a2b7d4e5f60"]]);
  });
});
