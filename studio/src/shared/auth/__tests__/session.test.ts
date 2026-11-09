/** @jest-environment node */
import type { SystemUser } from "@/lib/db";
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

jest.mock("next/navigation", () => ({
  redirect: jest.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));

jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }));

jest.mock("@/lib/db", () => ({
  getAdminUserById: jest.fn(),
}));

import * as db from "@/lib/db";
import { redirect } from "next/navigation";
import {
  AuthorizationError,
  assertAdmin,
  getSession,
  requireAdmin,
  requireSession,
} from "@/shared/auth/session";

const SECRET = "test-session-secret-0123456789-abcdef";
type StoredUser = SystemUser & { session_epoch: number };
const usersById = new Map<string, StoredUser>();

beforeAll(() => {
  process.env.SESSION_SECRET = SECRET;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockCookieValues.clear();
  usersById.clear();
  jest.mocked(db.getAdminUserById).mockImplementation(async (id) => usersById.get(id) ?? null);
});

async function signInAs(user: StoredUser): Promise<void> {
  usersById.set(user.id, user);
  const token = await signSessionToken(
    { userId: user.id, email: user.email, epoch: user.session_epoch, providerId: "default" },
    new TextEncoder().encode(SECRET),
    3600,
  );
  mockCookieValues.set("cdp_admin_session", token);
}

const admin: StoredUser = { id: "user_admin", email: "admin@example.com", role: "admin", session_epoch: 0 };
const editor: StoredUser = {
  id: "user_editor",
  email: "lan.nguyen@example.com",
  role: "editor",
  session_epoch: 0,
};

describe("getSession", () => {
  it("returns null when the cookie verifies but the user is gone", async () => {
    await signInAs(editor);
    usersById.delete(editor.id);

    await expect(getSession()).resolves.toBeNull();
  });

  it("returns null for a cookie signed before the user's sessions were ended", async () => {
    await signInAs({ ...editor, session_epoch: 2 });
    usersById.set(editor.id, { ...editor, session_epoch: 3 });

    await expect(getSession()).resolves.toBeNull();
  });

  it("returns the session for a cookie signed at the user's current epoch", async () => {
    await signInAs({ ...editor, session_epoch: 3 });

    await expect(getSession()).resolves.toEqual({
      userId: "user_editor",
      email: "lan.nguyen@example.com",
      role: "editor",
    });
  });

  it("takes the role from the database, not from sign-in time", async () => {
    await signInAs(admin);
    usersById.set(admin.id, { ...admin, role: "editor" });

    await expect(getSession()).resolves.toEqual({
      userId: "user_admin",
      email: "admin@example.com",
      role: "editor",
    });
  });
});

describe("page guards", () => {
  it("requireSession redirects to /login without a cookie", async () => {
    await expect(requireSession()).rejects.toThrow("NEXT_REDIRECT /login");
    expect(redirect).toHaveBeenCalledWith("/login");
  });

  it("requireAdmin redirects an editor to /campaign and returns an admin's session", async () => {
    await signInAs(editor);
    await expect(requireAdmin()).rejects.toThrow("NEXT_REDIRECT /campaign");
    expect(redirect).toHaveBeenCalledWith("/campaign");

    await signInAs(admin);
    await expect(requireAdmin()).resolves.toEqual({
      userId: "user_admin",
      email: "admin@example.com",
      role: "admin",
    });
  });
});

describe("assertAdmin", () => {
  it("throws AuthorizationError for an editor", async () => {
    await signInAs(editor);

    await expect(assertAdmin()).rejects.toThrow(AuthorizationError);
    await expect(assertAdmin()).rejects.toThrow("Only admin users can do this.");
  });
});
