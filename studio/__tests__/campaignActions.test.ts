/** @jest-environment node */

// The campaign actions in app/actions.ts write through shared/lib/db.ts to a pg Pool. These
// tests replace the pool with a small in-memory model of the campaigns and campaign_nodes
// tables, so each test can call an action as the browser does and then read what is stored.
import type { AdminSession } from "@/shared/auth/types";

interface StoredCampaign {
  name: string;
  status: string;
  root: unknown;
  created_user: string | null;
}
interface StoredNodeRow {
  campaign_id: string;
  node_id: string;
  node_type: string;
  parent_node_id: string | null;
  parent_branch: string | null;
  campaign_node_count: number;
  graph_version: string;
}
interface MockTables {
  campaigns: Map<string, StoredCampaign>;
  nodes: StoredNodeRow[];
  // The last value campaign_graph_version_seq gave.
  lastGraphVersion: number;
}
interface MockResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

let mockTables: MockTables = { campaigns: new Map(), nodes: [], lastGraphVersion: 0 };
// pg returns a TIMESTAMP WITH TIME ZONE column as a Date.
const CREATED_AT = new Date("2026-10-18T00:00:00.000Z");
let mockSession: AdminSession | null = null;

jest.mock("server-only", () => ({}));
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }));
jest.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
jest.mock("@/shared/auth/session", () => ({
  assertSession: async () => {
    if (!mockSession) throw new Error("Unauthorized");
    return mockSession;
  },
  assertAdmin: async () => {
    if (mockSession?.role !== "admin") throw new Error("Only admin users can do this.");
    return mockSession;
  },
}));

