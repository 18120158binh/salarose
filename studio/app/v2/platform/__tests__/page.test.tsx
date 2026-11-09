/** @jest-environment node */
import type { ReactElement } from "react";
import { renderToReadableStream } from "react-dom/server";
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
  useRouter: () => ({ refresh: jest.fn() }),
}));

jest.mock("@/lib/db", () => ({ getAdminUserById: jest.fn() }));

import * as db from "@/lib/db";
import { SESSION_COOKIE } from "@/shared/auth/constants";
import V2PlatformPage from "../page";

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

// The shell React sends first, with each region still checking. Health never settles in these
// tests, so the rest of the stream never comes.
async function shell(page: ReactElement): Promise<string> {
  const stream = await renderToReadableStream(page);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let html = "";
  const quiet = () => new Promise<null>((resolve) => setTimeout(() => resolve(null), 50));
  for (;;) {
    const chunk = await Promise.race([reader.read(), quiet()]);
    if (chunk === null || chunk.done) break;
    html += decoder.decode(chunk.value, { stream: true });
  }
  void reader.cancel();
  return html;
}

const fetchSpy = jest.fn(() => new Promise<Response>(() => {}));

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
  global.fetch = fetchSpy as unknown as typeof fetch;
});

beforeEach(() => {
  mockCookieValues.clear();
  fetchSpy.mockClear();
});

describe("/v2/platform", () => {
  it("shows an editor the forbidden state, with no tool and no health check (PCN-FR-11, SHL-FR-03)", async () => {
    await signInAs("editor");

    const html = await shell(await V2PlatformPage());

    expect(html).toContain("This page is for admins.");
    expect(html).not.toContain("Grafana");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows an admin the platform tools (PCN-FR-11)", async () => {
    await signInAs("admin");

    const html = await shell(await V2PlatformPage());

    expect(html).toContain("Platform");
    expect(html).toContain("Grafana");
    expect(html).not.toContain("This page is for admins.");
  });

  it("opens with the status banner, which reads CHECKING while a check runs (PCN-FR-12)", async () => {
    await signInAs("admin");

    const html = await shell(await V2PlatformPage());

    expect(html).toContain("CHECKING");
    expect(html).toContain("Checking 1 of 1 tools…");
    expect(html).toContain("This page only reads");
  });

  it("tells an editor what the page holds (PCN-FR-11)", async () => {
    await signInAs("editor");

    const html = await shell(await V2PlatformPage());

    expect(html).toContain("Platform shows the tools that run Salarose and whether each one is up.");
  });

  it("sends a visitor whose session is gone to the login page", async () => {
    await expect(V2PlatformPage()).rejects.toThrow("NEXT_REDIRECT /login");
  });
});
