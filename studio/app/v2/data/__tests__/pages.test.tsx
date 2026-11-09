/** @jest-environment node */
import type { ReactElement } from "react";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
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
  headers: async () => new Headers(),
}));

jest.mock("next/navigation", () => ({
  redirect: jest.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
}));

const mockSessionUser: { current: unknown } = { current: undefined };
const mockStatements: string[] = [];
const mockUses = { metrics: [] as { id: string; displayName: string }[], metricCampaigns: [] as unknown[], conditionCampaigns: [] as unknown[] };
jest.mock("@/lib/db", () => ({
  getAdminUserById: async () => mockSessionUser.current,
  readOnly: jest.fn(),
  getUserEventUsage: jest.fn(async () => mockUses),
  getUserEventSegments: jest.fn(async () => []),
  getSystemUserPreview: jest.fn(async () => false),
  getUserEventFieldUses: jest.fn(async () => ({})),
}));

const mockDropped = jest.fn(async (): Promise<number> => 0);
jest.mock("../../../../src/features/data-health/model/deadLetterServer", () => ({ deadLetterReader: () => ({ droppedCount: mockDropped }) }));

import { getUserEventFieldUses, getUserEventSegments, getUserEventUsage, readOnly } from "@/lib/db";
import { SESSION_COOKIE } from "@/shared/auth/constants";
import { loadCatalogPage, loadSourceKeys } from "@/features/data-health/model/catalogServer";
import { DEFAULT_CATALOG_QUERY } from "@/features/data-health/model/catalog";
import { loadEventDetail } from "@/features/event-management/model/eventDetailServer";
import V2EventDetailPage from "../events/[id]/page";
import V2EventsPage from "../events/page";
import V2SourcesPage from "../sources/page";

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

const ADD_TO_CART = {
  id: "ue_1",
  event_name: "add_to_cart",
  display_name: "Add to cart",
  description: null,
  kind: "person",
  item_key: null,
  status: "active",
  enforce_schema: false,
};
const mockEvent: { row: Record<string, unknown> | null } = { row: ADD_TO_CART };
const mockListed: { events: Record<string, unknown>[]; keys: Record<string, unknown>[] } = { events: [], keys: [] };

const mockHealth: { events: unknown[]; rows: unknown[]; lastSeen: unknown[] } = { events: [], rows: [], lastSeen: [] };

const run = jest.fn(async (query: { text: string }) => {
  mockStatements.push(query.text);
  if (query.text.includes("catalog_size")) return [{ catalog_size: mockListed.events.length, matching: mockListed.events.length }];
  if (query.text.includes("attribute_count")) return mockListed.events;
  if (query.text.includes("AS label FROM user_events")) return mockHealth.events;
  if (query.text.includes("max(last_seen_at)")) return mockHealth.lastSeen;
  if (query.text.includes("FROM event_volume")) return mockHealth.rows;
  if (query.text.includes("FROM ingestion_source_keys")) return mockListed.keys;
  if (query.text.includes("FROM user_events WHERE id")) return mockEvent.row === null ? [] : [mockEvent.row];
  if (query.text.includes("FROM user_event_fields")) {
    return [
      { field_path: "product", display_name: "Product", data_type: "json", required: false, example_value: null, default_value: null },
      { field_path: "product.price", display_name: "Price", data_type: "number", required: true, example_value: "1", default_value: "0" },
    ];
  }
  return [];
});

// The regions load inside Suspense, so the page is streamed until every region is ready.
async function streamed(element: ReactElement): Promise<string> {
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  return new Response(stream).text();
}

const detailPage = (id = "ue_1") => V2EventDetailPage({ params: Promise.resolve({ id }) });

// Studio parses the dashboards once per process, on the first request.
beforeAll(() => {
  process.env.SESSION_SECRET = SECRET;
  process.env.PIPELINE_DASHBOARDS = '[{"name":"Flink jobs","url":"https://grafana.example.com/d/flink"}]';
});

afterAll(() => {
  delete process.env.PIPELINE_DASHBOARDS;
});

beforeEach(() => {
  mockCookieValues.clear();
  mockStatements.length = 0;
  mockEvent.row = ADD_TO_CART;
  mockListed.events = [];
  mockListed.keys = [];
  mockHealth.events = [];
  mockHealth.rows = [];
  mockHealth.lastSeen = [];
  mockDropped.mockReset().mockResolvedValue(0);
  mockUses.metrics = [];
  jest.mocked(getUserEventUsage).mockClear();
  jest.mocked(getUserEventSegments).mockResolvedValue([]);
  jest.mocked(getUserEventFieldUses).mockResolvedValue({});
  run.mockClear();
  jest.mocked(readOnly).mockReset();
  jest.mocked(readOnly).mockImplementation(async (_timeout, work) => work(run as never));
});