jest.mock("../../shared/node_modules/pg", () => {
  const result = (rows: Record<string, unknown>[], rowCount = rows.length): MockResult => ({ rows, rowCount });
  let snapshot: MockTables | null = null;
  const copy = (tables: MockTables): MockTables => ({
    campaigns: new Map([...tables.campaigns].map(([id, row]) => [id, { ...row }])),
    nodes: tables.nodes.map((row) => ({ ...row })),
    lastGraphVersion: tables.lastGraphVersion,
  });

  // Answers the statements the campaign functions send, the way Postgres would.
  const query = async (rawText: string, values: unknown[] = []): Promise<MockResult> => {
    const text = rawText.replace(/\s+/g, " ").trim();
    const t = mockTables;
    if (text === "BEGIN") {
      snapshot = copy(t);
      return result([]);
    }
    if (text === "COMMIT") return result([]);
    if (text === "ROLLBACK") {
      if (snapshot) mockTables = snapshot;
      return result([]);
    }
    if (text.startsWith("SELECT") && /FROM campaigns WHERE id = \$1/.test(text)) {
      const id = String(values[0]);
      const row = t.campaigns.get(id);
      return result(row ? [{ id, ...row, root: row.root }] : []);
    }
    // The campaign list: the caller's campaigns, and for an admin ($2 true) the ownerless ones.
    if (text.startsWith("SELECT * FROM campaigns WHERE created_user = $1")) {
      const listsOwnerless = text.includes("OR ($2 AND created_user IS NULL)") && values[1] === true;
      const rows = [...t.campaigns]
        .filter(([, row]) => row.created_user === values[0] || (listsOwnerless && row.created_user === null))
        .map(([id, row]) => ({ id, description: null, created_at: CREATED_AT, updated_at: CREATED_AT, ...row }));
      return result(rows);
    }
    if (text.startsWith("INSERT INTO campaigns ")) {
      const [id, name, , status, root, owner] = values as [string, string, string, string, string, string];
      const existing = t.campaigns.get(id);
      if (!existing) {
        t.campaigns.set(id, { name, status, root: JSON.parse(root), created_user: owner });
        return result([], 1);
      }
      // ON CONFLICT (id) DO UPDATE ... WHERE campaigns.created_user = EXCLUDED.created_user
      // updates nothing when the stored owner differs.
      if (text.includes("WHERE campaigns.created_user = EXCLUDED.created_user") && existing.created_user !== owner) {
        return result([], 0);
      }
      t.campaigns.set(id, { ...existing, name, status, root: JSON.parse(root) });
      return result([], 1);
    }
    if (text.startsWith("UPDATE campaigns SET status")) {
      const [status, id] = values as [string, string];
      const existing = t.campaigns.get(id);
      if (existing) existing.status = status;
      return result([], existing ? 1 : 0);
    }
    if (text.startsWith("DELETE FROM campaigns WHERE id = $1")) {
      const id = String(values[0]);
      const existed = t.campaigns.delete(id);
      t.nodes = t.nodes.filter((row) => row.campaign_id !== id);
      return result([], existed ? 1 : 0);
    }
    if (text.startsWith("DELETE FROM campaign_nodes WHERE campaign_id = $1")) {
      t.nodes = t.nodes.filter((row) => row.campaign_id !== values[0]);
      return result([]);
    }
    // pg returns a bigint as a string.
    if (text === "SELECT nextval('campaign_graph_version_seq') AS version") {
      t.lastGraphVersion += 1;
      return result([{ version: String(t.lastGraphVersion) }]);
    }
    if (text === "SELECT graph_version FROM campaign_nodes WHERE campaign_id = $1 LIMIT 1") {
      const row = t.nodes.find((node) => node.campaign_id === values[0]);
      return result(row ? [{ graph_version: row.graph_version }] : []);
    }
    if (text.startsWith("INSERT INTO campaign_nodes")) {
      const [campaign_id, node_id, node_type, parent_node_id, parent_branch] = values as string[];
      const campaign_node_count = Number(values[10]);
      const graph_version = String(values[11]);
      if (!t.campaigns.has(campaign_id)) {
        throw new Error('insert or update on table "campaign_nodes" violates foreign key constraint');
      }
      if (t.nodes.some((row) => row.campaign_id === campaign_id && row.node_id === node_id)) {
        throw new Error('duplicate key value violates unique constraint "campaign_nodes_pkey"');
      }
      t.nodes.push({ campaign_id, node_id, node_type, parent_node_id, parent_branch, campaign_node_count, graph_version });
      return result([], 1);
    }
    // Node counts: one user on each node row. The read returns nothing for a caller who is
    // neither the owner ($2) nor an admin ($3) when the statement joins campaigns on the owner.
    if (/FROM campaign_node_stats/.test(text)) {
      const id = String(values[0]);
      const owner = t.campaigns.get(id)?.created_user;
      const checksOwner = /JOIN campaigns c ON c\.id = s\.campaign_id WHERE s\.campaign_id = \$1 AND \(c\.created_user = \$2 OR \$3\)/.test(text);
      if (checksOwner && owner !== values[1] && values[2] !== true) return result([]);
      const rows = t.nodes.filter((row) => row.campaign_id === id);
      return result(rows.map((row) => ({ node_id: row.node_id, user_count: "1" })));
    }
    // Metric definition reads and the processing mode refresh. No metric conditions here.
    return result([]);
  };
  return {
    Pool: jest.fn().mockImplementation(() => ({
      query,
      connect: async () => ({ query, release: () => undefined }),
    })),
  };
});

import {
  deleteCampaignAction,
  getCampaignNodeStatsAction,
  publishCampaignAction,
  toggleCampaignStatusAction,
} from "@/app/actions";
import { getCampaign, getCampaigns } from "@/lib/db";

const lan: AdminSession = { userId: "user_lan", email: "lan@example.com", role: "editor" };
const minh: AdminSession = { userId: "user_minh", email: "minh@example.com", role: "editor" };
const admin: AdminSession = { userId: "user_admin", email: "admin@example.com", role: "admin" };

