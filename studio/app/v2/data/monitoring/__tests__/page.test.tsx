/** @jest-environment node */
import type { ReactElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import { DeadLetterReadError, type DeadLetterReader } from "@/features/data-health/model/deadLetterReader";
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
  useRouter: () => ({ push: jest.fn() }),
}));

const mockUser: { current: unknown } = { current: undefined };
const mockPreview: { current: boolean } = { current: false };
jest.mock("@/lib/db", () => ({
  getAdminUserById: async () => mockUser.current,
  getSystemUserPreview: async () => mockPreview.current,
  readOnly: async (_timeoutMs: number, work: (run: (query: { text: string }) => Promise<unknown[]>) => unknown) =>
    work(async (query) => {
      if (mockVolume.error) throw mockVolume.error;
      if (query.text.includes("FROM user_events")) return mockVolume.events;
      if (query.text.includes("max(last_seen_at)")) return mockVolume.lastSeen;
      if (query.text.includes("FROM event_volume")) return mockVolume.rows;
      return [];
    }),
}));

const mockVolume: { events: unknown[]; rows: unknown[]; lastSeen: unknown[]; error: Error | null } = { events: [], rows: [], lastSeen: [], error: null };

const mockReader: { [K in keyof DeadLetterReader]: jest.Mock } = {
  droppedCount: jest.fn(),
  readPage: jest.fn(),
  readContent: jest.fn(),
  retention: jest.fn(),
};
// Jest's alias for @/ points at the studio root, so the mock names the module by its path.
jest.mock("../../../../../src/features/data-health/model/deadLetterServer", () => ({ deadLetterReader: () => mockReader }));

const SECRET = "test-session-secret-0123456789-abcdef";
const DAY = 86_400_000;

async function signIn(role: "admin" | "editor", preview = false): Promise<void> {
  const user = { id: `user-${role}`, email: `${role}@example.com`, role, session_epoch: 0 };
  mockUser.current = user;
  mockPreview.current = preview;
  const token = await signSessionToken({ userId: user.id, email: user.email, epoch: 0, providerId: "default" }, new TextEncoder().encode(SECRET), 3600);
  mockCookieValues.set(SESSION_COOKIE, token);
}

async function render(params: Record<string, string> = {}): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded after the mocks
  const page: (props: { searchParams: Promise<Record<string, string>> }) => Promise<ReactElement> = require("@/app/v2/data/monitoring/page").default;
  const stream = await renderToReadableStream(await page({ searchParams: Promise.resolve(params) }));
  await stream.allReady;
  return (await new Response(stream).text()).replace(/<!-- -->/g, "");
}

beforeAll(() => {
  process.env.SESSION_SECRET = SECRET;
});

