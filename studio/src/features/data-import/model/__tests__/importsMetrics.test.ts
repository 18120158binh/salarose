import { parseRunCounts, passRetryQuery, runActionsOf, runTransitionQuery, stalenessOf, type MetricPass } from "../imports";
import { datasetMetricState, parseMetricInput, usedRefusal, type MetricDataset } from "../metrics";
import { parseCustomerKey, parseLogRow, shortCode } from "../privacyLog";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-08T10:00:00+07:00");

function pass(asOf: string, state: MetricPass["state"], reason: string | null = null): MetricPass {
  const at = Date.parse(asOf);
  return { id: `p-${asOf}`, asOf: at, state, reason, retryRequestedAt: null, changedRows: 0, walBytes: 0, pauseCount: 0, startedAt: at, finishedAt: at + 1000 };
}

describe("stalenessOf (DIM-FR-20)", () => {
  it("names the values' date and the reason when the last two passes stopped", () => {
    const passes = [
      pass("2026-11-08T03:00:00+07:00", "failed", "timed_out:disk_reading"),
      pass("2026-11-07T03:00:00+07:00", "failed", "timed_out:disk_reading"),
      pass("2026-11-06T03:00:00+07:00", "done"),
    ];
    const staleness = stalenessOf(passes, passes[2], NOW);
    expect(staleness).toMatchObject({ stale: true, valuesAsOf: passes[2].asOf, ageDays: 2 });
    if (!staleness.stale) throw new Error("expected stale");
    expect(staleness.stopped.map((entry) => entry.reason)).toEqual(["timed_out:disk_reading", "timed_out:disk_reading"]);
    expect(staleness.retry).toBe(passes[0]);
  });

  it("is fresh when the last done pass is under a day old", () => {
    const done = pass("2026-11-08T03:00:00+07:00", "done");
    expect(stalenessOf([done], done, NOW)).toEqual({ stale: false });
  });

  it("is fresh before any pass has run, and stale when the only passes stopped", () => {
    expect(stalenessOf([], null, NOW)).toEqual({ stale: false });
    expect(stalenessOf([pass("2026-11-08T03:00:00+07:00", "failed", "x")], null, NOW)).toMatchObject({ stale: true, valuesAsOf: null });
  });

  it("counts a done pass a day and a minute old as stale", () => {
    const done = { ...pass("2026-11-07T03:00:00+07:00", "done"), asOf: NOW - DAY - 60_000 };
    expect(stalenessOf([done], done, NOW).stale).toBe(true);
  });
});

describe("run transitions (import applier, Run states)", () => {
  it("offers approve and discard on a held file, discard only on a held re-derive, retry on a failed one", () => {
    expect(runActionsOf({ state: "quarantined", source: "api" })).toEqual({ approve: true, discard: true, retry: false });
    expect(runActionsOf({ state: "quarantined", source: "rederive" })).toEqual({ approve: false, discard: true, retry: false });
    expect(runActionsOf({ state: "failed", source: "drop" })).toEqual({ approve: false, discard: false, retry: true });
    expect(runActionsOf({ state: "applied", source: "api" })).toEqual({ approve: false, discard: false, retry: false });
  });

  it("updates only from the state the transition leaves, and approve stamps the admin", () => {
    const approve = runTransitionQuery("approve", "run-1", "admin-1");
    expect(approve.text).toContain("WHERE id = $1 AND state = $3");
    expect(approve.values).toEqual(["run-1", "approved", "quarantined", "admin-1"]);
    expect(runTransitionQuery("retry", "run-1", "admin-1").values).toEqual(["run-1", "queued", "failed"]);
  });

  it("stamps retry_requested_at and nothing else on a pass retry", () => {
    const { text } = passRetryQuery("p-1");
    expect(text).toMatch(/SET retry_requested_at = now\(\)\s+WHERE/);
    expect(text).toContain("state = 'failed'");
  });

  it("reads counts the run lacks as null, never 0", () => {
    expect(parseRunCounts({})).toMatchObject({ rowsRead: null, rejected: null, matchRate: null });
    expect(parseRunCounts({ rows_read: 48210, rejected: 2893, match_rate: 0.71, rejected_by_reason: { empty_key: 2410, bad_date: 371 } })).toMatchObject({
      rowsRead: 48210,
      rejected: 2893,
      matchRate: 0.71,
      rejectedByReason: [{ reason: "empty_key", count: 2410 }, { reason: "bad_date", count: 371 }],
    });
  });
});