// setup-1 -> email-1 -> end
function journey(trigger: string) {
  return {
    type: "setup",
    id: "setup-1",
    label: "Trigger",
    description: "Define journey settings",
    triggerType: "user",
    triggerEventName: trigger,
    next: {
      type: "engagement",
      id: "email-1",
      label: "Email",
      action: { type: "email", subject: "Hello" },
      next: { type: "end", goalId: "goal_default" },
    },
  };
}
// Each row carries the size of its save, so the state machine can apply the save as one change,
// and the version of the graph. The stored campaigns were published at version 5.
const journeyRows = (campaignId: string, graphVersion = "5"): StoredNodeRow[] =>
  [
    { campaign_id: campaignId, node_id: "setup-1", node_type: "setup", parent_node_id: null, parent_branch: null },
    { campaign_id: campaignId, node_id: "email-1", node_type: "engagement", parent_node_id: "setup-1", parent_branch: "next" },
    { campaign_id: campaignId, node_id: "email-1-next-end", node_type: "end", parent_node_id: "email-1", parent_branch: "next" },
  ].map((row) => ({ ...row, campaign_node_count: 3, graph_version: graphVersion }));
const forgedRow = (campaignId: string, nodeId: string) => ({
  campaign_id: campaignId,
  node_id: nodeId,
  node_type: "check",
  parent_node_id: "setup-1",
  parent_branch: "next",
  trigger_json: JSON.stringify({ kind: "event", event: "purchase" }),
  conditions_json: null,
  paths_json: null,
  action_json: null,
  goal_id: null,
});

// A direct call to a server action can send any arguments, not only the ones the UI sends.
const callPublish = publishCampaignAction as (...args: unknown[]) => Promise<unknown>;
const callToggle = toggleCampaignStatusAction as (...args: unknown[]) => Promise<unknown>;

const rowsOf = (campaignId: string) => mockTables.nodes.filter((row) => row.campaign_id === campaignId);

beforeAll(() => {
  process.env.DATABASE_URL = "postgres://test";
});

// Lan owns c_lan, which is active, and c_lan_paused. Minh owns c_minh, which is active.
beforeEach(() => {
  mockSession = null;
  mockTables = {
    campaigns: new Map([
      ["c_lan", { name: "Cart recovery", status: "active", root: journey("add_to_cart"), created_user: lan.userId }],
      ["c_lan_paused", { name: "Win back", status: "paused", root: journey("login_success"), created_user: lan.userId }],
      ["c_minh", { name: "Browse reminder", status: "active", root: journey("view_item"), created_user: minh.userId }],
    ]),
    nodes: [...journeyRows("c_lan"), ...journeyRows("c_lan_paused"), ...journeyRows("c_minh")],
    lastGraphVersion: 5,
  };
});

describe("deleteCampaignAction", () => {
  it("rejects an editor who does not own the campaign and keeps it", async () => {
    mockSession = minh;

    await expect(deleteCampaignAction("c_lan")).resolves.toEqual({
      error: "Only the owner of campaign c_lan or an admin can change it.",
    });
    expect(mockTables.campaigns.get("c_lan")?.name).toBe("Cart recovery");
    expect(rowsOf("c_lan")).toEqual(journeyRows("c_lan"));
  });

  it("deletes the campaign and its node rows for the owner", async () => {
    mockSession = lan;

    await expect(deleteCampaignAction("c_lan")).resolves.toEqual({ success: true });
    expect(mockTables.campaigns.has("c_lan")).toBe(false);
    expect(rowsOf("c_lan")).toEqual([]);
  });

  it("deletes another editor's campaign for an admin", async () => {
    mockSession = admin;

    await expect(deleteCampaignAction("c_lan")).resolves.toEqual({ success: true });
    expect(mockTables.campaigns.has("c_lan")).toBe(false);
  });

  it("fails for an id that does not exist", async () => {
    mockSession = admin;

    await expect(deleteCampaignAction("c_missing")).resolves.toEqual({ error: "Campaign c_missing not found." });
  });
});

