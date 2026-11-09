/** @jest-environment node */

// ensureDbInitialized in shared/lib/db.ts checks the database once per process, before the
// first query. These tests replace the pg Pool with a fake that can fail: Postgres unreachable for
// the first request after studio starts, or tables that schema.sql would create.
let mockFailNext = false;
let mockMissingTables: string[] = [];
let mockCheckedTables: unknown[] = [];
const mockStatements: string[] = [];

jest.mock("../../shared/node_modules/pg", () => {
  const query = async (text: string, values: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    mockStatements.push(sql);
    if (mockFailNext) {
      mockFailNext = false;
      throw new Error("connect ECONNREFUSED 10.0.0.5:5432");
    }
    if (sql.includes("to_regclass(name)")) {
      mockCheckedTables = values[0] as unknown[];
      return { rows: mockMissingTables.map((name) => ({ name })), rowCount: mockMissingTables.length };
    }
    if (sql.includes("FROM system_users")) {
      return { rows: [{ id: "user_admin", email: "admin@example.com", role: "admin" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return {
    Pool: jest.fn().mockImplementation(() => ({ query })),
  };
});

// A fresh copy of db.ts, so each test runs the start-up check from scratch.
async function loadDb() {
  jest.resetModules();
  return import("@/lib/db");
}

const ADMIN = { id: "user_admin", email: "admin@example.com", role: "admin" };

beforeAll(() => {
  process.env.DATABASE_URL = "postgres://test";
});

beforeEach(() => {
  mockFailNext = false;
  mockMissingTables = [];
  mockCheckedTables = [];
  mockStatements.length = 0;
});

describe("ensureDbInitialized", () => {
  it("retries the start-up check on the next call after it failed", async () => {
    const db = await loadDb();
    mockFailNext = true;
    await expect(db.getAdminUserById("user_admin")).rejects.toThrow("connect ECONNREFUSED 10.0.0.5:5432");

    await expect(db.getAdminUserById("user_admin")).resolves.toEqual(ADMIN);
    expect(mockStatements.filter((text) => text.includes("to_regclass(name)"))).toHaveLength(2);
  });

  it("stops with the missing tables named when schema.sql was not applied", async () => {
    mockMissingTables = ["campaign_nodes", "system_user_id_tokens"];
    const db = await loadDb();

    await expect(db.getAdminUserById("user_admin")).rejects.toThrow(
      "Postgres has no campaign_nodes, system_user_id_tokens. Apply infra/db/schema.sql before starting studio.",
    );
    expect(mockStatements.some((text) => text.includes("FROM system_users"))).toBe(false);
  });

  it("checks the tables that studio reads and creates none", async () => {
    const db = await loadDb();

    await expect(db.getAdminUserById("user_admin")).resolves.toEqual(ADMIN);
    expect(mockStatements.filter((text) => /CREATE TABLE/i.test(text))).toEqual([]);
    expect(mockCheckedTables).toEqual(
      expect.arrayContaining(["system_users", "system_user_id_tokens", "campaigns", "campaign_nodes"]),
    );
  });
});
