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
const mockPreview = { current: true };
const mockCatalog: { current: Error | null } = { current: null };
const mockCatalogReads = { count: 0 };

jest.mock("@/lib/db", () => ({
  getAdminUserById: async () => mockSessionUser.current,
  getSystemUserPreview: async () => mockPreview.current,
  readOnly: async () => {
    throw new Error("The page reads only through its loaders.");
  },
}));

function mockEvent(name: string, extra: Record<string, unknown> = {}) {
  return {
    id: name,
    name,
    label: name,
    description: null,
    kind: "person",
    status: "active",
    gate: false,
    attributeCount: 0,
    requiredCount: 0,
    createdAt: null,
    attributes: [],
    ...extra,
  };
}

const mockVolumes: { current: Error | unknown[] } = { current: [] };
const mockVolumeZones: string[] = [];
jest.mock("../../../../../src/features/data-health/model/volumeServer", () => ({
  loadEventVolumes: async (_names: unknown, _window: unknown, zone: string) => {
    mockVolumeZones.push(zone);
    if (mockVolumes.current instanceof Error) throw mockVolumes.current;
    return mockVolumes.current;
  },
}));

jest.mock("../../../../../src/features/data-health/model/catalogServer", () => ({
  loadCatalogPage: async (query: { search: string }) => {
    mockCatalogReads.count += 1;
    if (mockCatalog.current) throw mockCatalog.current;
    const cart = mockEvent("com.acme/add_to_cart", {
      label: "Added to cart",
      gate: true,
      requiredCount: 1,
      attributes: [{ path: "product.id", type: "string", required: true, example: "SP-1" }],
    });
    if (query.search === "com.acme/add_to_cart") return { events: [cart], catalogSize: 2, matching: 1, page: 1, pageCount: 1 };
    if (query.search !== "") return { events: [], catalogSize: 2, matching: 0, page: 1, pageCount: 1 };
    const purchase = mockEvent("purchase", { kind: "business", label: "Purchase" });
    return { events: [cart, purchase], catalogSize: 2, matching: 2, page: 1, pageCount: 1 };
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

async function renderTracking(): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded after the mocks
  const page: () => Promise<ReactElement> = require("@/app/v2/data/tracking/page").default;
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

beforeAll(() => {
  process.env.SESSION_SECRET = SECRET;
});

beforeEach(() => {
  mockCookieValues.clear();
  mockCatalog.current = null;
  mockCatalogReads.count = 0;
  mockVolumes.current = [];
  mockVolumeZones.length = 0;
  mockPreview.current = true;
  process.env.OIDC_REDIRECT_URL = "https://studio.example.com/api/auth/oidc/callback";
});

describe("/v2/data/tracking (DHL-FR-15, DHL-FR-16)", () => {
  it("sends a visitor without a session to sign in and reads nothing", async () => {
    mockSessionUser.current = undefined;

    await expect(renderTracking()).rejects.toThrow("NEXT_REDIRECT /login");
    expect(mockCatalogReads.count).toBe(0);
  });

  it("gives a staff user without preview access the not-found page while the route is at preview (SHL-FR-22)", async () => {
    await signIn("editor");
    mockPreview.current = false;

    await expect(renderTracking()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockCatalogReads.count).toBe(0);
  });

  it("shows a preview editor every step and the editor note, with no link to Sources", async () => {
    await signIn("editor");

    const html = await renderTracking();

    expect(text(html)).toContain("Tracking setup Preview");
    expect(text(html)).toContain("Only admins can create the keys that servers need.");
    expect(text(html)).toContain("Install the tracker");
    expect(html).not.toContain('href="/v2/data/sources"');
  });

  it("lists the catalog as the tracking plan, with how each event is checked", async () => {
    await signIn("admin");

    const html = await renderTracking();

    expect(text(html)).toContain("2 events");
    expect(text(html)).toContain("Added to cart Strict · 1 must be sent com.acme/add_to_cart");
    expect(text(html)).toContain("Purchase From the server purchase");
    expect(text(html)).toContain("See all 2 in Events");
    expect(html).toContain('href="/v2/data/sources"');
  });

  it("shows the sample event's fields from the catalog and a placeholder collector address, since no setting names it", async () => {
    await signIn("admin");

    const html = text(await renderTracking());

    expect(html).toContain("product.id string Yes SP-1");
    expect(html).toContain("https://&lt;collector address&gt;");
    expect(html).toContain("Studio does not know it yet.");
    expect(html).not.toContain("product.name:");
  });

  it("shows when each sample event was last seen, and Not yet for one never counted (DHL-FR-14)", async () => {
    await signIn("admin");
    mockVolumes.current = [
      { eventName: "com.acme/product_viewed", accepted: 3, dropped: 0, droppedByReason: {}, daily: [], lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString(), arrival: "receiving" },
      { eventName: "com.acme/add_to_cart", accepted: 0, dropped: 0, droppedByReason: {}, daily: [], lastSeenAt: null, arrival: "never" },
    ];

    const raw = await renderTracking();
    const html = text(raw);

    expect(raw).toContain('href="/v2/data/monitoring"');
    expect(html).toContain("Last seen 5 min ago");
    expect(html).toContain("Not yet");
  });

  it("counts the live check's Today in the viewer's zone from the tz cookie (SHL-FR-15)", async () => {
    await signIn("admin");
    mockCookieValues.set("tz", "America/New_York");

    await renderTracking();

    expect(mockVolumeZones).toEqual(["America/New_York"]);
  });

  it("shows the live check's error, not a guess, when event volume cannot load", async () => {
    await signIn("admin");
    mockVolumes.current = new Error("timeout");

    const html = text(await renderTracking());

    // The server hands a failed region to the client, which shows its error with a retry.
    expect(html).not.toContain("Last seen");
    expect(html).not.toContain("timeout");
    expect(html).toContain("Open Monitoring to see your events arrive");
  });

  it("keeps the guide when the catalog cannot load, without the server's error text", async () => {
    await signIn("admin");
    mockCatalog.current = new Error("timeout at 10.0.0.5");

    const html = text(await renderTracking());

    expect(html).toContain("Install the tracker");
    expect(html).not.toContain("10.0.0.5");
  });
});
