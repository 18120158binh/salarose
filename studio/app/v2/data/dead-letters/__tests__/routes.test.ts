/** @jest-environment node */
import { NextRequest } from "next/server";
import type { DeadLetterReader } from "@/features/data-health/model/deadLetterReader";
import { DeadLetterReadError } from "@/features/data-health/model/deadLetterReader";
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

const mockUser: { current: unknown } = { current: undefined };
jest.mock("@/lib/db", () => ({ getAdminUserById: jest.fn(async () => mockUser.current), getSystemUserPreview: jest.fn(async () => false) }));

const mockReader: { [K in keyof DeadLetterReader]: jest.Mock } = {
  droppedCount: jest.fn(),
  readPage: jest.fn(),
  readContent: jest.fn(),
  retention: jest.fn(),
};
// Jest's alias for @/ points at the studio root, so the mock names the module by its path.
jest.mock("../../../../../src/features/data-health/model/deadLetterServer", () => ({ deadLetterReader: () => mockReader }));

import { GET as getContent } from "../content/route";
import { GET as getRecords } from "../records/route";
import V2DeadLettersPage from "../page";
import { withStage } from "@/widgets/v2-shell/model/__fixtures__/stage";

const SECRET = "test-session-secret-0123456789-abcdef";
const DAY = 86_400_000;
const HOUR = 3_600_000;
// Monday 10:00 UTC. With no tz cookie the window counts in UTC.
const NOW = Date.UTC(2026, 10, 9, 10, 0);
const EVENT = { eid: "e-1", email: "minh@example.com", product: { price: "12.50" } };

async function signIn(role: "admin" | "editor"): Promise<void> {
  const user = { id: `user-${role}`, email: `${role}@example.com`, role, session_epoch: 0 };
  mockUser.current = user;
  const token = await signSessionToken({ userId: user.id, email: user.email, epoch: 0, providerId: "default" }, new TextEncoder().encode(SECRET), 3600);
  mockCookieValues.set(SESSION_COOKIE, token);
}

function request(path: string): NextRequest {
  return new NextRequest(`https://studio.example.com/v2/data/dead-letters/${path}`);
}

const consoleCalls: unknown[][] = [];

beforeAll(() => {
  process.env.SESSION_SECRET = SECRET;
  jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "setImmediate", "setTimeout", "setInterval", "queueMicrotask"] });
});

afterAll(() => {
  jest.useRealTimers();
});

beforeEach(() => {
  mockCookieValues.clear();
  mockUser.current = undefined;
  consoleCalls.length = 0;
  for (const mock of Object.values(mockReader)) mock.mockReset();
  mockReader.readPage.mockResolvedValue({ rows: [], older: null, stoppedAtCap: false });
  mockReader.readContent.mockResolvedValue({ record: "event", event: EVENT });
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    jest.spyOn(console, method).mockImplementation((...args: unknown[]) => void consoleCalls.push(args));
  }
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.KAFKA_EVENT_DEAD_LETTER_TOPIC;
});

describe("who may read dead letters (DHL-FR-05)", () => {
  it.each([
    ["records", "records"],
    ["content", "content?partition=0&offset=7"],
  ])("refuses an editor's direct request for %s and reads nothing", async (_name, path) => {
    await signIn("editor");
    const handler = path.startsWith("records") ? getRecords : getContent;

    const response = await handler(request(path));

    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mockReader.readPage).not.toHaveBeenCalled();
    expect(mockReader.readContent).not.toHaveBeenCalled();
    expect(consoleCalls).toEqual([]);
  });

  it.each([
    ["records", "records"],
    ["content", "content?partition=0&offset=7"],
  ])("refuses a request for %s without a session and reads nothing", async (_name, path) => {
    const handler = path.startsWith("records") ? getRecords : getContent;

    const response = await handler(request(path));

    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mockReader.readPage).not.toHaveBeenCalled();
    expect(mockReader.readContent).not.toHaveBeenCalled();
  });

  it("shows an editor the forbidden state on the page", async () => {
    await signIn("editor");
    const { renderToStaticMarkup } = await import("react-dom/server");

    const html = renderToStaticMarkup(await V2DeadLettersPage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain("This page is for admins.");
    expect(mockReader.retention).not.toHaveBeenCalled();
  });
});