beforeEach(() => {
  mockCookieValues.clear();
  mockUser.current = undefined;
  for (const mock of Object.values(mockReader)) mock.mockReset();
  mockReader.droppedCount.mockResolvedValue(12);
  mockVolume.events = [];
  mockVolume.rows = [];
  mockVolume.lastSeen = [];
  mockVolume.error = null;
  mockReader.retention.mockResolvedValue({ kind: "bounded", ms: 7 * DAY });
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("who reaches Monitoring (SHL-FR-22, DHL-FR-05)", () => {
  it("sends a visitor with no session to sign in, before any read", async () => {
    await expect(render()).rejects.toThrow("NEXT_REDIRECT /login");
    expect(mockReader.droppedCount).not.toHaveBeenCalled();
  });

  it("gives an editor without preview access the not-found page, before any read", async () => {
    await signIn("editor");

    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockReader.droppedCount).not.toHaveBeenCalled();
  });

  it("gives an editor the forbidden state on Dropped data, and reads no record", async () => {
    await signIn("editor", true);

    const html = await render({ tab: "dropped" });

    expect(html).not.toContain("What the reasons mean");
    expect(mockReader.retention).not.toHaveBeenCalled();
    expect(mockReader.readPage).not.toHaveBeenCalled();
  });

  it("sends a tab or window the page does not offer to the Overview's address", async () => {
    await signIn("admin");

    await expect(render({ tab: "records" })).rejects.toThrow("NEXT_REDIRECT /v2/data/monitoring");
    await expect(render({ tab: "dropped", window: "24h" })).rejects.toThrow("NEXT_REDIRECT /v2/data/monitoring?tab=dropped");
  });
});

describe("Overview (DHL-FR-13)", () => {
  it("shows an editor the dropped count with no link to the records", async () => {
    await signIn("editor", true);

    const html = await render();

    expect(html).toContain("Monitoring");
    expect(html).toContain("Preview");
    expect(html).toContain("Dropped in the last 7 days");
    expect(html).toContain(">12<");
    expect(html).toContain("Ask an admin for details.");
    expect(html).not.toContain("tab=dropped");
    expect(html).not.toContain("Dropped data");
  });

  it("links an admin to the Dropped data tab with the window kept", async () => {
    await signIn("admin");

    const html = await render({ window: "today" });

    expect(html).toContain("Dropped today");
    expect(html).toContain('href="/v2/data/monitoring?tab=dropped&amp;window=today"');
    expect(html).toContain("See why they were dropped");
  });

  it("says Not available when the topic fails", async () => {
    await signIn("admin");
    mockReader.droppedCount.mockRejectedValue(new DeadLetterReadError("Kafka unreachable"));

    const html = await render();

    expect(html).not.toContain("Coming later");
    expect(html).toContain("Dropped records could not be counted: Kafka unreachable.");
  });

  it("counts receiving and quiet events and lists each event with its drops, quiet first (DHL-FR-14)", async () => {
    await signIn("admin");
    const now = Date.now();
    const hour = Math.floor(now / 3_600_000) * 3_600_000;
    mockVolume.events = [
      { id: "e1", event_name: "com.acme/add_to_cart", label: "Added to cart" },
      { id: "e2", event_name: "com.acme/wishlist_added", label: "Wishlist added" },
      { id: "e3", event_name: "com.acme/order_completed", label: "Order completed" },
    ];
    mockVolume.rows = [
      { event_name: "com.acme/add_to_cart", bucket_start: new Date(hour), outcome: "accepted", count: 9412 },
      { event_name: "com.acme/add_to_cart", bucket_start: new Date(hour), outcome: "schema_invalid", count: 38 },
    ];
    mockVolume.lastSeen = [
      { event_name: "com.acme/add_to_cart", last_seen_at: new Date(now - 30_000) },
      { event_name: "com.acme/wishlist_added", last_seen_at: new Date(now - 23 * DAY) },
    ];

    const html = await render({ window: "today" });

    expect(html).toMatch(/>1<\/span><span[^>]*>of 3 events seen/);
    expect(html).toContain("Wishlist added</span>");
    expect(html).toContain("Nothing in 7 days. Check your tracking.");
    expect(html).toContain("9,412");
    expect(html).toContain(">38<");
    expect(html).toContain("Not yet");
    expect(html.indexOf("com.acme/wishlist_added")).toBeLessThan(html.indexOf("com.acme/add_to_cart"));
    expect(html).toContain("See why");
    // Each status is an icon and a word, never color alone, and the Quiet tile names the quiet event.
    expect(html).toMatch(/text-warning[^>]*><svg[^]*?<\/svg>Wishlist added<\/span>/);
    expect(html).toMatch(/text-success[^>]*><svg[^]*?<\/svg>Yes<\/span>/);
    expect(html).toMatch(/text-warning[^>]*><svg[^]*?<\/svg>Quiet<\/span>/);
    expect(html).toMatch(/text-muted-foreground[^>]*><svg[^]*?<\/svg>Not yet<\/span>/);
  });

  it("says the zone applies to every tab and the pipeline strip always covers the last hour", async () => {
    await signIn("admin");

    const html = await render({ window: "7d" });

    expect(html).toMatch(/Times in [^<]+<!-- --> · applies to every tab|Times in [^<]+ · applies to every tab/);
    expect(html).toContain("Same strip as Home · always the last hour");
  });

  it("shows the region's error, not zeros, when event volume cannot load", async () => {
    await signIn("admin");
    mockVolume.error = new Error("timeout");

    const html = await render();

    // The server hands each failed region to the client, which shows its error with a retry.
    expect(html).toContain("Switched to client rendering");
    expect(html).not.toContain("events seen");
    expect(html).not.toContain("Each event's");
    expect(html).toContain(">12<");
  });
});

describe("Dropped data (DHL-FR-05, DHL-FR-06, DHL-FR-11)", () => {
  it("shows an admin the retention, the filters, and what each reason means", async () => {
    await signIn("admin");

    const html = await render({ tab: "dropped", reason: "schema_invalid" });

    expect(html).toContain("Kept for 7 days by the topic. Older records are gone.");
    expect(html).toContain("Didn&#x27;t fit Strict rules");
    expect(html).toContain("Events and requests");
    expect(html).toContain("What the reasons mean");
    expect(html).toContain("Read only: nothing here changes or replays data.");
  });
});

describe("Dashboards (DHL-FR-03)", () => {
  afterEach(() => {
    delete process.env.PIPELINE_DASHBOARDS;
  });

  it("with none declared, tells an admin and hides the tab from an editor", async () => {
    await signIn("admin");
    expect(await render({ tab: "dashboards" })).toContain("No dashboards configured");

    await signIn("editor", true);
    await expect(render({ tab: "dashboards" })).rejects.toThrow("NEXT_REDIRECT /v2/data/monitoring");
  });
});
