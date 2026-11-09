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

jest.mock("@/lib/db", () => ({ getAdminUserById: jest.fn() }));

import * as db from "@/lib/db";
import { SESSION_COOKIE } from "@/shared/auth/constants";
import PlatformPage from "../page";

const SECRET = "test-session-secret-0123456789-abcdef";
type StoredUser = SystemUser & { session_epoch: number };

async function signInAs(role: "admin" | "editor"): Promise<void> {
  const user = { id: `user-${role}`, email: `${role}@example.com`, role, session_epoch: 0 } as StoredUser;
  jest.mocked(db.getAdminUserById).mockResolvedValue(user);
  const token = await signSessionToken(
    { userId: user.id, email: user.email, epoch: 0, providerId: "default" },
    new TextEncoder().encode(SECRET),
    3600,
  );
  mockCookieValues.set(SESSION_COOKIE, token);
}

const fetchSpy = jest.fn();

beforeAll(() => {
  process.env.SESSION_SECRET = SECRET;
  process.env.PLATFORM_TOOLS = JSON.stringify([
    {
      id: "grafana",
      name: "Grafana",
      purpose: "Dashboards",
      url: "https://grafana.example.io",
      signIn: "sso",
      health: { kind: "grafana", url: "http://kps-grafana.monitoring.svc" },
    },
  ]);
  global.fetch = fetchSpy;
});

beforeEach(() => {
  mockCookieValues.clear();
  fetchSpy.mockReset();
});

describe("/platform", () => {
  it("sends an editor to the campaigns before checking any tool", async () => {
    await signInAs("editor");

    await expect(PlatformPage()).rejects.toThrow("NEXT_REDIRECT /campaign");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends a visitor without a session to the login page", async () => {
    await expect(PlatformPage()).rejects.toThrow("NEXT_REDIRECT /login");
  });

  it("renders for an admin", async () => {
    await signInAs("admin");

    await expect(PlatformPage()).resolves.toBeTruthy();
  });
});
