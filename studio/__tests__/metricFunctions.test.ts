/** @jest-environment node */

// The pure metric rules in shared/lib/metricDefinitions.ts, which publish uses.
import {
  activeMetricRetentions,
  behaviorConditionsIn,
  metricDisplayName,
  metricValueType,
  normalizeMetricFunction,
} from "shared/lib/metricDefinitions";

const DAY = 86_400_000;

const behavior = (metricId: string, measure: string, window: unknown = { value: 7, unit: "DAYS" }) => ({
  type: "behavior",
  event: "add_to_cart",
  measure,
  window,
  op: ">",
  value: 1,
  metric_id: metricId,
});
const groups = (...conditions: unknown[]) => ({ groups: [{ conditions }] });

describe("metric ids and names", () => {
  it("computes COUNT for a function the decision job does not know", () => {
    expect(normalizeMetricFunction(" sum ")).toBe("SUM");
    expect(normalizeMetricFunction("p99")).toBe("COUNT");
    expect(normalizeMetricFunction(null)).toBe("COUNT");
  });

  it("names a metric by its event, function, and attribute label", () => {
    expect(metricDisplayName("Add to cart", "SUM", "Price")).toBe("Add to cart — Sum of Price");
    expect(metricDisplayName("Add to cart", "count")).toBe("Add to cart — Times performed");
    expect(metricDisplayName("Add to cart", "LATEST")).toBe("Add to cart — Latest value");
  });

  it("stores a value typed by the attribute's catalog type", () => {
    expect(metricValueType(null, "number")).toBe("PRESENCE");
    expect(metricValueType("price", "Number")).toBe("NUMBER");
    expect(metricValueType("gift", "boolean")).toBe("BOOLEAN");
    expect(metricValueType("sku", undefined)).toBe("STRING");
  });
});

describe("metric references of campaign nodes", () => {
  const row = (campaignId: string, status: string, conditions: unknown, paths: unknown = null) => ({
    campaign_id: campaignId,
    node_id: "check-1",
    status,
    conditions_json: typeof conditions === "string" ? conditions : conditions === null ? null : JSON.stringify(conditions),
    paths_json: paths === null ? null : JSON.stringify(paths),
  });

  it("collects the behavior conditions of the node and of its branches, and no profile condition", () => {
    const conditions = {
      groups: [
        { conditions: [{ type: "profile_property", field: "city", op: "=", value: "Hanoi" }, behavior("m_a", "SUM")] },
      ],
    };
    const paths = { path_type: "MultiBranchPath", branches: [{ key: "vip", conditions: groups(behavior("m_b", "MAX")) }, { key: "regular" }] };

    expect(behaviorConditionsIn(conditions, paths).map((condition) => condition.metric_id)).toEqual(["m_a", "m_b"]);
  });

  it("keeps on only the metrics of active campaigns, each with its longest window, and skips a row whose JSON does not parse", () => {
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const retentions = activeMetricRetentions([
      row("c1", "active", groups(behavior("m_a", "SUM"))),
      row("c2", "active", null, {
        path_type: "MultiBranchPath",
        branches: [{ key: "vip", conditions: groups(behavior("m_a", "SUM", { value: 1, unit: "MONTHS" })) }],
      }),
      row("c3", "paused", groups(behavior("m_a", "SUM", { value: 90, unit: "DAYS" }), behavior("m_off", "SUM"))),
      row("c4", "active", groups(behavior("m_b", "COUNT", { value: 2, unit: "WEEKS" }), behavior("m_b", "COUNT", { value: 3, unit: "HOURS" }))),
      row("c5", "active", "{not json"),
    ]);

    expect(Object.fromEntries(retentions)).toEqual({ m_a: 30 * DAY, m_b: 14 * DAY });
  });

  it("keeps a metric on with no retention when no stored window of it is valid", () => {
    const retentions = activeMetricRetentions([row("c1", "active", groups(behavior("m_a", "COUNT", null)))]);

    expect(Object.fromEntries(retentions)).toEqual({ m_a: null });
  });
});
