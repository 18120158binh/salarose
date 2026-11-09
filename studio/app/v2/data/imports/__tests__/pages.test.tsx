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
const mockReads: SqlQuery[] = [];
const mockRows: { runs: Rows; passes: Rows; metrics: Rows; log: Rows } = { runs: [], passes: [], metrics: [], log: [] };
jest.mock("@/lib/db", () => ({
  getAdminUserById: async () => mockSessionUser.current,
  getSystemUserPreview: async () => true,
  inTransaction: jest.fn(),
  readOnly: jest.fn(async (_timeoutMs: number, work: (run: (query: SqlQuery) => Promise<Rows>) => unknown) =>
    work(async (query) => {
      mockReads.push(query);
      if (query.text.includes("FROM import_runs r")) return mockRows.runs;
      if (query.text.includes("FROM import_metric_passes WHERE state = 'done'")) return mockRows.passes.filter((row) => row.state === "done");
      if (query.text.includes("FROM import_metric_passes")) return mockRows.passes;
      if (query.text.includes("FROM user_metric_definitions d\n         LEFT JOIN")) return mockRows.metrics;
      if (query.text.includes("FROM pii_access_log l")) return mockRows.log;
      return [];
    }),
  ),
}));

import { readOnly } from "@/lib/db";
import V2ImportsPage from "../page";
import V2MetricsPage from "../../metrics/page";
import V2PrivacyPage from "../../privacy/page";

const SECRET = "test-session-secret-0123456789-abcdef";
const RUN_ID = "5f0c8a2e-1b7d-4c39-9a51-2d3e4f5a6b7c";

async function signIn(role: "admin" | "editor"): Promise<void> {
  mockSessionUser.current = { id: `u-${role}`, email: `${role}@example.com`, role, session_epoch: 0 };
  const token = await signSessionToken(
    { userId: `u-${role}`, email: `${role}@example.com`, epoch: 0, providerId: "default" },
    new TextEncoder().encode(SECRET),
    3600,
  );
  mockCookieValues.set(SESSION_COOKIE, token);
}

async function html(element: ReactElement | null): Promise<string> {
  if (element === null) return "";
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  return new Response(stream).text();
}

const noParams = () => ({ searchParams: Promise.resolve({}) });

beforeAll(() => {
  process.env.SESSION_SECRET = SECRET;
});

beforeEach(() => {
  mockCookieValues.clear();
  mockSessionUser.current = undefined;
  mockReads.length = 0;
  mockRows.runs = [];
  mockRows.passes = [];
  mockRows.metrics = [];
  mockRows.log = [];
  jest.mocked(readOnly).mockClear();
  delete process.env.IMPORT_TOMBSTONE_KEY;
});

// #338, DIM-FR-25: a visitor with no session goes to sign-in, and no page reads the database.
describe("without a session", () => {
  it.each([
    ["/v2/data/imports", () => V2ImportsPage(noParams())],
    ["/v2/data/metrics", () => V2MetricsPage()],
    ["/v2/data/privacy", () => V2PrivacyPage(noParams())],
  ])("sends %s to sign-in and reads nothing", async (_path, page) => {
    await expect(page()).rejects.toThrow("NEXT_REDIRECT /login");
    expect(readOnly).not.toHaveBeenCalled();
  });
});

describe("/v2/data/imports (DIM-FR-20)", () => {
  it("shows the empty state and no admin control to an editor", async () => {
    await signIn("editor");
    const page = await html(await V2ImportsPage(noParams()));
    expect(page).toContain("No file has arrived yet.");
    expect(page).toContain("Only admins can approve, discard, retry or download rejected rows.");
    expect(page).not.toContain("Upload a file");
  });

  it("says how old the values are and why, and offers the retry to an admin", async () => {
    await signIn("admin");
    const at = (iso: string) => new Date(iso);
    const now = Date.now();
    mockRows.passes = [
      { id: "11111111-1111-4111-8111-111111111111", as_of: new Date(now - 3_600_000), state: "failed", reason: "timed_out:disk_reading", pauses: [], started_at: new Date(now - 3_600_000) },
      { id: "22222222-2222-4222-8222-222222222222", as_of: at("2026-01-02T12:00:00Z"), state: "done", pauses: [], started_at: at("2026-01-02T12:00:00Z") },
    ];
    const page = await html(await V2ImportsPage(noParams()));
    expect(page).toContain("Imported values in conditions are from 2 Jan");
    expect(page).toContain("timed_out:disk_reading");
    expect(page).toContain("Stopped");
    expect(page).toMatch(/Retry \d+ \w+ pass/);
  });

  it("lists a held file with its review control for an admin", async () => {
    await signIn("admin");
    mockRows.runs = [
      {
        id: RUN_ID,
        record_type_id: RUN_ID,
        display_name: "Customers",
        version: 4,
        source: "api",
        writer: "Loyalty system",
        format: "ndjson.gz",
        file_key: "imports/incoming/loyalty/customers/2026-11-08/loyalty-members.ndjson.gz",
        state: "quarantined",
        reason: "Over the 5% reject limit",
        counts: { rows_read: 48210, rejected: 2893 },
        created_at: new Date(),
      },
    ];
    const page = await html(await V2ImportsPage(noParams()));
    expect(page).toContain("loyalty-members.ndjson.gz");
    expect(page).toContain("Held for review");
    expect(page).toContain("48,210");
    expect(page).toContain("Review loyalty-members.ndjson.gz");
  });
});

describe("/v2/data/metrics (CMP-FR-22, DIM-FR-17)", () => {
  it("lists an event metric read-only, with no value it cannot compute", async () => {
    await signIn("editor");
    mockRows.metrics = [
      { id: "m_3f9c1a2b7d4e5f60", display_name: "Added to cart, count", event_name: "com.acme/add_to_cart", agg_operator: "COUNT", retention_ms: "2592000000", processing_mode: "LIVE", created_by: null },
    ];
    const page = await html(await V2MetricsPage());
    expect(page).toContain("Added to cart, count");
    expect(page).toContain("m_3f9c1a2b7d4e5f60");
    expect(page).toContain("New dataset metric");
    expect(page).toContain("Not available");
    expect(page).not.toContain(">Delete<");
  });
});

describe("/v2/data/privacy (DIM-FR-22, DIM-FR-23)", () => {
  it("gives an editor the forbidden state before any read", async () => {
    await signIn("editor");
    const page = await html(await V2PrivacyPage(noParams()));
    expect(page).toContain("This page is for admins.");
    expect(readOnly).not.toHaveBeenCalled();
  });

  it("says deletion is not configured without a tombstone key", async () => {
    await signIn("admin");
    const page = await html(await V2PrivacyPage(noParams()));
    expect(page).toContain("Deleting a person is not configured.");
    expect(page).not.toContain("Customer key</label>");
  });

  it("offers the form with a key, and hides a deleted person in the log", async () => {
    await signIn("admin");
    process.env.IMPORT_TOMBSTONE_KEY = "k".repeat(32);
    mockRows.log = [
      { id: "l1", at: new Date(), action: "reveal", route: "/customers", customer_key: null, customer_key_hash: "c".repeat(64), fields: ["customers.phone"], staff_email: "admin@example.com" },
    ];
    const page = await html(await V2PrivacyPage(noParams()));
    expect(page).toContain("Customer key");
    expect(page).toContain("Hidden · person deleted");
    expect(page).toContain("customers.phone");
  });
});
