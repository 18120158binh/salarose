/** @jest-environment node */
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
}));

type Rows = Record<string, unknown>[];
const mockSessionUser: { current: unknown } = { current: undefined };
const mockWrites: SqlQuery[] = [];
const mockAnswer: { current: (query: SqlQuery) => Rows } = { current: () => [] };
const mockInTransaction = jest.fn(async (work: (client: unknown) => unknown) =>
  work({
    query: async (text: string, values: unknown[]) => {
      mockWrites.push({ text, values });
      return { rows: mockAnswer.current({ text, values }) };
    },
  }),
);
jest.mock("@/lib/db", () => ({
  getAdminUserById: async () => mockSessionUser.current,
  inTransaction: (work: (client: unknown) => unknown) => mockInTransaction(work),
}));

import * as metricsActions from "../metricsActions";
import { approveRunAction, discardRunAction, retryPassAction, retryRunAction } from "../importsActions";
import { archiveDatasetMetricAction, createDatasetMetricAction, unarchiveDatasetMetricAction, updateDatasetMetricAction } from "../metricsActions";
import { requestPersonDeletionAction } from "../privacyActions";

const SECRET = "test-session-secret-0123456789-abcdef";
const ID = "5f0c8a2e-1b7d-4c39-9a51-2d3e4f5a6b7c";
const METRIC_ID = "0b6f3c1d-2a4e-4f5a-8b9c-1d2e3f4a5b6c";

async function signIn(role: "admin" | "editor"): Promise<void> {
  mockSessionUser.current = { id: `u-${role}`, email: `${role}@example.com`, role, session_epoch: 0 };
  const token = await signSessionToken(
    { userId: `u-${role}`, email: `${role}@example.com`, epoch: 0, providerId: "default" },
    new TextEncoder().encode(SECRET),
    3600,
  );
  mockCookieValues.set(SESSION_COOKIE, token);
}

beforeAll(() => {
  process.env.SESSION_SECRET = SECRET;
  process.env.IMPORT_TOMBSTONE_KEY = "k".repeat(32);
});

beforeEach(() => {
  mockCookieValues.clear();
  mockSessionUser.current = undefined;
  mockWrites.length = 0;
  mockInTransaction.mockClear();
  mockAnswer.current = () => [];
  jest.spyOn(console, "error").mockImplementation(() => {});
});

const ADMIN_ACTIONS: [string, () => Promise<unknown>][] = [
  ["approve", () => approveRunAction(ID)],
  ["discard", () => discardRunAction(ID)],
  ["retry a run", () => retryRunAction(ID)],
  ["retry a pass", () => retryPassAction(ID)],
  ["request a deletion", () => requestPersonDeletionAction("0912345678")],
];

const STAFF_ACTIONS: [string, () => Promise<unknown>][] = [
  ["create a metric", () => createDatasetMetricAction({ recordTypeId: ID, name: "x", displayName: "X", function: "COUNT" })],
  ["edit a metric", () => updateDatasetMetricAction(METRIC_ID, { name: "x" })],
  ["archive a metric", () => archiveDatasetMetricAction(METRIC_ID)],
  ["unarchive a metric", () => unarchiveDatasetMetricAction(METRIC_ID)],
];

// #338, DIM-FR-25: with no session every action refuses before it touches the database.
describe.each([...ADMIN_ACTIONS, ...STAFF_ACTIONS])("without a session, %s", (_name, call) => {
  it("is refused and writes nothing", async () => {
    await expect(call()).resolves.toEqual({ error: "Unauthorized" });
    expect(mockInTransaction).not.toHaveBeenCalled();
  });
});

// DIM-FR-20, DIM-FR-23: an editor can do none of the admin actions.
describe.each(ADMIN_ACTIONS)("as an editor, %s", (_name, call) => {
  it("is refused and writes nothing", async () => {
    await signIn("editor");
    await expect(call()).resolves.toEqual({ error: "Only admin users can do this." });
    expect(mockInTransaction).not.toHaveBeenCalled();
  });
});

