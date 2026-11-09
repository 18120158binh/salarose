/** @jest-environment node */
import { createHmac } from "node:crypto";
import type { DatasetVersion } from "../domain";
import { maskPii, piiAccessInsert, piiKindOf, readTombstoneKey, tombstoneOf } from "../privacy";
import { fieldUses, namesProfileField } from "../uses";
import { isSystemName, parseDatasetVersion, versionChange } from "../version";

const ORDERS = {
  columns: [
    { name: "order_id", displayName: "Order id", type: "string", pii: false, aliases: [] },
    { name: "customer_id", displayName: "Customer", type: "string", pii: false, aliases: ["Customer ID"] },
    { name: "created_at", displayName: "Created", type: "datetime", pii: false, aliases: [] },
    { name: "total", displayName: "Total", type: "number", pii: false, aliases: [] },
  ],
  roles: { customer_key: "customer_id", record_id: "order_id", event_time: "created_at" },
  deliveryMode: "incremental",
  timeZone: "Asia/Ho_Chi_Minh",
  delimiter: ",",
};

function problemsOf(kind: "profile" | "event", input: unknown): string[] {
  const result = parseDatasetVersion(kind, input);
  return result.ok ? [] : result.problems;
}

describe("system names", () => {
  it.each(["orders", "order_lines", "spend_90d", "a"])("accepts %s", (name) => {
    expect(isSystemName(name)).toBe(true);
  });
  it.each(["Orders", "1orders", "_orders", "orders.total", "com.acme/orders", "order-lines", ""])("refuses %s", (name) => {
    expect(isSystemName(name)).toBe(false);
  });
});

describe("version validation", () => {
  it("accepts an event dataset that maps its three required roles", () => {
    expect(parseDatasetVersion("event", ORDERS)).toEqual({ ok: true, value: ORDERS });
  });

  it("names each required role an event dataset leaves unmapped", () => {
    const problems = problemsOf("event", { ...ORDERS, roles: { customer_key: "customer_id" } });
    expect(problems).toEqual(["Map Record id to a column.", "Map Event time to a column."]);
  });

  it("refuses a role the kind does not have", () => {
    expect(problemsOf("profile", ORDERS)).toEqual(["A profile dataset has no Record id.", "A profile dataset has no Event time."]);
    expect(problemsOf("event", { ...ORDERS, roles: { ...ORDERS.roles, email: ["customer_id"] } })).toEqual([
      "A event dataset has no Email.",
    ]);
  });

  it("refuses a deleted flag on a column that is not boolean", () => {
    const problems = problemsOf("event", { ...ORDERS, roles: { ...ORDERS.roles, deleted_flag: "total" } });
    expect(problems).toEqual(["Deleted flag must map to a boolean column."]);
  });

  it("refuses a role that names a missing column", () => {
    const problems = problemsOf("event", { ...ORDERS, roles: { ...ORDERS.roles, event_time: "paid_at" } });
    expect(problems).toEqual(["Event time maps to a column that does not exist."]);
  });

  it("refuses a column name outside the rule, a type outside the five, and a header two columns share", () => {
    const columns = [
      ...ORDERS.columns,
      { name: "Order.Status", displayName: "Status", type: "string", aliases: [] },
      { name: "channel", displayName: "Channel", type: "text", aliases: [] },
      { name: "note", displayName: "Note", type: "string", aliases: ["Customer ID"] },
    ];
    const problems = problemsOf("event", { ...ORDERS, columns });
    expect(problems).toEqual([
      expect.stringContaining('Column "Order.Status"'),
      expect.stringContaining('Column "channel" needs a type'),
      'The header "Customer ID" matches both "customer_id" and "note".',
    ]);
  });

  it("allows several email and phone columns on a profile dataset and flags them PII", () => {
    const result = parseDatasetVersion("profile", {
      columns: [
        { name: "customer_id", displayName: "Customer", type: "string", aliases: [] },
        { name: "email", displayName: "Email", type: "string", aliases: [] },
        { name: "work_email", displayName: "Work email", type: "string", aliases: [] },
      ],
      roles: { customer_key: "customer_id", email: ["email", "work_email"] },
      deliveryMode: "snapshot",
      timeZone: "Asia/Ho_Chi_Minh",
      delimiter: ";",
    });
    expect(result.ok && result.value.columns.map((column) => column.pii)).toEqual([false, true, true]);
  });

  it("refuses an unknown time zone, delivery mode, and delimiter", () => {
    const problems = problemsOf("event", { ...ORDERS, deliveryMode: "full", timeZone: "Mars/Base", delimiter: "|" });
    expect(problems).toHaveLength(3);
  });
});

describe("version change", () => {
  const current = parseDatasetVersion("event", ORDERS);
  const base = (current.ok ? current.value : null) as DatasetVersion;

  it("saves a display name or PII change without a new version", () => {
    const next = { ...base, columns: base.columns.map((c) => (c.name === "total" ? { ...c, displayName: "Sum", pii: true } : c)) };
    expect(versionChange(base, next)).toEqual({ breakingColumns: [], rederives: false, newVersion: false });
  });

  it("calls a retyped or deleted column breaking", () => {
    const columns = base.columns
      .filter((c) => c.name !== "total")
      .map((c) => (c.name === "order_id" ? { ...c, type: "number" as const } : c));
    const next = { ...base, columns };
    expect(versionChange(base, next).breakingColumns.sort()).toEqual(["order_id", "total"]);
  });

  it("re-derives when a role, the delivery mode, or the time zone changes", () => {
    expect(versionChange(base, { ...base, timeZone: "UTC" }).rederives).toBe(true);
    expect(versionChange(base, { ...base, roles: { ...base.roles, updated_at: "created_at" } })).toMatchObject({
      rederives: true,
      newVersion: true,
    });
  });
});

