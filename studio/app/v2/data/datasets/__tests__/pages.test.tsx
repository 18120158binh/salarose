/** @jest-environment node */
import type { ReactElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import type { SqlQuery } from "@/lib/db";
import { SESSION_COOKIE } from "@/shared/auth/constants";
import { signSessionToken } from "@/shared/auth/sessionToken";

jest.mock("server-only", () => ({}));
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }));

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
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn(), replace: jest.fn() }),
}));

type Rows = Record<string, unknown>[];
const mockSessionUser: { current: unknown } = { current: undefined };
const mockPreview: { current: boolean } = { current: true };
const mockReads: SqlQuery[] = [];
const mockDatasets: { current: Rows } = { current: [] };
jest.mock("@/lib/db", () => ({
  getAdminUserById: async () => mockSessionUser.current,
  getSystemUserPreview: async () => mockPreview.current,
  inTransaction: jest.fn(),
  readOnly: async (_timeoutMs: number, work: (run: (query: SqlQuery) => Promise<Rows>) => unknown) =>
    work(async (query) => {
      mockReads.push(query);
      if (query.text.includes("count(*)::int AS held")) return [{ held: 1 }];
      if (query.text.includes("FROM import_metric_passes")) return [{ finished_at: null }];
      if (query.text.includes("FROM import_record_type_versions v")) return [STORED];
      if (query.text.includes("FROM import_metric_definitions")) return [{ id: "m1", name: "spend_90d", column: "total", filters: [] }];
      if (query.text.includes("FROM import_record_types t")) return mockDatasets.current;
      return [];
    }),
}));

const SECRET = "test-session-secret-0123456789-abcdef";
const ID = "5f0c8a2e-1b7d-4c39-9a51-2d3e4f5a6b7c";

const STORED = {
  version: 2,
  columns: [
    { name: "order_id", displayName: "Order ID", type: "string", pii: false, aliases: ["ma_don"] },
    { name: "customer_id", displayName: "Customer ID", type: "string", pii: false, aliases: [] },
    { name: "created_at", displayName: "Order time", type: "datetime", pii: false, aliases: [] },
    { name: "total", displayName: "Order total", type: "number", pii: false, aliases: [] },
  ],
  roles: { customer_key: "customer_id", record_id: "order_id", event_time: "created_at" },
  delivery_mode: "incremental",
  time_zone: "UTC",
  delimiter: ",",
  created_at: new Date(0),
  created_by_email: "admin@example.com",
};

const ORDERS = {
  id: ID,
  name: "orders",
  display_name: "Orders",
  kind: "event",
  current_version: 2,
  delivery_mode: "incremental",
  run_state: "applied",
  run_source: "api",
  run_writer: "erp-nightly",
  run_created_at: new Date(0),
  run_counts: { match_rate: 0.03 },
};

async function signIn(role: "admin" | "editor"): Promise<void> {
  mockSessionUser.current = { id: `user-${role}`, email: `${role}@example.com`, role, session_epoch: 0 };
  const token = await signSessionToken(
    { userId: `user-${role}`, email: `${role}@example.com`, epoch: 0, providerId: "default" },
    new TextEncoder().encode(SECRET),
    3600,
  );
  mockCookieValues.set(SESSION_COOKIE, token);
}

async function render(element: Promise<ReactElement | null>): Promise<string> {
  const errors: unknown[] = [];
  const stream = await renderToReadableStream(await element, { onError: (error) => void errors.push(error) });
  await stream.allReady;
  const html = await new Response(stream).text();
  if (errors.length > 0) throw errors[0];
  return html.replace(/<[^>]+>/g, " ").replace(/<!-- -->/g, "").replace(/\s+/g, " ");
}

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the mocks */
const listPage = (kind?: string) =>
  require("../page").default({ searchParams: Promise.resolve(kind ? { kind } : {}) }) as Promise<ReactElement>;
const detailPage = (id: string) => require("../[id]/page").default({ params: Promise.resolve({ id }) }) as Promise<ReactElement>;
const newPage = () => require("../new/page").default() as Promise<ReactElement>;
/* eslint-enable @typescript-eslint/no-require-imports */

beforeAll(() => {
  process.env.SESSION_SECRET = SECRET;
});

beforeEach(() => {
  mockCookieValues.clear();
  mockSessionUser.current = undefined;
  mockPreview.current = true;
  mockReads.length = 0;
  mockDatasets.current = [ORDERS];
});

describe("without a session (DIM-FR-25)", () => {
  it.each([
    ["the list", () => listPage()],
    ["the editor", () => detailPage(ID)],
    ["the create page", () => newPage()],
  ])("%s redirects to sign-in and reads nothing", async (_name, page) => {
    await expect(page()).rejects.toThrow("NEXT_REDIRECT");
    expect(mockReads).toEqual([]);
  });
});

describe("Datasets list", () => {
  it("is not found for a staff user without preview (SHL-FR-22)", async () => {
    await signIn("editor");
    mockPreview.current = false;
    await expect(listPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockReads).toEqual([]);
  });

  it("shows an editor every dataset, without admin controls", async () => {
    await signIn("editor");
    const html = await render(listPage());
    expect(html).toContain("Orders");
    expect(html).toContain("Only admins can create, change or upload.");
    expect(html).not.toContain("New dataset");
  });

  it("shows the run state, the match rate with its warning, and no made-up stored rows (DIM-FR-24)", async () => {
    await signIn("admin");
    const html = await render(listPage());
    expect(html).toContain("New dataset");
    expect(html).toContain("Applied");
    expect(html).toContain("3%");
    expect(html).toContain("Key may be the wrong column");
    expect(html).toContain("Not available");
    expect(html).toContain("No nightly pass has finished yet.");
  });

  it("filters by kind", async () => {
    await signIn("admin");
    const html = await render(listPage("profile"));
    expect(html).toContain("No dataset of this kind.");
  });

  it("shows the empty state", async () => {
    await signIn("editor");
    mockDatasets.current = [];
    const html = await render(listPage());
    expect(html).toContain("No datasets yet.");
    expect(html).toContain("Ask an admin to set up the data your shop sends.");
  });
});

describe("Dataset editor", () => {
  it("gives an editor the read-only view (DIM-FR-01)", async () => {
    await signIn("editor");
    const html = await render(detailPage(ID));
    expect(html).toContain("You can read this dataset. Only admins can change it or upload files.");
    expect(html).not.toContain("No changes to save");
    expect(html).not.toContain("Upload file");
    expect(html).toContain("Metric spend_90d");
  });

  it("gives an admin the editor with the versions and the uses", async () => {
    await signIn("admin");
    const html = await render(detailPage(ID));
    expect(html).toContain("No changes to save");
    expect(html).toContain("Upload file");
    expect(html).toContain("Created with 4 columns");
    expect(html).toContain("Metric spend_90d");
    expect(html).toContain("Who sends Orders");
  });

  it("is not found for a malformed or missing id", async () => {
    await signIn("admin");
    expect(await render(detailPage("orders"))).toContain("find that page.");
    mockDatasets.current = [];
    expect(await render(detailPage(ID))).toContain("find that page.");
  });

  it("forbids an editor the create page", async () => {
    await signIn("editor");
    expect(await render(newPage())).toContain("This page is for admins.");
  });

  it("gives an admin the create form", async () => {
    await signIn("admin");
    const html = await render(newPage());
    expect(html).toContain("New dataset");
    expect(html).toContain("Create dataset");
  });
});
