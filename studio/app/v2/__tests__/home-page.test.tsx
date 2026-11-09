/** @jest-environment node */
import type { ReactElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import type { SqlQuery, SystemUser } from "@/lib/db";
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
  headers: async () => new Headers(),
}));

jest.mock("next/navigation", () => ({
  redirect: jest.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  useRouter: () => ({ refresh: () => {} }),
}));

// Answers each statement by what it reads. A statement that `mockFailing` picks rejects.
const mockFailing: { current: ((query: SqlQuery) => boolean) | null } = { current: null };
const mockSessionUser: { current: unknown } = { current: undefined };
const mockDataReads: string[] = [];
jest.mock("@/lib/db", () => ({
  getAdminUserById: async () => mockSessionUser.current,
  getSystemUserPreview: async () => false,
  readOnly: async (_timeoutMs: number, work: (run: (query: SqlQuery) => Promise<Record<string, unknown>[]>) => unknown) =>
    work(async (query) => {
      mockDataReads.push(query.text);
      if (mockFailing.current?.(query)) throw new Error("canceling statement due to statement timeout");
      if (query.text.includes("c.status = 'active'")) {
        return [{ id: "CAMP-cart", name: "Cart abandonment", owner_id: "user-lan", owner_email: "lan@example.com" }];
      }
      if (query.text.includes("created_user = $1")) {
        return [{ id: "CAMP-mine", name: "Welcome series", status: "paused", updated_at: new Date("2026-11-09T00:00:00Z") }];
      }
      if (query.text.includes("percentile_cont")) return [{ bucket: 1, p95: 2_000 }];
      if (query.text.includes("count(*)")) return [{ bucket: 1, campaign_id: "CAMP-cart", branch: "next", n: "12480" }];
      return [{ last_at: new Date() }];
    }),
}));

jest.mock("../../../src/features/data-health/model/deadLetterServer", () => ({
  deadLetterReader: () => ({
    droppedCount: async () => {
      mockDataReads.push("dead letters");
      return 0;
    },
  }),
}));

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

type Page = (props: { searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;

async function renderHome(searchParams: Record<string, string> = {}): Promise<{ html: string; errors: unknown[] }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded after the mocks
  const page: Page = require("@/app/v2/page").default;
  const errors: unknown[] = [];
  const stream = await renderToReadableStream(await page({ searchParams: Promise.resolve(searchParams) }), {
    onError: (error) => {
      errors.push(error);
    },
  });
  await stream.allReady;
  return { html: await new Response(stream).text(), errors };
}

beforeAll(() => {
  process.env.SESSION_SECRET = SECRET;
});

beforeEach(async () => {
  mockFailing.current = null;
  mockDataReads.length = 0;
  mockCookieValues.clear();
  await signIn("editor");
});

// Next does not render the /v2 layout again on client navigation, so the page checks the session
// itself (#292).
describe("/v2 home overview without a session", () => {
  it("sends a request with no session cookie to sign-in and reads no data", async () => {
    mockCookieValues.clear();
    await expect(renderHome()).rejects.toThrow("NEXT_REDIRECT /login");
    expect(mockDataReads).toEqual([]);
  });

  it("sends a signed cookie whose user was deleted to sign-in and reads no data", async () => {
    mockSessionUser.current = null;
    await expect(renderHome()).rejects.toThrow("NEXT_REDIRECT /login");
    expect(mockDataReads).toEqual([]);
  });
});

describe("/v2 home overview", () => {
  it("shows the KPI row, the health strip, the journeys table, and Continue where you left off (HOM-FR-01)", async () => {
    const { html, errors } = await renderHome();

    expect(errors).toEqual([]);
    expect(html).toContain("12,480");
    expect(html).toContain("Pipeline, last hour");
    expect(html).toContain("Cart abandonment");
    expect(html).toContain("Welcome series");
  });

  // The journey list, journey analytics, the event catalog view, and the admin-only data pages have
  // shipped. An editor may not open the admin pages, so no link may point at them (SHL-FR-01).
  it("links an editor to every journey's analytics and the event catalog view, and to no page they may not open", async () => {
    const { html } = await renderHome();

    expect(html).toContain('href="/v2/data/events"');
    expect(html).not.toContain('href="/v2/data/dead-letters"');
    expect(html).not.toContain('href="/v2/data/sources"');
    expect(html).toContain('href="/v2/journeys"');
    expect(html).toContain('href="/v2/journeys/CAMP-mine"');
    expect(html).toContain('href="/v2/journeys/CAMP-cart"');
    expect(html).not.toContain('href="/admin/events"');
  });

  it("links an admin to every journey's analytics and to the dead-letter browser", async () => {
    await signIn("admin");
    const { html } = await renderHome();

    expect(html).toContain('href="/v2/data/dead-letters"');
    expect(html).toContain('href="/v2/journeys/CAMP-cart"');
  });

  it("still loads the other regions, the journeys table included, when the KPI query fails (HOM-FR-01)", async () => {
    // The KPI read counts every campaign. The table's read passes its campaign ids.
    mockFailing.current = (query) => query.text.includes("count(*)") && query.values[3] === null;
    const { html, errors } = await renderHome();

    expect(errors.length).toBeGreaterThan(0);
    const table = html.match(/<table[\s\S]*<\/table>/)?.[0] ?? "";
    expect(table).toContain("Cart abandonment");
    expect(table).toContain("12,480");
    expect(html.replace(table, "")).not.toContain("12,480");
    expect(html).toContain("Pipeline, last hour");
    expect(html).toContain('href="/v2/journeys/CAMP-mine"');
  });

  it("shows no delivery, open, click, conversion, or revenue number (HOM-FR-09)", async () => {
    const { html } = await renderHome();
    const text = html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'");
    // The board's footnote names them only to say Studio does not get them yet.
    const footnote = "Delivery, opens, clicks and revenue aren't reported back to Studio yet.";
    expect(text).toContain(footnote);
    expect(text.replace(footnote, "")).not.toMatch(/deliver|\bopens\b|open rate|click|conversion|revenue/i);
  });

  it("puts the default range back in the address for an unknown range", async () => {
    await expect(renderHome({ range: "90d" })).rejects.toThrow("NEXT_REDIRECT /v2?range=7d");
  });

  it("marks the chosen range and names the time zone (SHL-FR-15)", async () => {
    mockCookieValues.set("tz", "Asia/Ho_Chi_Minh");
    const { html } = await renderHome({ range: "30d" });
    expect(html).toMatch(/aria-current="page"[^>]*href="\/v2\?range=30d"|href="\/v2\?range=30d"[^>]*aria-current="page"/);
    expect(html).toContain("Times in Asia/Ho_Chi_Minh");
  });
});
