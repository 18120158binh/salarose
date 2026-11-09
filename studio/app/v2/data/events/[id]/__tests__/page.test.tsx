/** @jest-environment node */
import { renderToStaticMarkup } from "react-dom/server";
import type { SystemUser } from "@/lib/db";
import { signSessionToken } from "@/shared/auth/sessionToken";

jest.mock("server-only", () => ({}));

import { TZ_COOKIE } from "@/shared/lib/time-range";

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
  notFound: jest.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
}));

const mockSessionUser: { current: unknown } = { current: undefined };
const mockPreview = { on: false };
const mockEvent: { row: Record<string, unknown> | null } = { row: null };
jest.mock("@/lib/db", () => ({
  getAdminUserById: async () => mockSessionUser.current,
  getSystemUserPreview: async () => mockPreview.on,
  readOnly: jest.fn(async (_timeout: number, work: (run: (query: { text: string }) => Promise<unknown[]>) => Promise<unknown>) =>
    work(async (query) => {
      if (query.text.includes("FROM user_events WHERE id")) return mockEvent.row === null ? [] : [mockEvent.row];
      if (query.text.includes("FROM user_event_fields")) {
        return [
          { field_path: "product", display_name: "Product", data_type: "json", required: false, example_value: null, default_value: null },
          { field_path: "product.price", display_name: "Price", data_type: "number", required: true, example_value: "1290000", default_value: null },
        ];
      }
      return [];
    }),
  ),
  getUserEventUsage: jest.fn(async () => ({
    metrics: [{ id: "m1", displayName: "Cart value, last 30 days", measure: "Sum of product.price" }],
    metricCampaigns: [{ id: "c2", name: "Voucher nudge", status: "paused" }, { id: "c1", name: "Cart abandonment", status: "active" }],
    conditionCampaigns: [
      { id: "c1", name: "Cart abandonment", status: "active" },
      { id: "c3", name: "Áo dài upsell", status: "draft" },
    ],
  })),
  getUserEventSegments: jest.fn(async () => [
    { id: "SEG-1", name: "Big carts", description: "A cart item over 2,000,000 ₫" },
    { id: "SEG-2", name: "Cart lovers", description: "" },
  ]),
  getUserEventFieldUses: jest.fn(async () => ({
    "product.price": { metrics: [{ id: "m1", displayName: "Cart value, last 30 days" }], campaigns: [], segments: [] },
  })),
}));

import { getUserEventUsage, readOnly } from "@/lib/db";
import { SESSION_COOKIE } from "@/shared/auth/constants";
import V2EventDetailPage from "../page";

const SECRET = "test-session-secret-0123456789-abcdef";
const ADDED_TO_CART = {
  id: "ue_1",
  event_name: "add_to_cart",
  display_name: "Added to cart",
  description: "A shopper adds a product to the cart.",
  kind: "person",
  item_key: null,
  status: "inactive",
  enforce_schema: true,
  created_at: new Date("2026-10-14T03:00:00Z"),
};

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

const page = async (id = "ue_1") => renderToStaticMarkup(await V2EventDetailPage({ params: Promise.resolve({ id }) }));

beforeAll(() => {
  process.env.SESSION_SECRET = SECRET;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockCookieValues.clear();
  mockSessionUser.current = undefined;
  mockPreview.on = false;
  mockEvent.row = ADDED_TO_CART;
});

describe("/v2/data/events/[id] (CAT-FR-10, CAT-FR-20)", () => {
  it("sends a visitor with no session to sign-in and reads nothing", async () => {
    await expect(page()).rejects.toThrow("NEXT_REDIRECT /login");
    expect(readOnly).not.toHaveBeenCalled();
    expect(getUserEventUsage).not.toHaveBeenCalled();
  });

  it("shows an editor the event, its fields and its uses read-only", async () => {
    await signIn("editor");

    const html = await page();

    expect(html).toContain("Only admins can change it.");
    expect(html).toContain("com.acme/add_to_cart");
    expect(html).toContain("Hidden from builder");
    expect(html).toContain("Strict");
    expect(html).toContain("In use · ");
    expect(html).toContain("Cart abandonment");
    expect(html).toContain("Big carts");
    expect(html).toContain("&quot;price&quot;: 1290000");
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain("Add field");
    expect(html).not.toContain("Delete event");
    expect(html).not.toContain("Edit name and description");
  });

  it("gives each use a second line from its data, and each journey its status with an icon (CAT-FR-20)", async () => {
    await signIn("editor");

    const html = await page();

    expect(html).toContain("Cart abandonment</span><span class=\"block text-muted-foreground text-xs\">A step waits for this event · A step checks a metric on this event</span>");
    expect(html).toContain("Voucher nudge</span><span class=\"block text-muted-foreground text-xs\">A step checks a metric on this event</span>");
    expect(html).toContain("Cart value, last 30 days</span><span class=\"block text-muted-foreground text-xs\">Sum of product.price</span>");
    expect(html).toContain("Big carts</span><span class=\"block text-muted-foreground text-xs\">A cart item over 2,000,000 ₫</span>");
    expect(html).toContain("Cart lovers</span></li>");
    expect(html).toMatch(/text-warning[^>]*><svg[^]*?<\/svg>Paused/);
    expect(html).toMatch(/text-muted-foreground[^>]*><svg[^]*?<\/svg>Draft/);
    expect(html).not.toContain(">draft<");
  });

  it("dates Added in the viewer's time zone (SHL-FR-15)", async () => {
    await signIn("admin");
    expect(await page()).toContain("Added 14 Oct 2026");

    mockCookieValues.set(TZ_COOKIE, "America/Los_Angeles");
    expect(await page()).toContain("Added 13 Oct 2026");
  });

  it("offers an admin the switches, Add field, Edit, and Retire or delete", async () => {
    await signIn("admin");

    const html = await page();

    expect(html).toContain('role="switch"');
    expect(html).toContain("Add field");
    expect(html).toContain("Edit name and description");
    expect(html).toContain("Retire or delete");
    expect(html).not.toContain("Only admins can change it.");
  });

  it("links Monitoring only once the viewer may open it, and never to a classic page", async () => {
    await signIn("editor");
    expect(await page()).not.toContain("See this event in Monitoring");

    mockPreview.on = true;
    const html = await page();
    expect(html).toContain('href="/v2/data/monitoring"');
    expect(html).toContain('href="/v2/data/metrics"');
  });

  it("says the event is not in the catalog for an unknown id, and reads no uses", async () => {
    await signIn("admin");
    mockEvent.row = null;

    const html = await page("ue_gone");

    expect(html).toContain("This event is not in the catalog.");
    expect(getUserEventUsage).not.toHaveBeenCalled();
  });
});
