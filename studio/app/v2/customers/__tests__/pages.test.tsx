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

type Rows = Record<string, unknown>[];

const HOUR = 3_600_000;
const NOW = Date.now();

const PERSON = { devices: 3, first_seen: NOW - 30 * 24 * HOUR, last_seen: NOW - HOUR, newest_user_id: "usr_2", has_entries: true, has_metrics: true };

// Answers each statement by the table it reads. `mockAnswers` overrides one answer for a test.
const mockAnswers: { current: Partial<Record<string, Rows | Error>> } = { current: {} };
const mockSessionUser: { current: unknown } = { current: undefined };
const mockReads: SqlQuery[] = [];

function mockAnswer(query: SqlQuery): Rows {
  const key = query.text.includes("WITH hits")
    ? "search"
    : query.text.includes("has_entries")
      ? "person"
      : query.text.includes("FROM identity_graph WHERE canon_id = $1\nORDER BY")
        ? "identities"
        : query.text.includes("entries AS (")
          ? "entries"
          : query.text.includes("FROM campaign_nodes WHERE")
            ? "nodes"
            : query.text.includes("parent_event_timestamp")
              ? "waiting"
              : query.text.includes("FROM user_metrics m")
                ? "metrics"
                : query.text.includes("node_type = 'engagement'")
                  ? "messages"
                  : "other";
  const override = mockAnswers.current[key];
  if (override instanceof Error) throw override;
  if (override !== undefined) return override;
  switch (key) {
    case "person":
      return [PERSON];
    case "identities":
      return [{ domain_userid: "a1b2c3d4", user_id: "usr_2", first_seen: NOW - 2 * 24 * HOUR, last_seen: NOW - HOUR, total: 3 }];
    case "entries":
      return [
        { campaign_id: "CAMP-cart", entry_id: "e2", entered: NOW - 2 * HOUR, total: 1, campaign_name: "Cart abandonment", created_user: "u-lan", node_id: "n2", node_type: "check", written_at: NOW - 2 * HOUR },
      ];
    case "nodes":
      return [
        { campaign_id: "CAMP-cart", node_id: "n1", node_type: "setup", parent_node_id: null, parent_branch: null, trigger_json: '{"kind":"event","event":"add_to_cart"}' },
        { campaign_id: "CAMP-cart", node_id: "n2", node_type: "check", parent_node_id: "n1", parent_branch: "next", trigger_json: '{"event":"purchase"}' },
        { campaign_id: "CAMP-cart", node_id: "n4", node_type: "watch", parent_node_id: "n2", parent_branch: "yes", trigger_json: '{"event":"add_to_cart"}', paths_json: '{"limit":{"value":1,"unit":"DAYS"}}' },
      ];
    case "waiting":
      return [{ campaign_id: "CAMP-cart", entry_id: "e2", node_id: "n4", parent_event_timestamp: NOW - 2 * HOUR, children: [{ node_id: "n4", limit_millis: 24 * HOUR }] }];
    case "metrics":
      return [
        {
          metric_id: "m_count",
          series_clock: NOW - HOUR,
          buckets: [2, 3, 2].map((count, i) => ({ size: "HOUR", start: NOW - (5 - i) * HOUR, count })),
          event_name: "add_to_cart",
          agg_operator: "COUNT",
          agg_field: null,
          retention_ms: 30 * 24 * HOUR,
          processing_mode: "LIVE",
        },
      ];
    case "messages":
      return [
        { campaign_id: "CAMP-cart", entry_id: "e2", node_id: "n3", branch: "next", action_json: '{"type":"push","title":"Still thinking about it?"}', sent_at: NOW - 2 * HOUR, campaign_name: "Cart abandonment", total: 2 },
        { campaign_id: "CAMP-gone", entry_id: "first", node_id: "n9", branch: "next", action_json: '{"type":"sms","body":"Chào mừng đến Mộc Lan"}', sent_at: NOW - 48 * HOUR, campaign_name: null, total: 2 },
      ];
    default:
      return [];
  }
}

