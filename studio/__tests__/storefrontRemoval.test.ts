/** @jest-environment node */

// The removed storefront app left mock shopper sessions, a mailbox, and an event log behind in
// studio. Studio shows only staff data (USR-NFR-01), and every exported server action is
// callable directly (AUTH-FR-07). These tests load the pages and call every exported server
// action against a pg Pool fake that records each statement, and check that nothing reads or
// writes the storefront tables or the storefront cookie.
import type { AdminSession } from "@/shared/auth/types";

const mockStatements: string[] = [];
const mockCookieWrites: string[] = [];
let mockSession: AdminSession | null = null;

jest.mock("server-only", () => ({}));
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }));
jest.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => undefined,
    set: (name: string) => mockCookieWrites.push(`set ${name}`),
    delete: (name: string) => mockCookieWrites.push(`delete ${name}`),
  }),
}));
jest.mock("@/shared/auth/session", () => {
  const signedIn = async () => {
    if (!mockSession) throw new Error("Unauthorized");
    return mockSession;
  };
  const admin = async () => {
    if (mockSession?.role !== "admin") throw new Error("Only admin users can do this.");
    return mockSession;
  };
  return { assertSession: signedIn, requireSession: signedIn, assertAdmin: admin, requireAdmin: admin };
});
// The pages hand their data to client components, which this test does not render.
jest.mock("@/app/admin/AdminPageClient", () => () => null);
jest.mock("@/app/campaign/CampaignPageClient", () => () => null);
jest.mock("@/app/campaign/[id]/CampaignBuilderPageClient", () => () => null);

jest.mock("../../shared/node_modules/pg", () => {
  const query = async (text: string) => {
    mockStatements.push(text.replace(/\s+/g, " ").trim());
    return { rows: [], rowCount: 0 };
  };
  return {
    Pool: jest.fn().mockImplementation(() => ({
      query,
      connect: async () => ({ query, release: () => undefined }),
    })),
  };
});

import * as actions from "@/app/actions";
import AdminRoute from "@/app/admin/AdminRoute";
import CampaignsPage from "@/app/campaign/page";
import CampaignDetailPage from "@/app/campaign/[id]/page";

const editor: AdminSession = { userId: "user_lan", email: "lan@example.com", role: "editor" };
const admin: AdminSession = { userId: "user_admin", email: "admin@example.com", role: "admin" };

const STOREFRONT_TABLE = /\b(mailbox|event_logs)\b/;

beforeAll(() => {
  process.env.DATABASE_URL = "postgres://test";
  // The actions log each argument they reject.
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

beforeEach(() => {
  mockStatements.length = 0;
  mockCookieWrites.length = 0;
});

describe("studio pages", () => {
  it("load catalog and campaign data and nothing from the storefront tables", async () => {
    mockSession = admin;

    await AdminRoute();
    await CampaignsPage();
    await CampaignDetailPage({ params: Promise.resolve({ id: "c_lan" }) });

    expect(mockStatements.some((text) => text.includes("FROM user_events"))).toBe(true);
    expect(mockStatements.some((text) => text.includes("FROM campaigns"))).toBe(true);
    expect(mockStatements.filter((text) => STOREFRONT_TABLE.test(text))).toEqual([]);
  });
});

describe("exported server actions", () => {
  it.each([
    ["an editor", editor],
    ["an admin", admin],
  ])("called directly by %s, touch no storefront table and no cookie", async (_, session) => {
    mockSession = session;

    for (const action of Object.values(actions)) {
      if (typeof action !== "function") continue;
      try {
        await (action as () => Promise<unknown>)();
      } catch {
        // An action may reject arguments it was not given. Only its statements matter here.
      }
    }

    expect(mockStatements.some((text) => text.includes("FROM user_events"))).toBe(true);
    expect(mockStatements.filter((text) => STOREFRONT_TABLE.test(text))).toEqual([]);
    expect(mockCookieWrites).toEqual([]);
  });
});