const ORDERS: MetricDataset = {
  id: "5f0c8a2e-1b7d-4c39-9a51-2d3e4f5a6b7c",
  name: "orders",
  displayName: "Orders",
  eventTimeColumn: "created_at",
  columns: [
    { name: "total", displayName: "Order total", type: "number", pii: false, aliases: [] },
    { name: "status", displayName: "Status", type: "string", pii: false, aliases: [] },
  ],
};

describe("parseMetricInput (DIM-FR-17)", () => {
  const base = { name: "spend_90d", displayName: "Spend, last 90 days", windowDays: 90, filters: [] };

  it("saves SUM of a number column", () => {
    const result = parseMetricInput({ ...base, function: "SUM", column: "total", filters: [{ column: "status", op: "=", value: "completed" }] }, ORDERS);
    expect(result).toEqual({
      ok: true,
      value: {
        recordTypeId: ORDERS.id,
        name: "spend_90d",
        displayName: "Spend, last 90 days",
        function: "SUM",
        column: "total",
        filters: [{ column: "status", op: "=", value: "completed" }],
        windowDays: 90,
      },
    });
  });

  it("refuses SUM of a text column", () => {
    const result = parseMetricInput({ ...base, function: "SUM", column: "status" }, ORDERS);
    expect(result).toEqual({ ok: false, problems: ["Status is Text. Sum needs a number."] });
  });

  it("refuses a column on COUNT, a bad name, and a window of 0", () => {
    const result = parseMetricInput({ ...base, name: "Spend 90", function: "COUNT", column: "total", windowDays: 0 }, ORDERS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toHaveLength(3);
  });

  it("takes no window as all time", () => {
    const result = parseMetricInput({ ...base, function: "LAST_TIME", column: null, windowDays: null }, ORDERS);
    expect(result).toMatchObject({ ok: true, value: { column: null, windowDays: null } });
  });
});

describe("metric state and refusals (DIM-FR-18, CMP-FR-23)", () => {
  it("is archived, then not updating when the last done pass is old or missing, else live", () => {
    expect(datasetMetricState(NOW, NOW, NOW)).toBe("archived");
    expect(datasetMetricState(null, null, NOW)).toBe("not_updating");
    expect(datasetMetricState(null, NOW - 2 * DAY, NOW)).toBe("not_updating");
    expect(datasetMetricState(null, NOW - 3_600_000, NOW)).toBe("live");
  });

  it("names each use in a refusal", () => {
    expect(usedRefusal("archived", [{ kind: "segment", id: "SEG-1", name: "Big spenders" }, { kind: "journey", id: "C1", name: "Win back" }])).toBe(
      "This metric can't be archived while something uses it: segment Big spenders, journey Win back.",
    );
  });
});

describe("privacy reads (DIM-FR-22, DIM-FR-28)", () => {
  it("hides a deleted person's reveal row and shows a deletion request only by its code", () => {
    const hash = "a".repeat(60) + "b123";
    const reveal = parseLogRow({ id: "1", at: new Date(NOW), action: "reveal", customer_key: null, customer_key_hash: hash, fields: ["customers.phone"], route: "/customers" });
    expect(reveal?.subject).toEqual({ kind: "hidden", code: null });
    const request = parseLogRow({ id: "2", at: new Date(NOW), action: "deletion_request", customer_key_hash: hash, fields: [], route: "/data/privacy" });
    expect(request?.subject).toEqual({ kind: "hidden", code: shortCode(hash) });
    expect(shortCode(hash)).toBe("aaaa…123");
  });

  it("keeps a customer key exactly as typed, and refuses an empty one", () => {
    expect(parseCustomerKey(" KH1 ")).toBe(" KH1 ");
    expect(parseCustomerKey("   ")).toBeNull();
    expect(parseCustomerKey(42)).toBeNull();
  });
});