// The SESSION RULE on #292: a visitor with no session, or a signed cookie whose user is gone,
// goes to sign-in, and no loader reads the database.
describe.each([
  ["no session cookie", async () => {}],
  ["a signed cookie for a deleted user", async () => {
    await signIn("admin");
    mockSessionUser.current = undefined;
  }],
])("with %s", (_case, arrange) => {
  beforeEach(arrange);

  it("sends /v2/data/events to sign-in and reads nothing", async () => {
    await expect(V2EventsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_REDIRECT /login");
    expect(readOnly).not.toHaveBeenCalled();
  });

  it("sends /v2/data/sources to sign-in and reads nothing", async () => {
    await expect(V2SourcesPage()).rejects.toThrow("NEXT_REDIRECT /login");
    expect(readOnly).not.toHaveBeenCalled();
  });

  it("sends /v2/data/events/[id] to sign-in and reads nothing", async () => {
    await expect(detailPage()).rejects.toThrow("NEXT_REDIRECT /login");
    expect(readOnly).not.toHaveBeenCalled();
    expect(getUserEventUsage).not.toHaveBeenCalled();
  });

  it("refuses the catalog, event detail, and source key loaders before they read", async () => {
    await expect(loadCatalogPage(DEFAULT_CATALOG_QUERY)).rejects.toThrow("NEXT_REDIRECT /login");
    await expect(loadEventDetail("ue_1")).rejects.toThrow("NEXT_REDIRECT /login");
    await expect(loadSourceKeys()).rejects.toThrow("NEXT_REDIRECT /login");
    expect(readOnly).not.toHaveBeenCalled();
    expect(getUserEventUsage).not.toHaveBeenCalled();
  });
});

describe("/v2/data/events (CAT-FR-10, DHL-FR-01)", () => {
  it("counts receiving and quiet events and the records dropped in 24 hours in the Data health strip (DHL-FR-01, DHL-FR-14)", async () => {
    await signIn("editor");
    const now = Date.now();
    mockHealth.events = [
      { id: "ue_1", event_name: "add_to_cart", label: "Add to cart" },
      { id: "ue_2", event_name: "wishlist_added", label: "Wishlist added" },
    ];
    mockHealth.rows = [{ event_name: "add_to_cart", bucket_start: new Date(Math.floor(now / 3_600_000) * 3_600_000), outcome: "accepted", count: 4 }];
    mockHealth.lastSeen = [
      { event_name: "add_to_cart", last_seen_at: new Date(now) },
      { event_name: "wishlist_added", last_seen_at: new Date(now - 20 * 86_400_000) },
    ];
    mockDropped.mockResolvedValue(38);

    const html = (await streamed(await V2EventsPage({ searchParams: Promise.resolve({}) }))).replace(/<!-- -->/g, "");

    expect(html).toMatch(/>1<\/span> receiving/);
    expect(html).toMatch(/>1<\/span> quiet/);
    expect(html).toMatch(/>38<\/span> dropped in 24 h/);
    expect(mockDropped).toHaveBeenCalledWith(86_400_000);
    expect(html).not.toContain("coming later");
  });

  it("shows the strip's error, not zeros, when event volume cannot load (DHL-FR-14)", async () => {
    await signIn("editor");
    jest.mocked(readOnly).mockImplementation(async (_timeout, work) =>
      work((async (query: { text: string }) => {
        if (query.text.includes("AS label FROM user_events")) throw new Error("timeout");
        return run(query);
      }) as never),
    );

    const html = await streamed(await V2EventsPage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain("Switched to client rendering");
    expect(html).not.toContain("receiving");
  });

  it("renders for an editor, with no forbidden state", async () => {
    await signIn("editor");

    const html = renderToStaticMarkup(await V2EventsPage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain("Events");
    expect(html).not.toContain("This page is for admins.");
  });

  it("offers Add event to an admin and not to an editor (CAT-FR-10)", async () => {
    await signIn("editor");
    expect(renderToStaticMarkup(await V2EventsPage({ searchParams: Promise.resolve({}) }))).not.toContain("Add event");

    await signIn("admin");
    expect(renderToStaticMarkup(await V2EventsPage({ searchParams: Promise.resolve({}) }))).toContain("Add event");
  });

  it("tells an editor the page is read-only, and links every viewer to Monitoring (DHL-FR-01)", async () => {
    await signIn("editor");
    const editor = renderToStaticMarkup(await V2EventsPage({ searchParams: Promise.resolve({}) }));
    expect(editor).toContain("Only admins can add or change events.");
    expect(editor).toContain('href="/v2/data/monitoring"');
    expect(editor).not.toContain("How to send events");

    await signIn("admin");
    const admin = renderToStaticMarkup(await V2EventsPage({ searchParams: Promise.resolve({}) }));
    expect(admin).not.toContain("Only admins can add or change events.");
    expect(admin).toContain('href="/v2/data/monitoring"');
    expect(admin).toContain("Preview");
  });
});

// DHL-FR-12: every read of the data pages runs in a read-only transaction and only selects.
describe("data page reads (DHL-FR-12)", () => {
  it("reads the catalog through read-only SELECT statements", async () => {
    await signIn("editor");

    await loadCatalogPage(DEFAULT_CATALOG_QUERY);

    expect(readOnly).toHaveBeenCalled();
    expect(mockStatements.length).toBeGreaterThan(0);
    for (const text of mockStatements) expect(text.trimStart()).toMatch(/^SELECT /);
  });

  it("refuses an editor's source key read without touching the database", async () => {
    await signIn("editor");

    await expect(loadSourceKeys()).rejects.toThrow("Source keys are for admins.");
    expect(readOnly).not.toHaveBeenCalled();
  });

  it("reads the source keys for an admin through one read-only SELECT", async () => {
    await signIn("admin");

    await loadSourceKeys();

    expect(readOnly).toHaveBeenCalledTimes(1);
    expect(mockStatements).toHaveLength(1);
    expect(mockStatements[0]).toMatch(/^SELECT /);
  });
});

describe("/v2/data/events/[id] (CAT-FR-10, DHL-FR-02)", () => {
  it.each(["admin", "editor"] as const)("shows a business event's kind and item key read-only to an %s (CAT-FR-18)", async (role) => {
    await signIn(role);
    mockEvent.row = { ...ADD_TO_CART, id: "ue_2", event_name: "price_drop", display_name: "Price drop", kind: "business", item_key: "product.id" };

    const html = renderToStaticMarkup(await detailPage("ue_2"));

    expect(html).toContain("Business");
    expect(html).toContain("Item key");
    expect(html).toContain("product.id");
    expect(html).not.toContain('role="radio"');
  });

  it("says the event is not in the catalog for an unknown id, and reads no uses", async () => {
    await signIn("admin");
    mockEvent.row = null;

    const html = renderToStaticMarkup(await detailPage("ue_gone"));

    expect(html).toContain("This event is not in the catalog.");
    expect(getUserEventUsage).not.toHaveBeenCalled();
  });

  it("reads the event through read-only SELECT statements (DHL-FR-12)", async () => {
    await signIn("editor");

    await loadEventDetail("ue_1");

    expect(readOnly).toHaveBeenCalledTimes(1);
    expect(mockStatements.length).toBeGreaterThan(0);
    for (const text of mockStatements) expect(text.trimStart()).toMatch(/^SELECT /);
  });
});

describe("/v2/data/sources (DHL-FR-04)", () => {
  it("offers an admin Create key", async () => {
    await signIn("admin");

    const html = renderToStaticMarkup(await V2SourcesPage());

    expect(html).toContain("Create key");
  });
});

describe("the data pages' rows (DHL-FR-02, DHL-FR-04)", () => {
  const listedEvent = { id: "ue_1", event_name: "add_to_cart", label: "Add to cart", kind: "person", status: "active", enforce_schema: false };

  it("links an admin's event row to its detail page, and not an editor's", async () => {
    mockListed.events = [listedEvent];

    await signIn("admin");
    expect(await streamed(await V2EventsPage({ searchParams: Promise.resolve({}) }))).toContain('href="/v2/data/events/ue_1"');

    await signIn("editor");
    const editor = await streamed(await V2EventsPage({ searchParams: Promise.resolve({}) }));
    expect(editor).toContain("add_to_cart");
    expect(editor).not.toContain('href="/v2/data/events/ue_1"');
  });

  it("offers the row menu to an admin only, and shows Used by as not available yet (CAT-FR-10, DHL-FR-01)", async () => {
    mockListed.events = [listedEvent];

    await signIn("admin");
    const admin = await streamed(await V2EventsPage({ searchParams: Promise.resolve({}) }));
    expect(admin).toContain("More actions for Add to cart");
    expect(admin).toContain("Coming later");

    await signIn("editor");
    expect(await streamed(await V2EventsPage({ searchParams: Promise.resolve({}) }))).not.toContain("More actions for");
  });

  it("offers Revoke on an active source key only", async () => {
    await signIn("admin");
    mockListed.keys = [
      { id: "k-1", app_id: "crm", key_hint: "cdp_sk_Ef56", created_by_email: null, created_at: "2026-11-02T10:00:00Z", revoked_at: null },
      { id: "k-2", app_id: "inventory", key_hint: "cdp_sk_Ab12", created_by_email: null, created_at: "2026-10-01T08:00:00Z", revoked_at: "2026-10-20T09:30:00Z" },
    ];

    const html = await streamed(await V2SourcesPage());

    expect(html).toContain("inventory");
    expect(html).toContain('aria-label="Revoke the key for crm"');
    expect(html).not.toContain("Revoke the key for inventory");
  });
});