describe("PII masking", () => {
  it.each([
    ["email", "nguyen.lan@gmail.com", "n***@gmail.com"],
    ["email", "not-an-email", "***"],
    ["phone", "+84901234678", "+84 *** *** 678"],
    ["phone", "+1 415 555 0178", "+1 *** *** 178"],
    ["phone", "+855 12 345 678", "+855 *** *** 678"],
    ["phone", "0901234678", "*** *** 678"],
    ["phone", "+8412", "***"],
    ["other", "12 Lý Thường Kiệt", "***"],
  ] as const)("masks a %s value %s as %s", (kind, value, masked) => {
    expect(maskPii(kind, value)).toBe(masked);
  });

  it("leaves a missing value missing", () => {
    expect(maskPii("email", null)).toBeNull();
  });

  it("masks a column by its role or its flag", () => {
    const version = {
      ...(ORDERS as DatasetVersion),
      columns: [...(ORDERS as DatasetVersion).columns, { name: "address", displayName: "Address", type: "string" as const, pii: true, aliases: [] }],
      roles: { customer_key: "customer_id", phone: ["customer_id"] },
    };
    expect(piiKindOf(version, "customer_id")).toBe("phone");
    expect(piiKindOf(version, "address")).toBe("other");
    expect(piiKindOf(version, "total")).toBeNull();
  });
});

describe("access log rows", () => {
  const columns = (entry: Parameters<typeof piiAccessInsert>[0]) => piiAccessInsert(entry).values;

  it("holds the clear key and the one field only on a reveal", () => {
    expect(columns({ action: "reveal", staffId: "u1", route: "/v2/customers/c1", customerKey: "c1", field: "customers.phone" })).toEqual([
      "u1",
      "reveal",
      "/v2/customers/c1",
      "c1",
      null,
      null,
      '["customers.phone"]',
    ]);
  });

  it("holds the run and its PII columns on a rejects download", () => {
    expect(columns({ action: "rejects_download", staffId: "u1", route: "/v2/data/imports", runId: "r1", fields: ["email", "phone"] })).toEqual(
      ["u1", "rejects_download", "/v2/data/imports", null, null, "r1", '["email","phone"]'],
    );
  });

  it("holds only the tombstone on a deletion request", () => {
    expect(columns({ action: "deletion_request", staffId: "u1", route: "/v2/data/privacy", customerKeyHash: "ab" })).toEqual([
      "u1",
      "deletion_request",
      "/v2/data/privacy",
      null,
      "ab",
      null,
      "[]",
    ]);
  });
});

describe("tombstone", () => {
  const KEY = "k".repeat(32);

  it("is not configured without a key of 32 characters", () => {
    expect(readTombstoneKey({})).toEqual({ configured: false });
    expect(readTombstoneKey({ IMPORT_TOMBSTONE_KEY: "short" })).toEqual({ configured: false });
  });

  it("is the HMAC-SHA-256 of the key byte for byte, in lowercase hex", () => {
    const key = readTombstoneKey({ IMPORT_TOMBSTONE_KEY: KEY });
    if (!key.configured) throw new Error("expected a key");
    expect(tombstoneOf(key, " C-1 ")).toBe(createHmac("sha256", KEY).update(" C-1 ").digest("hex"));
    expect(tombstoneOf(key, " C-1 ")).not.toBe(tombstoneOf(key, "C-1"));
    expect(tombstoneOf(key, "C-1")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("imported field uses", () => {
  const condition = { type: "profile_property", field: "orders.spend_90d", op: ">=", value: 5000000 };

  it("finds a condition nested in branches", () => {
    expect(namesProfileField({ paths: [{ conditions: { groups: [{ conditions: [condition] }] } }] }, "orders.spend_90d")).toBe(true);
  });

  it("ignores an event property or a value that only holds the field's text", () => {
    expect(namesProfileField({ type: "event_property", field: "orders.spend_90d" }, "orders.spend_90d")).toBe(false);
    expect(namesProfileField({ type: "profile_property", field: "city", value: "orders.spend_90d" }, "orders.spend_90d")).toBe(false);
  });

  it("names each campaign once and each segment that uses the field", () => {
    const uses = fieldUses(
      "orders.spend_90d",
      [
        { id: "c1", name: "Win back", trigger_json: null, conditions_json: JSON.stringify({ groups: [{ conditions: [condition] }] }), paths_json: null },
        { id: "c1", name: "Win back", trigger_json: null, conditions_json: null, paths_json: JSON.stringify([{ conditions: [condition] }]) },
        { id: "c2", name: "Other", trigger_json: null, conditions_json: "not json", paths_json: null },
      ],
      [
        { id: "SEG-1", name: "Big spenders", conditions_json: { groups: [{ conditions: [condition] }] } },
        { id: "SEG-2", name: "City", conditions_json: { groups: [{ conditions: [{ ...condition, field: "city" }] }] } },
      ],
    );
    expect(uses).toEqual({ campaigns: [{ id: "c1", name: "Win back" }], segments: [{ id: "SEG-1", name: "Big spenders" }] });
  });
});
