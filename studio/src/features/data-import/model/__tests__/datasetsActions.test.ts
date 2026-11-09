/** @jest-environment node */
import type { SqlQuery } from "@/lib/db";
import { SESSION_COOKIE } from "@/shared/auth/constants";
import { signSessionToken } from "@/shared/auth/sessionToken";

jest.mock("server-only", () => ({}));
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }));

const mockCookieValues = new Map<string, string>();
jest.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = mockCookieValues.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

type Rows = Record<string, unknown>[];
const mockSessionUser: { current: unknown } = { current: undefined };
const mockQueries: SqlQuery[] = [];
const mockAnswer: { current: (query: SqlQuery) => Rows } = { current: () => [] };
jest.mock("@/lib/db", () => ({
  getAdminUserById: async () => mockSessionUser.current,
  inTransaction: async (work: (client: unknown) => unknown) =>
    work({
      query: async (text: string, values: unknown[]) => {
        mockQueries.push({ text, values });
        return { rows: mockAnswer.current({ text, values }) };
      },
    }),
}));

import { createDatasetAction, saveDatasetVersionAction } from "../datasetsActions";

const SECRET = "test-session-secret-0123456789-abcdef";
const ID = "5f0c8a2e-1b7d-4c39-9a51-2d3e4f5a6b7c";

async function signIn(role: "admin" | "editor"): Promise<void> {
  mockSessionUser.current = { id: `user-${role}`, email: `${role}@example.com`, role, session_epoch: 0 };
  const token = await signSessionToken(
    { userId: `user-${role}`, email: `${role}@example.com`, epoch: 0, providerId: "default" },
    new TextEncoder().encode(SECRET),
    3600,
  );
  mockCookieValues.set(SESSION_COOKIE, token);
}

const COLUMNS = [
  { name: "order_id", displayName: "Order ID", type: "string", pii: false, aliases: [] },
  { name: "customer_id", displayName: "Customer ID", type: "string", pii: false, aliases: [] },
  { name: "created_at", displayName: "Order time", type: "datetime", pii: false, aliases: [] },
  { name: "total", displayName: "Order total", type: "number", pii: false, aliases: [] },
];
const ROLES = { customer_key: "customer_id", record_id: "order_id", event_time: "created_at" };
const VERSION = { columns: COLUMNS, roles: ROLES, deliveryMode: "incremental", timeZone: "UTC", delimiter: "," };

const STORED = {
  version: 3,
  columns: COLUMNS,
  roles: ROLES,
  delivery_mode: "incremental",
  time_zone: "UTC",
  delimiter: ",",
  created_at: new Date(0),
  created_by_email: "admin@example.com",
};

/** The database of a stored dataset `orders` at version 3, with `spend_90d` on `total`. */
function storedDataset(extra: (query: SqlQuery) => Rows | undefined = () => undefined) {
  mockAnswer.current = (query) => {
    const answer = extra(query);
    if (answer) return answer;
    if (query.text.includes("FOR UPDATE")) return [{ name: "orders", kind: "event", current_version: 3 }];
    if (query.text.includes("FROM import_record_type_versions v")) return [STORED];
    if (query.text.includes("FROM import_metric_definitions")) return [{ id: "m1", name: "spend_90d", column: "total", filters: [] }];
    return [];
  };
}

const writes = () => mockQueries.filter((query) => /^\s*(INSERT|UPDATE)/.test(query.text));

beforeAll(() => {
  process.env.SESSION_SECRET = SECRET;
});

