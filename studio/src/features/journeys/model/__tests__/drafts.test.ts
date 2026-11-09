/** @jest-environment node */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as db from "@/lib/db";
import type { AdminSession } from "@/shared/auth/types";
import { parseCampaignForPublish } from "@/entities/journey/model/parseCampaign";
import { flattenCampaignTree } from "@/entities/journey/model/utils";
import {
  createDraftAction,
  deleteDraftAction,
  listMyDraftsAction,
  publishDraftAction,
  saveDraftAction,
} from "../actions";
import { bridge } from "../../../../shared/testing/pgBridge";

jest.mock("../../../../../../shared/node_modules/pg", () => jest.requireActual("../../../../shared/testing/pgBridge").bridge.pgModule());
jest.mock("server-only", () => ({}));
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }));
jest.mock("@/shared/auth/session", () => ({
  assertSession: async () => {
    const session = (globalThis as { mockSession?: AdminSession | null }).mockSession;
    if (!session) throw new (jest.requireActual("shared/lib/userFacingError").UserFacingError)("Unauthorized");
    return session;
  },
}));

const LAN: AdminSession = { userId: "user_lan", email: "lan@example.com", role: "editor" };
const HOA: AdminSession = { userId: "user_hoa", email: "hoa@example.com", role: "editor" };
const signIn = (session: AdminSession | null) => {
  (globalThis as { mockSession?: AdminSession | null }).mockSession = session;
};

const FIXTURES = path.join(__dirname, "..", "..", "..", "..", "entities", "journey", "model", "__fixtures__", "journeys");
const fixtures = readdirSync(FIXTURES)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => ({ name: file.replace(/\.json$/, ""), root: JSON.parse(readFileSync(path.join(FIXTURES, file), "utf8")) }));
const JOURNEY = fixtures.find((fixture) => fixture.name === "classic-every-node-and-path")!.root as Record<string, unknown>;

const sql = (text: string, values: unknown[] = []) => bridge.query(text, values).then((result) => result.rows);
const count = async (table: string, where = "TRUE", values: unknown[] = []) =>
  Number((await sql(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, values))[0].n);
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function eventNames(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => eventNames(item, into));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string" && /^(event|eventName|triggerEventName)$/.test(key)) into.add(item);
      else eventNames(item, into);
    }
  }
  return into;
}

async function reset(): Promise<void> {
  await sql(`TRUNCATE journey_publishes, journey_drafts, campaign_nodes, campaigns, user_metric_definitions,
    user_event_fields, user_events, segments, system_users CASCADE`);
  for (const user of [LAN, HOA]) {
    await sql("INSERT INTO system_users (id, email, role, oidc_issuer, oidc_subject) VALUES ($1, $2, $3, 'idp', $1)", [user.userId, user.email, user.role]);
  }
  const names = new Set<string>();
  fixtures.forEach((fixture) => eventNames(fixture.root, names));
  for (const name of names) await sql("INSERT INTO user_events (id, event_name) VALUES ($1, $1)", [name]);
}

async function draftRow(id: string, owner: AdminSession, root: unknown, version = 1): Promise<void> {
  await sql(
    "INSERT INTO journey_drafts (id, owner_id, name, root, origin, version) VALUES ($1, $2, 'Cart reminder', $3, 'blank', $4)",
    [id, owner.userId, JSON.stringify(root), version],
  );
}

// What a publish that writes nothing must leave alone.
async function snapshot() {
  return {
    campaigns: await sql("SELECT id, name, root, created_user, updated_at::text FROM campaigns ORDER BY id"),
    nodes: await sql("SELECT * FROM campaign_nodes ORDER BY campaign_id, node_id"),
    publishes: await sql("SELECT campaign_id, draft_id, root_hash FROM journey_publishes ORDER BY campaign_id"),
    drafts: await sql("SELECT id, version, root FROM journey_drafts ORDER BY id"),
  };
}