describe("toggleCampaignStatusAction", () => {
  it("rejects a pause by an editor who does not own the campaign", async () => {
    mockSession = minh;

    await expect(toggleCampaignStatusAction("c_lan", "paused")).resolves.toEqual({
      error: "Only the owner of campaign c_lan or an admin can change it.",
    });
    expect(mockTables.campaigns.get("c_lan")?.status).toBe("active");
  });

  it("rejects a resume by an editor who does not own the campaign and keeps its rows", async () => {
    mockSession = minh;

    await expect(callToggle("c_lan_paused", "active", [forgedRow("c_lan_paused", "check-9")])).resolves.toEqual({
      error: "Only the owner of campaign c_lan_paused or an admin can change it.",
    });
    expect(mockTables.campaigns.get("c_lan_paused")?.status).toBe("paused");
    expect(rowsOf("c_lan_paused")).toEqual(journeyRows("c_lan_paused"));
  });

  it("lets an admin pause another editor's campaign", async () => {
    mockSession = admin;

    await expect(toggleCampaignStatusAction("c_lan", "paused")).resolves.toEqual({ success: true });
    expect(mockTables.campaigns.get("c_lan")?.status).toBe("paused");
  });

  it("rebuilds the node rows of a resumed campaign from its stored journey, under its own id", async () => {
    mockSession = lan;
    mockTables.nodes = mockTables.nodes.filter((row) => row.campaign_id !== "c_lan_paused");

    const result = await callToggle("c_lan_paused", "active", [
      forgedRow("c_minh", "check-9"),
      forgedRow("c_lan_paused", "check-9"),
    ]);

    expect(result).toEqual({ success: true });
    expect(mockTables.campaigns.get("c_lan_paused")?.status).toBe("active");
    expect(rowsOf("c_lan_paused")).toEqual(journeyRows("c_lan_paused", "6"));
    expect(rowsOf("c_minh")).toEqual(journeyRows("c_minh"));
  });

  // A resume writes the graph that was published, so the triggers and watch timeouts decided
  // against it before the pause still apply.
  it("keeps the graph version of a resumed campaign", async () => {
    mockSession = lan;

    await expect(toggleCampaignStatusAction("c_lan_paused", "active")).resolves.toEqual({ success: true });
    expect(rowsOf("c_lan_paused")).toEqual(journeyRows("c_lan_paused", "5"));
  });

  it("refuses to resume a campaign whose stored journey is malformed, and keeps it paused", async () => {
    mockSession = lan;
    const broken = { ...journey("login_success"), next: { type: "check", id: "check-1", label: "Bought?", eventName: "purchase" } };
    mockTables.campaigns.set("c_lan_paused", { name: "Win back", status: "paused", root: broken, created_user: lan.userId });

    await expect(toggleCampaignStatusAction("c_lan_paused", "active")).resolves.toEqual({
      error: "Campaign c_lan_paused cannot resume. Invalid journey: root.next.next must be an object.",
    });
    expect(mockTables.campaigns.get("c_lan_paused")?.status).toBe("paused");
    expect(rowsOf("c_lan_paused")).toEqual(journeyRows("c_lan_paused"));
  });

  it("refuses to pause a campaign that is already paused", async () => {
    mockSession = lan;

    await expect(toggleCampaignStatusAction("c_lan_paused", "paused")).resolves.toEqual({
      error: "Only an active campaign can be paused. Campaign c_lan_paused is paused.",
    });
    expect(mockTables.campaigns.get("c_lan_paused")?.status).toBe("paused");
  });

  it("refuses to resume a campaign that is already active, and keeps its node rows", async () => {
    mockSession = lan;
    mockTables.nodes = mockTables.nodes.filter((row) => row.campaign_id !== "c_lan" || row.node_type !== "end");
    const rowsBefore = rowsOf("c_lan");

    await expect(toggleCampaignStatusAction("c_lan", "active")).resolves.toEqual({
      error: "Only a paused campaign can be resumed. Campaign c_lan is active.",
    });
    expect(rowsOf("c_lan")).toEqual(rowsBefore);
  });

  it("refuses to pause or resume a campaign whose stored status is neither active nor paused", async () => {
    mockSession = lan;
    mockTables.campaigns.set("c_lan", { ...mockTables.campaigns.get("c_lan")!, status: "live" });

    await expect(toggleCampaignStatusAction("c_lan", "paused")).resolves.toEqual({
      error: "Only an active campaign can be paused. Campaign c_lan is live.",
    });
    await expect(toggleCampaignStatusAction("c_lan", "active")).resolves.toEqual({
      error: "Only a paused campaign can be resumed. Campaign c_lan is live.",
    });
    expect(mockTables.campaigns.get("c_lan")?.status).toBe("live");
  });

  it("rejects a status other than active or paused", async () => {
    mockSession = lan;

    await expect(callToggle("c_lan", "live")).resolves.toEqual({ error: "Status must be active or paused." });
    expect(mockTables.campaigns.get("c_lan")?.status).toBe("active");
  });
});

