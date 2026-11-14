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

import { grantImportScopeAction, revokeImportScopeAction } from "../scopesActions";

const SECRET = "test-session-secret-0123456789-abcdef";
const CUSTOMERS = "22222222-2222-4222-8222-222222222222";

async function signIn(role: "admin" | "editor"): Promise<void> {
  mockSessionUser.current = { id: `user-${role}`, email: `${role}@example.com`, role, session_epoch: 0 };
  const token = await signSessionToken(
    { userId: `user-${role}`, email: `${role}@example.com`, epoch: 0, providerId: "default" },
    new TextEncoder().encode(SECRET),
    3600,
  );
  mockCookieValues.set(SESSION_COOKIE, token);
}

/** `customers` in the given delivery mode, with `sk_12` (shop-erp) as its writer. */
function database(deliveryMode: "snapshot" | "incremental", keyRevoked = false) {
  mockAnswer.current = (query) => {
    if (query.text.includes("FROM import_record_types")) return [{ name: "customers", delivery_mode: deliveryMode }];
    if (query.text.includes("FROM ingestion_source_keys WHERE id")) return [{ revoked_at: keyRevoked ? new Date() : null }];
    if (query.text.includes("FROM import_source_scopes")) return query.values[1] === "sk_12" ? [] : [{ app_id: "shop-erp" }];
    return [];
  };
}

const inserted = () => mockQueries.filter((query) => query.text.includes("INSERT INTO import_source_scopes"));

beforeEach(() => {
  process.env.SESSION_SECRET = SECRET;
  mockCookieValues.clear();
  mockQueries.length = 0;
  mockSessionUser.current = undefined;
  database("snapshot");
});

describe("grantImportScopeAction", () => {
  it("refuses a second key on a snapshot dataset and names the writer (DIM-FR-09)", async () => {
    await signIn("admin");

    const result = await grantImportScopeAction("sk_14", CUSTOMERS);

    expect(result).toEqual({ error: expect.stringContaining("shop-erp already writes it") });
    expect(inserted()).toHaveLength(0);
  });

  it("locks the dataset row before it reads the writers, so two grants cannot both pass", async () => {
    await signIn("admin");
    await grantImportScopeAction("sk_14", CUSTOMERS);

    expect(mockQueries[0].text).toContain("FOR UPDATE");
  });

  it("grants the snapshot dataset's one writer", async () => {
    await signIn("admin");

    expect(await grantImportScopeAction("sk_12", CUSTOMERS)).toEqual({ done: true });
    expect(inserted()).toEqual([expect.objectContaining({ values: ["sk_12", CUSTOMERS] })]);
  });

  it("grants a second key on an incremental dataset", async () => {
    await signIn("admin");
    database("incremental");

    expect(await grantImportScopeAction("sk_14", CUSTOMERS)).toEqual({ done: true });
    expect(inserted()).toHaveLength(1);
  });

  it("refuses a revoked key", async () => {
    await signIn("admin");
    database("incremental", true);

    expect(await grantImportScopeAction("sk_14", CUSTOMERS)).toEqual({ error: "The source key is revoked." });
    expect(inserted()).toHaveLength(0);
  });

  it("refuses an editor before it reads anything (DIM-FR-25)", async () => {
    await signIn("editor");

    expect("error" in (await grantImportScopeAction("sk_12", CUSTOMERS))).toBe(true);
    expect(mockQueries).toEqual([]);
  });

  it("refuses a caller with no session before it reads anything (DIM-FR-25)", async () => {
    expect("error" in (await grantImportScopeAction("sk_12", CUSTOMERS))).toBe(true);
    expect(mockQueries).toEqual([]);
  });
});

describe("revokeImportScopeAction", () => {
  it("deletes the scope for an admin", async () => {
    await signIn("admin");

    expect(await revokeImportScopeAction("sk_12", CUSTOMERS)).toEqual({ done: true });
    expect(mockQueries).toEqual([expect.objectContaining({ values: ["sk_12", CUSTOMERS] })]);
    expect(mockQueries[0].text).toContain("DELETE FROM import_source_scopes");
  });

  it("refuses an editor and a caller with no session before it writes (DIM-FR-25)", async () => {
    expect("error" in (await revokeImportScopeAction("sk_12", CUSTOMERS))).toBe(true);
    await signIn("editor");
    expect("error" in (await revokeImportScopeAction("sk_12", CUSTOMERS))).toBe(true);
    expect(mockQueries).toEqual([]);
  });
});
