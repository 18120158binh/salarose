/** @jest-environment node */

// Source key create and revoke, from the admin action down to the statements sent to Postgres.
// The pg Pool is a fake that records each statement and answers it from mockRespond.
import type { AdminSession } from "@/shared/auth/types";

interface MockStatement {
  text: string;
  values: unknown[];
}

const mockStatements: MockStatement[] = [];
let mockRespond: (statement: MockStatement) => { rows: Record<string, unknown>[]; rowCount: number } = () => ({
  rows: [],
  rowCount: 1,
});
let mockSession: AdminSession = { userId: "user_admin", email: "admin@example.com", role: "admin" };

jest.mock("server-only", () => ({}));
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }));
jest.mock("@/shared/auth/session", () => ({
  assertAdmin: async () => {
    if (mockSession.role !== "admin") throw new Error("Only admin users can do this.");
    return mockSession;
  },
  assertSession: async () => mockSession,
}));
jest.mock("../../shared/node_modules/pg", () => {
  const query = async (text: string, values: unknown[] = []) => {
    const statement = { text: text.replace(/\s+/g, " ").trim(), values };
    if (statement.text.includes("to_regclass")) return { rows: [], rowCount: 0 };
    mockStatements.push(statement);
    return mockRespond(statement);
  };
  return { Pool: jest.fn().mockImplementation(() => ({ query, connect: async () => ({ query, release: () => undefined }) })) };
});

import { createSourceKeyAction, revokeSourceKeyAction } from "@/app/actions";
import { findSourceKeyByHash } from "@/lib/db";
import { hashSourceKey } from "../src/features/data-ingestion/model/sourceKeys";

beforeAll(() => {
  process.env.DATABASE_URL = "postgres://test";
});

beforeEach(() => {
  mockStatements.length = 0;
  mockRespond = () => ({ rows: [], rowCount: 1 });
  mockSession = { userId: "user_admin", email: "admin@example.com", role: "admin" };
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("source key actions", () => {
  it("returns the new key once and stores only its hash", async () => {
    const result = await createSourceKeyAction("inventory-service");

    if (!("key" in result)) throw new Error(result.error);
    const [insert] = mockStatements;
    expect(insert.text).toMatch(/^INSERT INTO ingestion_source_keys/);
    expect(insert.values).toContain(hashSourceKey(result.key));
    expect(insert.values).toContain("inventory-service");
    expect(insert.values).toContain("user_admin");
    expect(insert.values).not.toContain(result.key);
  });

  it("refuses a second active key for the same app id with a message", async () => {
    mockRespond = () => {
      throw Object.assign(new Error("duplicate key"), { code: "23505", constraint: "ingestion_source_keys_active_app_id_key" });
    };

    expect(await createSourceKeyAction("inventory-service")).toEqual({
      error: 'The app id "inventory-service" already has a key. Revoke it first.',
    });
  });

  it("refuses an editor and writes nothing", async () => {
    mockSession = { ...mockSession, role: "editor" };

    expect("error" in (await createSourceKeyAction("inventory-service"))).toBe(true);
    expect("error" in (await revokeSourceKeyAction("sk_1"))).toBe(true);
    expect(mockStatements).toEqual([]);
  });

  it("revokes a key, and a revoked key reads back as revoked", async () => {
    expect(await revokeSourceKeyAction("sk_1")).toEqual({ success: true });
    expect(mockStatements[0]).toEqual({
      text: "UPDATE ingestion_source_keys SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP) WHERE id = $1",
      values: ["sk_1"],
    });

    mockRespond = () => ({ rows: [{ app_id: "inventory-service", revoked_at: new Date() }], rowCount: 1 });
    expect(await findSourceKeyByHash("h")).toEqual({ appId: "inventory-service", revoked: true });
  });

  it("says so when the key to revoke is gone", async () => {
    mockRespond = () => ({ rows: [], rowCount: 0 });

    expect(await revokeSourceKeyAction("sk_gone")).toEqual({ error: "The source key no longer exists." });
  });
});