describe("publishCampaignAction", () => {
  const draft = (id: string, name: string, root: unknown = journey("purchase")) => ({
    id,
    name,
    description: "",
    status: "draft",
    root,
    created_at: "2026-10-18T00:00:00.000Z",
    updated_at: "2026-10-18T00:00:00.000Z",
  });

  it("rejects a draft whose id is another editor's campaign and leaves that campaign as it was", async () => {
    mockSession = minh;

    const result = await callPublish(draft("c_lan", "Minh's promo"), [forgedRow("c_lan", "check-9")]);

    expect(result).toEqual({ error: "Campaign c_lan belongs to another user." });
    expect(mockTables.campaigns.get("c_lan")).toEqual({
      name: "Cart recovery",
      status: "active",
      root: journey("add_to_cart"),
      created_user: lan.userId,
    });
    expect(rowsOf("c_lan")).toEqual(journeyRows("c_lan"));
  });

  it("stores a new campaign as active, owned by the caller, with node rows built from its journey", async () => {
    mockSession = minh;

    const result = await callPublish(draft("c_new", "Purchase thanks"), [
      forgedRow("c_lan", "check-9"),
      forgedRow("c_new", "check-9"),
    ]);

    expect(result).toEqual({ success: true });
    expect(mockTables.campaigns.get("c_new")).toEqual({
      name: "Purchase thanks",
      status: "active",
      root: journey("purchase"),
      created_user: minh.userId,
    });
    expect(rowsOf("c_new")).toEqual(journeyRows("c_new", "6"));
    expect(rowsOf("c_lan")).toEqual(journeyRows("c_lan"));
  });

  // The new graph gets a higher version, so the state machine drops the triggers decided
  // against the graph it replaces.
  it("lets the owner publish again under the same id, at a higher graph version", async () => {
    mockSession = lan;

    await expect(callPublish(draft("c_lan", "Cart recovery v2"))).resolves.toEqual({ success: true });
    expect(mockTables.campaigns.get("c_lan")?.name).toBe("Cart recovery v2");
    expect(rowsOf("c_lan")).toEqual(journeyRows("c_lan", "6"));
  });

  it("rejects a journey whose check node has no outcome and writes nothing", async () => {
    mockSession = minh;
    const root = { ...journey("purchase"), next: { type: "check", id: "check-1", label: "Bought?", eventName: "purchase" } };

    await expect(callPublish(draft("c_new", "Broken", root))).resolves.toEqual({
      error: "Invalid journey: root.next.next must be an object.",
    });
    expect(mockTables.campaigns.has("c_new")).toBe(false);
    expect(rowsOf("c_new")).toEqual([]);
  });
});

describe("getCampaignNodeStatsAction", () => {
  const lanCounts = { "setup-1": 1, "email-1": 1, "email-1-next-end": 1 };

  it("returns no counts to an editor who does not own the campaign", async () => {
    mockSession = minh;

    await expect(getCampaignNodeStatsAction("c_lan")).resolves.toEqual({ stats: {} });
  });

  it("returns the counts to the owner", async () => {
    mockSession = lan;

    await expect(getCampaignNodeStatsAction("c_lan")).resolves.toEqual({ stats: lanCounts });
  });

  it("returns the counts of another editor's campaign to an admin", async () => {
    mockSession = admin;

    await expect(getCampaignNodeStatsAction("c_lan")).resolves.toEqual({ stats: lanCounts });
  });

  // The builder keeps the last counts when a refresh fails, so a failure must not look like zero users.
  it("returns an error, not empty counts, when the counts cannot load", async () => {
    await expect(getCampaignNodeStatsAction("c_lan")).resolves.toEqual({ error: "Node counts could not load." });
  });
});