beforeEach(() => {
  mockCookieValues.clear();
  mockSessionUser.current = undefined;
  mockQueries.length = 0;
  mockAnswer.current = () => [];
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe("createDatasetAction (DIM-FR-01, DIM-FR-02, DIM-FR-25)", () => {
  const input = { name: "orders", displayName: "Orders", kind: "event", version: VERSION };

  it("refuses a request without a session and writes nothing", async () => {
    expect(await createDatasetAction(input)).toEqual({ error: "Unauthorized" });
    expect(mockQueries).toEqual([]);
  });

  it("refuses an editor and writes nothing", async () => {
    await signIn("editor");
    expect(await createDatasetAction(input)).toEqual({ error: "Only admin users can do this." });
    expect(mockQueries).toEqual([]);
  });

  it("refuses a name that breaks the system name rule", async () => {
    await signIn("admin");
    const result = await createDatasetAction({ ...input, name: "Orders-2026" });
    expect(result).toEqual({ error: expect.stringContaining("lowercase letters, digits, and underscores") });
    expect(mockQueries).toEqual([]);
  });

  it("refuses an event version without an event time (DIM-FR-03)", async () => {
    await signIn("admin");
    const result = await createDatasetAction({ ...input, version: { ...VERSION, roles: { customer_key: "customer_id", record_id: "order_id" } } });
    expect(result).toEqual({ error: "Map Event time to a column." });
  });

  it("creates the dataset and version 1 in one transaction", async () => {
    await signIn("admin");
    mockAnswer.current = (query) => (query.text.includes("INSERT INTO import_record_types") ? [{ id: ID }] : []);
    expect(await createDatasetAction(input)).toEqual({ saved: true, id: ID, version: 1 });
    expect(writes().map((query) => query.values.slice(0, 2))).toEqual([
      ["orders", "Orders"],
      [ID, 1],
    ]);
  });

  it("refuses a name that exists", async () => {
    await signIn("admin");
    expect(await createDatasetAction(input)).toEqual({ error: 'A dataset named "orders" already exists.' });
  });
});

describe("saveDatasetVersionAction (DIM-FR-04 to DIM-FR-07)", () => {
  const save = (version: unknown, baseVersion = 3) => saveDatasetVersionAction({ id: ID, baseVersion, displayName: "Orders", version });

  it("refuses a request without a session, and an editor, and writes nothing", async () => {
    expect(await save(VERSION)).toEqual({ error: "Unauthorized" });
    await signIn("editor");
    expect(await save(VERSION)).toEqual({ error: "Only admin users can do this." });
    expect(mockQueries).toEqual([]);
  });

  it("refuses to delete a column a metric uses, names the metric, and writes nothing", async () => {
    await signIn("admin");
    storedDataset();
    const result = await save({ ...VERSION, columns: COLUMNS.slice(0, 3) });
    expect(result).toMatchObject({ refusals: [{ column: "total", uses: ["Metric spend_90d"] }] });
    expect(writes()).toEqual([]);
  });

  it("names a segment that uses the column's field", async () => {
    await signIn("admin");
    storedDataset((query) =>
      query.text.includes("FROM segments")
        ? [{ id: "s1", name: "Big spenders", conditions_json: JSON.stringify({ type: "profile_property", field: "orders.created_at" }) }]
        : undefined,
    );
    const retyped = COLUMNS.map((column) => (column.name === "created_at" ? { ...column, type: "string" } : column));
    const result = await save({ ...VERSION, columns: retyped });
    expect(result).toMatchObject({ refusals: [{ column: "created_at", uses: ["Segment Big spenders"] }] });
  });

  it("refuses a remap while a run is applying (DIM-FR-06)", async () => {
    await signIn("admin");
    storedDataset((query) => (query.text.includes("FROM import_runs") ? [{ "?column?": 1 }] : undefined));
    const result = await save({ ...VERSION, deliveryMode: "snapshot" });
    expect(result).toEqual({ error: "A file for this dataset is being checked or applied. Save again when it is done." });
    expect(writes()).toEqual([]);
  });

  it("saves a remap as the next version and creates no rederive run", async () => {
    await signIn("admin");
    storedDataset();
    expect(await save({ ...VERSION, deliveryMode: "snapshot" })).toEqual({ saved: true, id: ID, version: 4 });
    expect(writes().map((query) => query.text.trim().split(/\s+/).slice(0, 3).join(" "))).toEqual([
      "INSERT INTO import_record_type_versions",
      "UPDATE import_record_types SET",
    ]);
    expect(mockQueries.some((query) => query.text.includes("INSERT INTO import_runs"))).toBe(false);
  });

  it("saves a PII flag in place, without a new version (DIM-FR-07)", async () => {
    await signIn("admin");
    storedDataset();
    const flagged = COLUMNS.map((column) => (column.name === "total" ? { ...column, pii: true } : column));
    expect(await save({ ...VERSION, columns: flagged })).toEqual({ saved: true, id: ID, version: 3 });
    const [inPlace] = writes();
    expect(inPlace.text).toContain("UPDATE import_record_type_versions SET columns");
    expect(JSON.parse(String(inPlace.values[2]))).toContainEqual(expect.objectContaining({ name: "total", pii: true }));
  });

  it("refuses a save over a version someone else replaced", async () => {
    await signIn("admin");
    storedDataset();
    expect(await save(VERSION, 2)).toEqual({ error: "Someone saved version 3 since you opened this page. Reload to see it." });
    expect(writes()).toEqual([]);
  });
});