// Starting PGlite and applying the schema takes seconds, more under a full parallel run.
beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://pglite-bridge";
  await bridge.ready();
}, 120_000);
afterAll(() => bridge.stop());
beforeEach(async () => {
  await reset();
  signIn(LAN);
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("draft actions (JBD-FR-26, JBD-NFR-02)", () => {
  it("creates a draft under a fresh campaign id, owned by the caller, at version 1", async () => {
    const created = await createDraftAction({ name: "Cart reminder", root: JOURNEY, origin: "blank" });
    expect(created).toEqual({ id: expect.stringMatching(/^CAMP-[0-9A-F]{16}$/), version: 1 });
    const [row] = await sql("SELECT owner_id, origin, version, root FROM journey_drafts");
    expect(row).toEqual({ owner_id: LAN.userId, origin: "blank", version: 1, root: JOURNEY });
  });

  it("refuses a new draft with no name or an origin a marketer cannot start from", async () => {
    expect(await createDraftAction({ name: " ", root: JOURNEY, origin: "blank" })).toEqual({ error: "Give the journey a name." });
    expect(await createDraftAction({ name: "A", root: JOURNEY, origin: "browser" })).toHaveProperty("error");
    expect(await count("journey_drafts")).toBe(0);
  });

  it("lists only the caller's drafts", async () => {
    await createDraftAction({ name: "Lan's", root: JOURNEY, origin: "template:cart" });
    signIn(HOA);
    await createDraftAction({ name: "Hoa's", root: JOURNEY, origin: "ai" });
    const listed = await listMyDraftsAction();
    expect("drafts" in listed && listed.drafts.map((draft) => [draft.name, draft.origin])).toEqual([["Hoa's", "ai"]]);
  });

  it("raises the version by one on each save", async () => {
    const created = (await createDraftAction({ name: "Cart reminder", root: JOURNEY, origin: "blank" })) as { id: string };
    const edited = { ...JOURNEY, label: "Edited" };
    expect(await saveDraftAction({ id: created.id, version: 1, name: "Cart reminder", root: edited })).toEqual({ status: "saved", version: 2 });
    const [row] = await sql("SELECT version, root FROM journey_drafts");
    expect(row).toEqual({ version: 2, root: edited });
  });

  it("refuses tab B's save after tab A saved, keeps tab A's edit, and stores Keep mine as a new version", async () => {
    const { id } = (await createDraftAction({ name: "Cart reminder", root: JOURNEY, origin: "blank" })) as { id: string };
    const tabA = { ...JOURNEY, label: "Tab A" };
    const tabB = { ...JOURNEY, label: "Tab B" };
    await saveDraftAction({ id, version: 1, name: "Cart reminder", root: tabA });

    const refused = await saveDraftAction({ id, version: 1, name: "Cart reminder", root: tabB });
    expect(refused).toMatchObject({ status: "conflict", draft: { id, version: 2, root: tabA } });
    expect((await sql("SELECT root FROM journey_drafts"))[0].root).toEqual(tabA);

    expect(await saveDraftAction({ id, version: 2, name: "Cart reminder", root: tabB })).toEqual({ status: "saved", version: 3 });
    expect((await sql("SELECT root FROM journey_drafts"))[0].root).toEqual(tabB);
  });

  it("treats another user's draft as no draft: no save, no delete", async () => {
    const { id } = (await createDraftAction({ name: "Cart reminder", root: JOURNEY, origin: "blank" })) as { id: string };
    signIn({ ...HOA, role: "admin" });
    expect(await saveDraftAction({ id, version: 1, name: "Taken", root: {} })).toEqual({ status: "missing" });
    expect(await deleteDraftAction(id)).toEqual({ status: "deleted" });
    expect(await sql("SELECT name, version FROM journey_drafts")).toEqual([{ name: "Cart reminder", version: 1 }]);
  });

  it("deletes the caller's draft, and a repeated delete converges", async () => {
    const { id } = (await createDraftAction({ name: "Cart reminder", root: JOURNEY, origin: "blank" })) as { id: string };
    expect(await deleteDraftAction(id)).toEqual({ status: "deleted" });
    expect(await deleteDraftAction(id)).toEqual({ status: "deleted" });
    expect(await count("journey_drafts")).toBe(0);
  });
});

describe("publish from the stored draft (JBD-FR-27, CMP-FR-01)", () => {
  const ID = "CAMP-1111111111111111";
  const publish = (version = 1, extra: Record<string, unknown> = {}) => publishDraftAction({ draftId: ID, version, ...extra });

  it("publishes a draft with no campaign of its id: campaign, node rows, publish row, and no draft", async () => {
    await draftRow(ID, LAN, JOURNEY);
    const [{ text }] = await sql("SELECT root::text AS text FROM journey_drafts");

    expect(await publish()).toEqual({ status: "published", campaignId: ID });

    expect(await sql("SELECT id, status, created_user FROM campaigns")).toEqual([{ id: ID, status: "active", created_user: LAN.userId }]);
    expect(await count("campaign_nodes", "campaign_id = $1", [ID])).toBeGreaterThan(0);
    expect(await sql("SELECT campaign_id, draft_id, root_hash FROM journey_publishes")).toEqual([
      { campaign_id: ID, draft_id: ID, root_hash: sha256(String(text)) },
    ]);
    expect(await count("journey_drafts")).toBe(0);
  });

  it("publishes the stored root, not a tree the browser sends", async () => {
    await draftRow(ID, LAN, JOURNEY);
    await publish(1, { root: { ...JOURNEY, label: "From the browser" } });
    expect((await sql("SELECT root FROM campaigns"))[0].root).toEqual(JOURNEY);
  });

  it("reports Already published and writes nothing when a committed publish is retried", async () => {
    await draftRow(ID, LAN, JOURNEY);
    await publish();
    const before = await snapshot();
    expect(await publish()).toEqual({ status: "already_published", campaignId: ID });
    expect(await snapshot()).toEqual(before);
  });

  it("deletes a leftover draft with the published root hash and writes nothing else", async () => {
    await draftRow(ID, LAN, JOURNEY);
    await publish();
    await draftRow(ID, LAN, JOURNEY);
    const { drafts, ...before } = await snapshot();
    expect(drafts).toHaveLength(1);

    expect(await publish()).toEqual({ status: "already_published", campaignId: ID });
    const { drafts: after, ...rest } = await snapshot();
    expect(after).toEqual([]);
    expect(rest).toEqual(before);
  });

  it("refuses a collision with a classic publish of the same id, then publishes as a new journey", async () => {
    await db.publishCampaign(parseCampaignForPublish({ id: ID, name: "Classic", root: JOURNEY }), HOA.userId, flattenCampaignTree);
    await draftRow(ID, LAN, { ...JOURNEY, label: "Mine" });
    const before = await snapshot();
    expect(await publish()).toEqual({ status: "collision" });
    expect(await snapshot()).toEqual(before);

    const asNew = await publish(1, { asNewJourney: true });
    expect(asNew).toEqual({ status: "published", campaignId: expect.stringMatching(/^CAMP-[0-9A-F]{16}$/) });
    const newId = (asNew as { campaignId: string }).campaignId;
    expect(newId).not.toBe(ID);
    expect(await sql("SELECT campaign_id, draft_id FROM journey_publishes")).toEqual([{ campaign_id: newId, draft_id: ID }]);
    expect(await count("journey_drafts")).toBe(0);
    const after = await snapshot();
    expect(after.campaigns.find((row) => row.id === ID)).toEqual(before.campaigns.find((row) => row.id === ID));
    expect(after.nodes.filter((row) => row.campaign_id === ID)).toEqual(before.nodes);
  });

  it("refuses a draft and a campaign of its id whose publish row names a different root", async () => {
    await draftRow(ID, LAN, JOURNEY);
    await publish();
    await draftRow(ID, LAN, { ...JOURNEY, label: "Changed" });
    const before = await snapshot();
    expect(await publish()).toEqual({ status: "collision" });
    expect(await snapshot()).toEqual(before);
  });

  it("opens the new journey when either publish of a draft published as a new journey is retried", async () => {
    const OLD = "CAMP-2222222222222222";
    await sql("INSERT INTO campaigns (id, name, status, root) VALUES ($1, 'Classic', 'active', '{}')", [OLD]);
    await draftRow(OLD, LAN, JOURNEY);
    const { campaignId: newId } = (await publishDraftAction({ draftId: OLD, version: 1, asNewJourney: true })) as { campaignId: string };
    const before = await snapshot();

    expect(await publishDraftAction({ draftId: OLD, version: 1, asNewJourney: true })).toEqual({ status: "already_published", campaignId: newId });
    expect(await publishDraftAction({ draftId: OLD, version: 1 })).toEqual({ status: "already_published", campaignId: newId });
    expect(await snapshot()).toEqual(before);
  });

  it("writes nothing and keeps the draft's old id when Publish as a new journey fails after its campaign row", async () => {
    const OLD = "CAMP-2222222222222222";
    await sql("INSERT INTO campaigns (id, name, status, root) VALUES ($1, 'Classic', 'active', '{}')", [OLD]);
    await draftRow(OLD, LAN, JOURNEY);
    const before = await snapshot();
    bridge.fail(/INSERT INTO journey_publishes/);

    expect(await publishDraftAction({ draftId: OLD, version: 1, asNewJourney: true })).toEqual({ error: "Failed to publish the journey." });
    expect(await snapshot()).toEqual(before);
    expect(await sql("SELECT id FROM journey_drafts")).toEqual([{ id: OLD }]);
  });

  it("writes nothing and keeps the draft when a publish fails at its last step (CMP-FR-01)", async () => {
    await draftRow(ID, LAN, JOURNEY);
    const before = await snapshot();
    bridge.fail(/DELETE FROM journey_drafts/);
    expect(await publish()).toEqual({ error: "Failed to publish the journey." });
    expect(await snapshot()).toEqual(before);
    expect(await count("user_metric_definitions")).toBe(0);
  });

  it("refuses as a collision a campaign of the draft's id that another publisher commits during the publish", async () => {
    await draftRow(ID, LAN, JOURNEY);
    const before = await snapshot();
    bridge.fail(/INSERT INTO campaigns/, { code: "23505", constraint: "campaigns_pkey" });
    expect(await publish()).toEqual({ status: "collision" });
    expect(await snapshot()).toEqual(before);
  });

  it("says the draft no longer exists when a classic campaign has its id and no publish row names it", async () => {
    const GONE = "CAMP-4444444444444444";
    await sql("INSERT INTO campaigns (id, name, status, root) VALUES ($1, 'Classic', 'active', '{}')", [GONE]);
    const before = await snapshot();
    expect(await publishDraftAction({ draftId: GONE, version: 1 })).toEqual({ status: "draft_missing" });
    expect(await snapshot()).toEqual(before);
  });

  it("says the draft no longer exists when there is neither a draft nor a campaign", async () => {
    expect(await publish()).toEqual({ status: "draft_missing" });
    expect(await count("campaigns")).toBe(0);
  });

  it("refuses a publish that names a version older than the stored draft's", async () => {
    await draftRow(ID, LAN, JOURNEY, 7);
    const before = await snapshot();
    expect(await publish(6)).toEqual({ status: "stale", version: 7 });
    expect(await snapshot()).toEqual(before);
  });

  it("refuses another user's draft as missing", async () => {
    await draftRow(ID, HOA, JOURNEY);
    const before = await snapshot();
    expect(await publish()).toEqual({ status: "draft_missing" });
    expect(await snapshot()).toEqual(before);
  });

  it("refuses an unfinished journey with every blocking problem and writes nothing", async () => {
    await draftRow(ID, LAN, { type: "setup", id: "setup", label: "Start" });
    const before = await snapshot();
    const result = await publish();
    expect(result).toMatchObject({ status: "invalid" });
    expect((result as { problems: unknown[] }).problems.length).toBeGreaterThan(0);
    expect(await snapshot()).toEqual(before);
  });
});

// The classic publish path and the publish from a draft must write the same node rows for one
// journey, node ids included, or the runtime would run a journey differently by where it came from.
describe("the same node rows as classic publish", () => {
  const ID = "CAMP-5555555555555555";
  const nodeRows = () => sql("SELECT * FROM campaign_nodes ORDER BY node_id").then((rows) => rows.map((row) => ({ ...row, graph_version: undefined })));

  it.each(fixtures.map((fixture) => [fixture.name, fixture.root]))("%s", async (_name, root) => {
    await db.publishCampaign(parseCampaignForPublish({ id: ID, name: "Classic", root }), LAN.userId, flattenCampaignTree);
    const classic = await nodeRows();
    const definitions = await sql("SELECT id, processing_mode, retention_ms FROM user_metric_definitions ORDER BY id");

    await reset();
    await draftRow(ID, LAN, root);
    expect(await publishDraftAction({ draftId: ID, version: 1 })).toEqual({ status: "published", campaignId: ID });

    expect(classic.length).toBeGreaterThan(0);
    expect(await nodeRows()).toEqual(classic);
    expect(await sql("SELECT id, processing_mode, retention_ms FROM user_metric_definitions ORDER BY id")).toEqual(definitions);
  });
});

describe("every draft action needs a session (CMP-NFR-02)", () => {
  beforeEach(() => signIn(null));

  it.each([
    ["list", () => listMyDraftsAction()],
    ["create", () => createDraftAction({ name: "A", root: JOURNEY, origin: "blank" })],
    ["save", () => saveDraftAction({ id: "CAMP-1111111111111111", version: 1, name: "A", root: JOURNEY })],
    ["delete", () => deleteDraftAction("CAMP-1111111111111111")],
    ["publish", () => publishDraftAction({ draftId: "CAMP-1111111111111111", version: 1 })],
  ])("%s is refused and touches nothing", async (_name, action) => {
    await draftRow("CAMP-1111111111111111", LAN, JOURNEY);
    const before = await snapshot();
    expect(await action()).toEqual({ error: "Unauthorized" });
    expect(await snapshot()).toEqual(before);
  });
});
