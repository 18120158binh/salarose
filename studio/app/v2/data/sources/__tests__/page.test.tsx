/** @jest-environment node */
import type { ReactElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import type { SystemUser } from "@/lib/db";
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

jest.mock("next/navigation", () => ({
  redirect: jest.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  notFound: jest.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

const mockSessionUser: { current: unknown } = { current: undefined };
const mockKeys: { current: unknown[] | Error } = { current: [] };
const mockKeyReads = { count: 0 };

jest.mock("@/lib/db", () => ({
  getAdminUserById: async () => mockSessionUser.current,
  getSystemUserPreview: async () => false,
  readOnly: async () => {
    throw new Error("The page reads only through its loaders.");
  },
}));

jest.mock("../../../../../src/features/data-health/model/catalogServer", () => ({
  loadSourceKeys: async () => {
    mockKeyReads.count += 1;
    if (mockKeys.current instanceof Error) throw mockKeys.current;
    return mockKeys.current;
  },
}));

const SECRET = "test-session-secret-0123456789-abcdef";

async function signIn(role: "admin" | "editor"): Promise<void> {
  const user = { id: `user-${role}`, email: `${role}@example.com`, role, session_epoch: 0 } as SystemUser & { session_epoch: number };
  mockSessionUser.current = user;
  const token = await signSessionToken(
    { userId: user.id, email: user.email, epoch: 0, providerId: "keycloak" },
    new TextEncoder().encode(SECRET),
    3600,
  );
  mockCookieValues.set(SESSION_COOKIE, token);
}

async function renderSources(): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded after the mocks
  const page: () => Promise<ReactElement> = require("@/app/v2/data/sources/page").default;
  const stream = await renderToReadableStream(await page(), { onError: () => undefined });
  await stream.allReady;
  return new Response(stream).text();
}

const text = (markup: string) =>
  markup
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const KEYS = [
  {
    id: "k1",
    appId: "order-service",
    hint: "mlk_7Hq2",
    createdBy: "minh@example.com",
    createdAt: Date.UTC(2026, 9, 18, 2),
    status: { kind: "active" },
  },
  {
    id: "k2",
    appId: "pos-hanoi",
    hint: "mlk_Yb05",
    createdBy: null,
    createdAt: Date.UTC(2026, 9, 14, 9),
    status: { kind: "revoked", at: Date.UTC(2026, 9, 30, 10) },
  },
];

beforeAll(() => {
  process.env.SESSION_SECRET = SECRET;
});

beforeEach(() => {
  mockCookieValues.clear();
  mockKeys.current = [];
  mockKeyReads.count = 0;
  process.env.OIDC_REDIRECT_URL = "https://studio.example.com/api/auth/oidc/callback";
});

describe("/v2/data/sources (DHL-FR-04)", () => {
  it("sends a visitor without a session to sign in and reads no key", async () => {
    mockSessionUser.current = undefined;

    await expect(renderSources()).rejects.toThrow("NEXT_REDIRECT /login");
    expect(mockKeyReads.count).toBe(0);
  });

  it("shows an editor the forbidden state and reads no key", async () => {
    await signIn("editor");

    const html = await renderSources();

    expect(html).toContain("This page is for admins.");
    expect(mockKeyReads.count).toBe(0);
  });

  it("lists every key with the board's columns and shows no per-source numbers", async () => {
    await signIn("admin");
    mockKeys.current = KEYS;

    const html = text(await renderSources());

    expect(html).toContain("Source (app id) Key starts with Created by Created Status Health Actions");
    expect(html).toContain("1 active · 1 revoked · active first");
    expect(html).toContain("order-service mlk_7Hq2… minh@example.com");
    expect(html).toContain("pos-hanoi mlk_Yb05… Not recorded");
    expect(html).toContain("Not available Requests per source are not recorded yet.");
    expect(html).toContain("Manage in classic");
  });

  it("samples POST /v1/events at Studio's address and names the business route (DHL-FR-16, DHL-FR-17)", async () => {
    await signIn("admin");

    const html = text(await renderSources());

    expect(html).toContain("curl -X POST https://studio.example.com/v1/events");
    expect(html).toContain("go to /v1/business-events with the same key");
    expect(html).not.toContain("coming later");
  });

  it("says why the list is empty", async () => {
    await signIn("admin");

    const html = text(await renderSources());

    expect(html).toContain("No source keys yet.");
  });

  // React's development build writes the error into the bail-out template; production does not.
  // The region fails on its own and the side cards still render (SHL-FR-12).
  it("fails the key region on its own when the keys cannot load", async () => {
    await signIn("admin");
    mockKeys.current = new Error("connection refused at 10.0.0.5");

    const html = await renderSources();

    expect(html).toContain("<!--$!-->");
    expect(html).toContain("How to send data");
  });
});