describe("import run and pass actions (DIM-FR-20)", () => {
  it("approves a held file with one conditional update", async () => {
    await signIn("admin");
    mockAnswer.current = () => [{ id: ID }];
    await expect(approveRunAction(ID)).resolves.toEqual({ done: true });
    expect(mockWrites).toHaveLength(1);
    expect(mockWrites[0].values).toEqual([ID, "approved", "quarantined", "u-admin"]);
  });

  it("says so when the file is no longer held", async () => {
    await signIn("admin");
    await expect(discardRunAction(ID)).resolves.toEqual({ error: "This file is no longer held for review." });
  });

  it("stamps only retry_requested_at on a pass retry", async () => {
    await signIn("admin");
    mockAnswer.current = () => [{ id: ID }];
    await expect(retryPassAction(ID)).resolves.toEqual({ done: true });
    expect(mockWrites[0].text).toMatch(/^UPDATE import_metric_passes SET retry_requested_at = now\(\)\s+WHERE/);
  });
});

describe("dataset metric actions (DIM-FR-17, DIM-FR-18)", () => {
  const locked = { record_type_id: ID, dataset: "orders", name: "spend_90d", archived: false };

  it("offers no way to delete a metric", () => {
    expect(Object.keys(metricsActions).filter((name) => /delete/i.test(name))).toEqual([]);
  });

  it("refuses an editor's archive of a metric a segment uses, and names the segment", async () => {
    await signIn("editor");
    mockAnswer.current = ({ text }) => {
      if (text.includes("FOR UPDATE")) return [locked];
      if (text.includes("FROM segments")) {
        return [{ id: "SEG-1", name: "Big spenders", conditions_json: { groups: [{ conditions: [{ type: "profile_property", field: "orders.spend_90d", op: ">", value: 1 }] }] } }];
      }
      return [];
    };
    await expect(archiveDatasetMetricAction(METRIC_ID)).resolves.toEqual({
      error: "This metric can't be archived while something uses it: segment Big spenders.",
    });
    expect(mockWrites.some((query) => query.text.includes("SET archived_at"))).toBe(false);
  });

  it("archives an unused metric for an editor", async () => {
    await signIn("editor");
    mockAnswer.current = ({ text }) => (text.includes("FOR UPDATE") ? [locked] : []);
    await expect(archiveDatasetMetricAction(METRIC_ID)).resolves.toEqual({ done: true });
    expect(mockWrites.some((query) => query.text.includes("SET archived_at = now()"))).toBe(true);
  });

  it("refuses SUM of a text column and writes nothing", async () => {
    await signIn("editor");
    mockAnswer.current = ({ text }) =>
      text.includes("FROM import_record_types t")
        ? [{ id: ID, name: "orders", display_name: "Orders", roles: {}, columns: [{ name: "status", displayName: "Status", type: "string" }] }]
        : [];
    const result = await createDatasetMetricAction({ recordTypeId: ID, name: "s", displayName: "S", function: "SUM", column: "status" });
    expect(result).toEqual({ error: "The metric was not saved. Fix the fields below.", problems: ["Status is Text. Sum needs a number."] });
    expect(mockWrites.some((query) => query.text.includes("INSERT"))).toBe(false);
  });

  it("refuses to edit an archived metric", async () => {
    await signIn("editor");
    mockAnswer.current = ({ text }) => (text.includes("FOR UPDATE") ? [{ ...locked, archived: true }] : []);
    await expect(updateDatasetMetricAction(METRIC_ID, {})).resolves.toEqual({ error: "An archived metric is frozen. Unarchive it to edit it." });
  });
});

describe("requestPersonDeletionAction (DIM-FR-23)", () => {
  it("returns only the code, and never the key", async () => {
    await signIn("admin");
    const result = await requestPersonDeletionAction("0912345678");
    expect(result).toMatchObject({ status: "requested" });
    expect(JSON.stringify(result)).not.toContain("0912345678");
    expect(JSON.stringify(mockWrites)).not.toContain("0912345678");
  });

  it("says not configured without a tombstone key, and writes nothing", async () => {
    await signIn("admin");
    const key = process.env.IMPORT_TOMBSTONE_KEY;
    delete process.env.IMPORT_TOMBSTONE_KEY;
    try {
      await expect(requestPersonDeletionAction("0912345678")).resolves.toEqual({ status: "not_configured" });
      expect(mockInTransaction).not.toHaveBeenCalled();
    } finally {
      process.env.IMPORT_TOMBSTONE_KEY = key;
    }
  });
});
