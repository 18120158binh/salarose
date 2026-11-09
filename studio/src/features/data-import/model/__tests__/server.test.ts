/** @jest-environment node */
import { SESSION_COOKIE } from "@/shared/auth/constants";
import { signSessionToken } from "@/shared/auth/sessionToken";

jest.mock("server-only", () => ({}));

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
const mockInTransaction = jest.fn();
jest.mock("@/lib/db", () => ({
  getAdminUserById: async () => mockSessionUser.current,
  inTransaction: (work: unknown) => mockInTransaction(work),
}));

import { assertDataImportAdmin } from "../server";

const SECRET = "test-session-secret-0123456789-abcdef";

async function signIn(user: { id: string; email: string; role: string } | undefined): Promise<void> {
  mockSessionUser.current = user && { ...user, session_epoch: 0 };
  const token = await signSessionToken(
    { userId: user?.id ?? "gone", email: user?.email ?? "gone@example.com", epoch: 0, providerId: "default" },
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
});

describe("assertDataImportAdmin (DIM-FR-25)", () => {
  it("refuses a request without a session", async () => {
    await expect(assertDataImportAdmin()).rejects.toThrow("Unauthorized");
  });

  it("refuses a deleted user who still holds a signed cookie", async () => {
    await signIn(undefined);
    await expect(assertDataImportAdmin()).rejects.toThrow("Unauthorized");
  });

  it("refuses an editor", async () => {
    await signIn({ id: "u-editor", email: "editor@example.com", role: "editor" });
    await expect(assertDataImportAdmin()).rejects.toThrow("Only admin users can do this.");
  });

  it("lets an admin through", async () => {
    await signIn({ id: "u-admin", email: "admin@example.com", role: "admin" });
    await expect(assertDataImportAdmin()).resolves.toMatchObject({ userId: "u-admin", role: "admin" });
  });
});
