import type { DatasetVersion } from "../domain";
import { describeVersion, matchRateOf, roleOf, saveLabel, summaryOf } from "../datasets";
import { inferType, parseCsv, suggestColumns, systemNameOf } from "../datasetsSample";
import { versionChange } from "../version";

const V1: DatasetVersion = {
  columns: [
    { name: "order_id", displayName: "Order ID", type: "string", pii: false, aliases: [] },
    { name: "customer_id", displayName: "Customer ID", type: "string", pii: false, aliases: [] },
    { name: "created_at", displayName: "Order time", type: "datetime", pii: false, aliases: [] },
    { name: "note", displayName: "Note", type: "string", pii: false, aliases: [] },
  ],
  roles: { customer_key: "customer_id", record_id: "order_id", event_time: "created_at" },
  deliveryMode: "incremental",
  timeZone: "Asia/Ho_Chi_Minh",
  delimiter: ",",
};

describe("describeVersion (the Versions card)", () => {
  it("counts the columns of the first version", () => {
    expect(describeVersion(null, V1)).toEqual(["Created with 4 columns"]);
  });

  it("names added, removed and aliased columns", () => {
    const next: DatasetVersion = {
      ...V1,
      columns: [
        ...V1.columns.slice(0, 3).map((column) => (column.name === "order_id" ? { ...column, aliases: ["ma_don"] } : column)),
        { name: "voucher_code", displayName: "Voucher code", type: "string", pii: false, aliases: [] },
      ],
    };
    expect(describeVersion(V1, next)).toEqual(["Order ID also accepts ma_don", "Added Voucher code, Text", "Removed Note, Text"]);
  });

  it("names a remapped role", () => {
    expect(describeVersion(V1, { ...V1, roles: { ...V1.roles, event_time: "note" } })).toContain("Event time changed");
  });
});

describe("saveLabel", () => {
  it("offers the next version for a change that needs one", () => {
    const next = { ...V1, columns: V1.columns.slice(0, 3) };
    expect(saveLabel(versionChange(V1, next), true, 3)).toBe("Save as version 4");
  });

  it("saves a display name change in place, and offers nothing without a change", () => {
    const renamed = { ...V1, columns: V1.columns.map((column) => ({ ...column, displayName: `${column.displayName}!` })) };
    expect(saveLabel(versionChange(V1, renamed), true, 3)).toBe("Save changes");
    expect(saveLabel(versionChange(V1, V1), false, 3)).toBeNull();
  });
});

describe("matchRateOf (DIM-FR-24)", () => {
  it("reads a share from the run's counts and nothing else", () => {
    expect(matchRateOf({ match_rate: 0.03 })).toBe(0.03);
    expect(matchRateOf({ match_rate: 3 })).toBeNull();
    expect(matchRateOf({})).toBeNull();
    expect(matchRateOf(null)).toBeNull();
  });
});

describe("summaryOf", () => {
  it("drops a row with an unknown kind", () => {
    expect(summaryOf({ id: "a", name: "x", display_name: "X", kind: "table", current_version: 1, delivery_mode: "snapshot" })).toBeNull();
  });

  it("reads the last run, or none", () => {
    const base = { id: "a", name: "orders", display_name: "Orders", kind: "event", current_version: 2, delivery_mode: "incremental" };
    expect(summaryOf(base)?.lastRun).toBeNull();
    const withRun = { ...base, run_state: "quarantined", run_source: "api", run_writer: "sk_1", run_created_at: new Date(0), run_counts: { match_rate: 0.5 } };
    expect(summaryOf(withRun)?.lastRun).toEqual({ state: "quarantined", source: "api", writer: "sk_1", at: 0, matchRate: 0.5 });
  });
});

describe("roleOf", () => {
  it("finds single and list roles", () => {
    expect(roleOf(V1.roles, "created_at")).toBe("event_time");
    expect(roleOf({ email: ["mail", "mail_2"] }, "mail_2")).toBe("email");
    expect(roleOf(V1.roles, "note")).toBeNull();
  });
});

describe("sample CSV suggestion", () => {
  it("parses quoted fields with the delimiter, quotes and newlines inside", () => {
    expect(parseCsv('a;b\r\n"x;1";"say ""hi""\nthere"\n', ";")).toEqual([
      ["a", "b"],
      ["x;1", 'say "hi"\nthere'],
    ]);
  });

  it("infers the narrowest type and falls back to text", () => {
    expect(inferType(["1", "2.5", ""])).toBe("number");
    expect(inferType(["true", "FALSE"])).toBe("boolean");
    expect(inferType(["2026-11-08", "2026-11-08T10:00:00+07:00"])).toBe("datetime");
    expect(inferType(['{"a":1}', "[1]"])).toBe("json");
    expect(inferType(["1", "1.290.000đ"])).toBe("string");
    expect(inferType(["", " "])).toBe("string");
  });

  it("turns headers into system names and keeps the header as an alias", () => {
    expect(systemNameOf("Mã đơn")).toBe("ma_don");
    expect(systemNameOf("2nd phone")).toBe("c_2nd_phone");
    const suggestion = suggestColumns("﻿Mã đơn,total,total\nDH-1,100,5\n", ",");
    expect(suggestion).toEqual({
      rows: 1,
      columns: [
        { name: "ma_don", displayName: "Mã đơn", type: "string", pii: false, aliases: ["Mã đơn"] },
        { name: "total", displayName: "Total", type: "number", pii: false, aliases: [] },
        { name: "total_2", displayName: "Total", type: "number", pii: false, aliases: ["total"] },
      ],
    });
  });

  it("refuses a file without a header", () => {
    expect(suggestColumns("", ",")).toEqual({ error: "The file has no header row." });
  });
});