describe("records route (DHL-FR-06)", () => {
  it("reads the shell's default range by default and marks the response not to be stored (DHL-FR-09)", async () => {
    await signIn("admin");
    const page = { rows: [{ partition: 0, offset: 7, timestamp: 1, record: "unreadable" }], older: null, stoppedAtCap: false };
    mockReader.readPage.mockResolvedValue(page);

    const response = await getRecords(request("records"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual(page);
    expect(mockReader.readPage).toHaveBeenCalledWith({ windowMs: 6 * DAY + 10 * HOUR, filter: {}, cursor: undefined });
  });

  it("passes the window, the filters, and the older cursor to the reader", async () => {
    await signIn("admin");
    const older = { partitions: [{ partition: 0, start: 10, before: 60 }] };
    const search = new URLSearchParams({ window: "today", reason: "schema_invalid", record: "event", older: JSON.stringify(older) });

    await getRecords(request(`records?${search}`));
    await getRecords(request("records?window=30d&reason=grouped"));

    expect(mockReader.readPage.mock.calls).toEqual([
      [{ windowMs: 10 * HOUR, filter: { reason: "schema_invalid", record: "event" }, cursor: older }],
      [{ windowMs: 29 * DAY + 10 * HOUR, filter: { reason: null }, cursor: undefined }],
    ]);
  });

  it.each([
    ["a window the page does not offer", "records?window=24h"],
    ["an unknown reason", "records?reason=bogus"],
    ["a cursor that is not JSON", "records?older=nope"],
    ["a cursor with a negative offset", `records?older=${encodeURIComponent(JSON.stringify({ partitions: [{ partition: 0, start: -1, before: 5 }] }))}`],
  ])("refuses %s without reading", async (_case, path) => {
    await signIn("admin");

    const response = await getRecords(request(path));

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mockReader.readPage).not.toHaveBeenCalled();
  });

  it("names why the topic could not be read", async () => {
    await signIn("admin");
    mockReader.readPage.mockRejectedValue(new DeadLetterReadError("topic not found"));

    const response = await getRecords(request("records"));

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "topic not found" });
  });
});

describe("content route (DHL-FR-07, DHL-FR-09, DHL-FR-10)", () => {
  it("returns one record's content, not to be stored, and logs who opened which record without the content", async () => {
    await signIn("admin");
    process.env.KAFKA_EVENT_DEAD_LETTER_TOPIC = "dl-topic";

    const response = await getContent(request("content?partition=2&offset=41"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ content: { record: "event", event: EVENT } });
    expect(mockReader.readContent).toHaveBeenCalledWith(2, 41);
    expect(console.info).toHaveBeenCalledTimes(1);
    const line = String((console.info as jest.Mock).mock.calls[0][0]);
    expect(line).toContain("user-admin");
    expect(line).toContain("topic dl-topic");
    expect(line).toContain("partition 2");
    expect(line).toContain("offset 41");
    const logged = JSON.stringify(consoleCalls);
    for (const value of ["e-1", "minh@example.com", "12.50"]) expect(logged).not.toContain(value);
  });

  it("says the record is gone when retention removed it", async () => {
    await signIn("admin");
    mockReader.readContent.mockResolvedValue(null);

    const response = await getContent(request("content?partition=0&offset=7"));

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it.each([["content"], ["content?partition=0"], ["content?partition=-1&offset=2"], ["content?partition=0&offset=1e3"]])(
    "refuses %s without reading or logging",
    async (path) => {
      await signIn("admin");

      const response = await getContent(request(path));

      expect(response.status).toBe(400);
      expect(mockReader.readContent).not.toHaveBeenCalled();
      expect(consoleCalls).toEqual([]);
    },
  );
});

describe("page (DHL-FR-05)", () => {
  it("sends an admin to Monitoring's Dropped data tab, keeping the window and filters", async () => {
    await signIn("admin");

    await expect(V2DeadLettersPage({ searchParams: Promise.resolve({ window: "today", reason: "no_timestamp" }) })).rejects.toThrow(
      "NEXT_REDIRECT /v2/data/monitoring?tab=dropped&window=today&reason=no_timestamp",
    );
  });

  it("sends an address with a window it does not offer to the tab's default list", async () => {
    await signIn("admin");

    await expect(V2DeadLettersPage({ searchParams: Promise.resolve({ window: "24h" }) })).rejects.toThrow(
      "NEXT_REDIRECT /v2/data/monitoring?tab=dropped",
    );
  });

  it("keeps serving the browser while Monitoring does not let the admin through", async () => {
    await signIn("admin");
    await withStage(["monitoring"], "reserved", async () => {
      await expect(V2DeadLettersPage({ searchParams: Promise.resolve({}) })).resolves.toBeTruthy();
    });
  });

  it("gives an editor the forbidden state, not the redirect", async () => {
    await signIn("editor");

    const page = await V2DeadLettersPage({ searchParams: Promise.resolve({}) });

    expect(JSON.stringify(page)).not.toContain("NEXT_REDIRECT");
    expect(mockReader.readPage).not.toHaveBeenCalled();
  });

  it("sends a visitor with no session to sign in", async () => {
    await expect(V2DeadLettersPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_REDIRECT /login");
  });
});