describe("getCampaigns", () => {
  // c_orphan has no owner, as campaigns published before ownership checks may have.
  beforeEach(() => {
    mockTables.campaigns.set("c_orphan", { name: "Old promo", status: "active", root: journey("purchase"), created_user: null });
    mockTables.campaigns.set("c_admin", { name: "Admin promo", status: "paused", root: journey("purchase"), created_user: admin.userId });
  });
  const listed = (campaigns: { id: string; ownerless?: boolean }[]) =>
    campaigns.map(({ id, ownerless }) => ({ id, ownerless })).sort((a, b) => a.id.localeCompare(b.id));

  it("lists an admin's own campaigns and the campaigns with no owner, marked as ownerless", async () => {
    const campaigns = await getCampaigns({ userId: admin.userId, isAdmin: true });

    expect(listed(campaigns)).toEqual([
      { id: "c_admin", ownerless: false },
      { id: "c_orphan", ownerless: true },
    ]);
  });

  it("returns each campaign's fields, with its timestamps as ISO strings", async () => {
    const campaigns = await getCampaigns({ userId: lan.userId, isAdmin: false });

    expect(campaigns.find((campaign) => campaign.id === "c_lan")).toEqual({
      id: "c_lan",
      name: "Cart recovery",
      description: "",
      status: "active",
      root: journey("add_to_cart"),
      created_at: "2026-10-18T00:00:00.000Z",
      updated_at: "2026-10-18T00:00:00.000Z",
      ownerless: false,
    });
  });

  it("leaves out and logs a row whose status is neither active nor paused, or whose journey is not one", async () => {
    mockTables.campaigns.set("c_lan_live", { name: "Live", status: "live", root: journey("purchase"), created_user: lan.userId });
    mockTables.campaigns.set("c_lan_broken", { name: "Broken", status: "active", root: "setup", created_user: lan.userId });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    const campaigns = await getCampaigns({ userId: lan.userId, isAdmin: false });

    expect(listed(campaigns).map(({ id }) => id)).toEqual(["c_lan", "c_lan_paused"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("c_lan_live"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("c_lan_broken"));
    warn.mockRestore();
  });

  it("lists only an editor's own campaigns", async () => {
    const campaigns = await getCampaigns({ userId: lan.userId, isAdmin: false });

    expect(listed(campaigns)).toEqual([
      { id: "c_lan", ownerless: false },
      { id: "c_lan_paused", ownerless: false },
    ]);
  });
});

// The builder opens one campaign by id, for its owner or an admin (JBD-KI-20).
describe("getCampaign", () => {
  it("returns the campaign to its owner", async () => {
    await expect(getCampaign("c_lan", { userId: lan.userId, isAdmin: false })).resolves.toEqual(
      expect.objectContaining({ id: "c_lan", root: expect.objectContaining({ type: "setup" }) }),
    );
  });

  it("returns another editor's campaign to an admin", async () => {
    await expect(getCampaign("c_lan", { userId: admin.userId, isAdmin: true })).resolves.toEqual(
      expect.objectContaining({ id: "c_lan" }),
    );
  });

  it("returns nothing to an editor who does not own it", async () => {
    await expect(getCampaign("c_lan", { userId: minh.userId, isAdmin: false })).resolves.toBeNull();
  });

  it("returns nothing for an unknown id", async () => {
    await expect(getCampaign("CAMP-ffffffffffffffff", { userId: admin.userId, isAdmin: true })).resolves.toBeNull();
  });
});