jest.mock("@/lib/db", () => ({
  getAdminUserById: async () => mockSessionUser.current,
  readOnly: async (_timeoutMs: number, work: (run: (query: SqlQuery) => Promise<Rows>) => unknown) =>
    work(async (query) => {
      mockReads.push(query);
      return mockAnswer(query);
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

async function html(element: ReactElement): Promise<{ html: string; errors: unknown[] }> {
  const errors: unknown[] = [];
  const stream = await renderToReadableStream(element, { onError: (error) => void errors.push(error) });
  await stream.allReady;
  return { html: await new Response(stream).text(), errors };
}

type SearchPage = (props: { searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
type ProfilePage = (props: { params: Promise<{ canonId: string }> }) => Promise<ReactElement>;

async function renderSearch(searchParams: Record<string, string> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded after the mocks
  const page: SearchPage = require("@/app/v2/customers/page").default;
  return html(await page({ searchParams: Promise.resolve(searchParams) }));
}

async function renderProfile(canonId = "P1") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded after the mocks
  const page: ProfilePage = require("@/app/v2/customers/[canonId]/page").default;
  return html(await page({ params: Promise.resolve({ canonId }) }));
}

const text = (markup: string) =>
  markup
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

beforeAll(() => {
  process.env.SESSION_SECRET = SECRET;
});

beforeEach(async () => {
  mockAnswers.current = {};
  mockReads.length = 0;
  mockCookieValues.clear();
  await signIn("editor");
});

describe("without a session", () => {
  it("sends the search and the profile to sign-in and reads nothing", async () => {
    mockCookieValues.clear();
    await expect(renderSearch({ q: "usr_1001" })).rejects.toThrow("NEXT_REDIRECT /login");
    await expect(renderProfile()).rejects.toThrow("NEXT_REDIRECT /login");
    expect(mockReads).toEqual([]);
  });
});

describe("/v2/customers (CUS-FR-01 to CUS-FR-03)", () => {
  const match = (canon_id: string, newest_user_id: string | null, devices: number) => ({ canon_id, newest_user_id, devices, first_seen: NOW - 24 * HOUR, last_seen: NOW - HOUR });

  it("runs the trimmed ?q= on load and opens the profile of the one match", async () => {
    mockAnswers.current = { search: [match("P1", "usr_1001", 2)] };
    await expect(renderSearch({ q: "  usr_1001 " })).rejects.toThrow("NEXT_REDIRECT /v2/customers/P1");
    expect(mockReads.map((query) => query.values)).toEqual([["usr_1001", ["usr_1001"]]]);
  });

  it("searches a phone's +84 and leading-0 forms as user ids, and a device id only as typed (CUS-FR-11)", async () => {
    await renderSearch({ q: "0912 345 678" });
    expect(mockReads.map((query) => query.values)).toEqual([["0912 345 678", ["0912 345 678", "+84912345678", "0912345678"]]]);
  });

  it("lists several people with the count, the newest user id, the devices, and an Open profile link each", async () => {
    mockAnswers.current = { search: [match("P7b", "usr_7", 2), match("P7 a", null, 1)] };
    const { html: markup } = await renderSearch({ q: "usr_7" });
    const page = text(markup);
    expect(page).toContain("2 customers match “usr_7”");
    expect(page).toContain("Anonymous visitor");
    expect(page).toMatch(/Customer Email Phone Devices Last seen Open/);
    expect(markup).toContain('href="/v2/customers/P7b"');
    expect(markup).toContain('href="/v2/customers/P7%20a"');
    expect(page.match(/Open profile/g)).toHaveLength(2);
  });

  it("says no customer matches, and names the text it looked for", async () => {
    const { html: markup } = await renderSearch({ q: "usr_100" });
    expect(text(markup)).toContain("No customer matches this search.");
    expect(text(markup)).toContain("Studio looked for “usr_100”");
  });

  it("asks for one shopper before a search, and searches nothing without a text", async () => {
    const { html: markup } = await renderSearch({ q: "   " });
    expect(mockReads).toEqual([]);
    expect(markup).toContain('name="q"');
    expect(text(markup)).toContain("Look up one shopper");
    expect(text(markup)).toContain("Search by id, email, phone or name");
    expect(text(markup)).toContain("What a profile shows");
  });
});

describe("/v2/customers/[canonId] (CUS-FR-04 to CUS-FR-10)", () => {
  it("shows the title, the person id, the devices, the identities, the journeys, and the metrics", async () => {
    const { html: markup, errors } = await renderProfile();
    const page = text(markup);
    expect(errors).toEqual([]);
    expect(markup).toMatch(/<h1[^>]*>usr_2<\/h1>/);
    expect(page).toContain("Person id P1 · 3 devices");
    expect(page).toContain("a1b2c3d4");
    expect(page).toContain("Cart abandonment");
    expect(page).toContain("Check: purchase");
    expect(page).toMatch(/Waiting at Wait for add_to_cart, 1 day until/);
    expect(page).toMatch(/add_to_cart .*number of times, last 30 days .*add_to_cart · COUNT/);
    expect(page).toMatch(/Journey entries 1 Waiting now 1/);
    expect(markup).toContain('href="#devices"');
    expect(markup).toContain('id="devices"');
  });

  it("lists the messages with the channel and title, the journey or Deleted journey, and Sent (CUS-FR-13)", async () => {
    const page = text((await renderProfile()).html);
    expect(page).toContain("Push “Still thinking about it?” Cart abandonment · Sent");
    expect(page).toContain("SMS “Chào mừng đến Mộc Lan” Deleted journey · Sent");
  });

  it("says no message was sent, and shows the timeline and segments as not available yet", async () => {
    mockAnswers.current = { messages: [] };
    const page = text((await renderProfile()).html);
    expect(page).toContain("No message sent to this shopper yet.");
    expect(page).toMatch(/Activity timeline Not available Studio does not keep each shopper's events yet/);
    expect(page).toMatch(/Segments .* Not available Studio does not store who is in each segment yet\./);
  });

  it("shows each region's empty text for a person with no identity, entry, or metric (CUS-FR-15)", async () => {
    mockAnswers.current = { identities: [], entries: [], metrics: [] };
    const page = text((await renderProfile()).html);
    expect(page).toContain("No device or account is joined to this shopper.");
    expect(page).toContain("This person has not entered a journey.");
    expect(page).toContain("No metric counts this person's behavior yet.");
  });

  it("titles a person with no user id Anonymous visitor", async () => {
    mockAnswers.current = { person: [{ ...PERSON, devices: 0, first_seen: null, last_seen: null, newest_user_id: null }] };
    const { html: markup } = await renderProfile();
    expect(markup).toMatch(/<h1[^>]*>Anonymous visitor<\/h1>/);
  });

  it("says no customer has the id when it appears nowhere, and loads no region", async () => {
    mockAnswers.current = { person: [{ ...PERSON, devices: 0, newest_user_id: null, has_entries: false, has_metrics: false }] };
    const { html: markup } = await renderProfile("nobody");
    expect(text(markup)).toContain("No customer has this id.");
    expect(markup).toContain('placeholder="Search by id, email, phone or name"');
    expect(mockReads).toHaveLength(1);
  });

  it("still shows the identities, the journeys, and the messages when the metrics fail", async () => {
    mockAnswers.current = { metrics: new Error("canceling statement due to statement timeout") };
    const { html: markup, errors } = await renderProfile();
    expect(errors).toHaveLength(1);
    expect(text(markup)).toContain("a1b2c3d4");
    expect(text(markup)).toContain("Cart abandonment");
    expect(text(markup)).toContain("Push “Still thinking about it?”");
  });

  it("reads Not available in the journey tiles when the journeys fail, and still shows the rest", async () => {
    mockAnswers.current = { entries: new Error("canceling statement due to statement timeout") };
    const { html: markup, errors } = await renderProfile();
    expect(errors).toHaveLength(1);
    expect(text(markup)).toMatch(/Journey entries Not available Waiting now Not available/);
    expect(text(markup)).toContain("a1b2c3d4");
  });

  it("opens for an editor who does not own the journey and links it to its analytics (CUS-FR-06, CUS-FR-09)", async () => {
    const { html: markup } = await renderProfile();
    expect(text(markup)).toContain("Cart abandonment");
    expect(markup).toContain('href="/v2/journeys/CAMP-cart"');
    expect(markup).not.toContain('href="/campaign/CAMP-cart"');
  });

  it("shows no imported record and no contact value, since no customer list is imported (CUS-FR-10)", async () => {
    const page = text((await renderProfile()).html);
    expect(page).not.toContain("Customer records");
    expect(page).not.toMatch(/Reveal|Loyalty|@/);
  });

  it("logs no search text or person id at info level or above (CUS-NFR-03)", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((level) => jest.spyOn(console, level).mockImplementation(() => {}));
    try {
      mockAnswers.current = { search: [] };
      await renderSearch({ q: "usr_1001" });
      mockAnswers.current = {};
      await renderProfile("P1");
      const logged = spies.flatMap((spy) => spy.mock.calls.flat().map(String)).join("\n");
      expect(logged).not.toMatch(/usr_1001|P1/);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
