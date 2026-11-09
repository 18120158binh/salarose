/** @jest-environment node */

// Staff users exist only as sign-in creates them: the identity provider manages who gets in and
// with which role. These tests run sign-in through shared/lib/db.ts against a small in-memory
// model of system_users that answers the upsert the way Postgres would.

interface MockResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

interface MockRow {
  email: string;
  role: string;
  oidc_issuer: string;
  oidc_subject: string;
  session_epoch: number;
}

// id -> row
let mockRows = new Map<string, MockRow>();

jest.mock("server-only", () => ({}));

jest.mock("../../shared/node_modules/pg", () => {
  const result = (rows: Record<string, unknown>[]): MockResult => ({ rows, rowCount: rows.length });
  const query = async (rawText: string, values: unknown[] = []): Promise<MockResult> => {
    const text = rawText.replace(/\s+/g, " ").trim();
    if (text.startsWith("INSERT INTO system_users (id, email, role, oidc_issuer, oidc_subject)")) {
      if (!text.includes("ON CONFLICT (oidc_issuer, oidc_subject) DO UPDATE")) throw new Error("not an upsert");
      const [newId, email, role, issuer, subject] = values as string[];
      const existing = [...mockRows].find(([, row]) => row.oidc_issuer === issuer && row.oidc_subject === subject);
      const id = existing?.[0] ?? newId;
      const row: MockRow = existing?.[1] ?? { email, role, oidc_issuer: issuer, oidc_subject: subject, session_epoch: 0 };
      Object.assign(row, { email, role });
      mockRows.set(id, row);
      return result([{ id, email: row.email, role: row.role, session_epoch: row.session_epoch }]);
    }
    return result([]);
  };
  return { Pool: jest.fn().mockImplementation(() => ({ query })) };
});

import { upsertSystemUserFromSignIn } from "@/lib/db";
import { resolveSignIn } from "@/shared/auth/signIn";

const keycloak = { id: "keycloak", roleClaim: "roles", roleMap: new Map([["studio-admin", "admin"]] as const) };
const token = (sub: string, roles: string[]) => ({
  iss: "https://idp.example.com",
  sub,
  aud: "studio",
  iat: 0,
  exp: 0,
  email: "Lan.Nguyen@example.com",
  roles,
});
const users = { upsertByAccount: upsertSystemUserFromSignIn };

beforeAll(() => {
  process.env.DATABASE_URL = "postgres://test";
});

beforeEach(() => {
  mockRows = new Map([
    [
      "user_lan",
      {
        email: "lan.nguyen@example.com",
        role: "editor",
        oidc_issuer: "https://idp.example.com",
        oidc_subject: "sub-lan",
        session_epoch: 3,
      },
    ],
  ]);
});

describe("sign-in through system_users", () => {
  it("updates the row of a known provider account with the role from the token, keeping its id and epoch", async () => {
    await expect(resolveSignIn(token("sub-lan", ["studio-admin"]), users, keycloak)).resolves.toEqual({
      ok: true,
      session: { userId: "user_lan", email: "lan.nguyen@example.com", epoch: 3, providerId: "keycloak" },
    });
    expect(mockRows.get("user_lan")?.role).toBe("admin");
  });

  it("creates a new row for a new provider account with the same email, and leaves the old row alone", async () => {
    const result = await resolveSignIn(token("sub-lan-elsewhere", ["studio-admin"]), users, keycloak);

    expect(result).toMatchObject({ ok: true, session: { email: "lan.nguyen@example.com", epoch: 0 } });
    const newId = result.ok ? result.session.userId : "";
    expect(newId).not.toBe("user_lan");
    expect(mockRows.get(newId)?.role).toBe("admin");
    expect(mockRows.get("user_lan")).toMatchObject({ role: "editor", oidc_subject: "sub-lan" });
  });
});

// The identity provider manages staff. Studio offers no action that adds, lists, signs out, or
// deletes another user, or sets a role.
describe("user administration", () => {
  it.each([
    "createAdminUserAction",
    "getAdminUsersAction",
    "updateAdminUserRoleAction",
    "signOutAdminUserEverywhereAction",
    "deleteAdminUserAction",
  ])("has no server action %s", async (name) => {
    jest.resetModules();
    jest.doMock("next/cache", () => ({ revalidatePath: jest.fn() }));
    const actions = await import("@/app/actions");

    expect(actions).not.toHaveProperty(name);
  });
});
