/** @jest-environment node */
import type { SystemUser } from "@/lib/db";
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

const mockSessionUser: { current: unknown } = { current: undefined };
jest.mock("@/lib/db", () => ({
  getAdminUserById: async () => mockSessionUser.current,
  createSourceKey: jest.fn(async () => "sk_1"),
  revokeSourceKey: jest.fn(async () => undefined),
}));

import * as db from "@/lib/db";
import { SESSION_COOKIE } from "@/shared/auth/constants";
import { createSourceKeyAction, revokeSourceKeyAction } from "../actions";
import { hashSourceKey } from "../sourceKeys";

const SECRET = "test-session-secret-0123456789-abcdef";

async function signIn(role: "admin" | "editor"): Promise<void> {
  const user = { id: `user-${role}`, email: `${role}@example.com`, role, session_epoch: 0 } as SystemUser & { session_epoch: number };
  mockSessionUser.current = user;
  const token = await signSessionToken(
    { userId: user.id, email: user.email, epoch: 0, providerId: "default" },
    new TextEncoder().encode(SECRET),
    3600,
  );
  mockCookieValues.set(SESSION_COOKIE, token);
}

beforeAll(() => {
  process.env.SESSION_SECRET = SECRET;
});

beforeEach(() => {
  mockCookieValues.clear();
  mockSessionUser.current = undefined;
  jest.mocked(db.createSourceKey).mockClear();
  jest.mocked(db.revokeSourceKey).mockClear();
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

// DIA-FR-16: only an admin may create or revoke a source key. Anyone else's call writes nothing.
describe.each([
  ["no session", { result: "Unauthorized", arrange: async () => {} }],
  ["an editor's session", { result: "Only admin users can do this.", arrange: () => signIn("editor") }],
])("with %s", (_case, { result, arrange }) => {
  beforeEach(arrange);

  it("createSourceKeyAction fails and writes nothing", async () => {
    await expect(createSourceKeyAction("inventory-service")).resolves.toEqual({ error: result });
    expect(db.createSourceKey).not.toHaveBeenCalled();
  });

  it("revokeSourceKeyAction fails and writes nothing", async () => {
    await expect(revokeSourceKeyAction("sk_1")).resolves.toEqual({ error: result });
    expect(db.revokeSourceKey).not.toHaveBeenCalled();
  });
});

describe("for an admin", () => {
  beforeEach(() => signIn("admin"));

  it("returns the key once and stores only its hash and hint (DIA-FR-16)", async () => {
    const result = await createSourceKeyAction(" inventory-service ");

    if (!("key" in result)) throw new Error(`create failed: ${result.error}`);
    expect(result.appId).toBe("inventory-service");
    const [appId, hash, hint, createdBy] = jest.mocked(db.createSourceKey).mock.calls[0];
    expect([appId, createdBy]).toEqual(["inventory-service", "user-admin"]);
    expect(hash).toBe(hashSourceKey(result.key));
    expect(hash).not.toContain(result.key);
    expect(result.key.startsWith(hint)).toBe(true);
    expect(hint.length).toBeLessThan(result.key.length);
  });

  it("refuses an app id that is not valid, before it writes", async () => {
    const result = await createSourceKeyAction("Inventory Service");

    expect(result).toEqual({ error: expect.stringContaining("The app id must be") });
    expect(db.createSourceKey).not.toHaveBeenCalled();
  });

  it("revokes a key by its id (DIA-FR-17)", async () => {
    await expect(revokeSourceKeyAction("sk_1")).resolves.toEqual({ done: true });
    expect(db.revokeSourceKey).toHaveBeenCalledWith("sk_1");
  });
});
