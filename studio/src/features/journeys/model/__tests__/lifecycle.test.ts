/** @jest-environment node */
import type { AdminSession } from "@/shared/auth/types";
import {
  deleteJourneyAction,
  duplicateJourneyAction,
  pauseJourneyAction,
  peopleInJourneyAction,
  resumeJourneyAction,
} from "../actions";
import { templateByKey } from "../templates";
import { bridge } from "../../../../shared/testing/pgBridge";

jest.mock("../../../../../../shared/node_modules/pg", () => jest.requireActual("../../../../shared/testing/pgBridge").bridge.pgModule());
jest.mock("server-only", () => ({}));
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }));
const currentSession = () => (globalThis as { mockSession?: AdminSession | null }).mockSession;
jest.mock("@/shared/auth/session", () => ({
  assertSession: async () => {
    const session = currentSession();
    if (!session) throw new (jest.requireActual("shared/lib/userFacingError").UserFacingError)("Unauthorized");
    return session;
  },
}));
jest.mock("../../../../widgets/v2-shell/model/viewer", () => ({
  requireViewer: async () => {
    const session = currentSession();
    if (!session) throw new Error("NEXT_REDIRECT");
    return session;
  },
}));

const LAN: AdminSession = { userId: "user_lan", email: "lan@example.com", role: "editor" };
const HOA: AdminSession = { userId: "user_hoa", email: "hoa@example.com", role: "editor" };
const MINH: AdminSession = { userId: "user_minh", email: "minh@example.com", role: "admin" };
const signIn = (session: AdminSession | null) => {
  (globalThis as { mockSession?: AdminSession | null }).mockSession = session;
};

const CART = templateByKey("cart")!;
const ID = "CAMP-00000000000000A1";

const sql = (text: string, values: unknown[] = []) => bridge.query(text, values).then((result) => result.rows);

async function campaign(status: "active" | "paused", owner: AdminSession | null = LAN): Promise<void> {
  await sql("INSERT INTO campaigns (id, name, description, status, root, created_user) VALUES ($1, 'Welcome series', 'Hi', $2, $3, $4)", [
    ID,
    status,
    JSON.stringify(CART.root),
    owner?.userId ?? null,
  ]);
}

const stored = async () => (await sql("SELECT status FROM campaigns WHERE id = $1", [ID]))[0]?.status ?? null;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://pglite-bridge";
  await bridge.ready();
}, 120_000);
afterAll(() => bridge.stop());
beforeEach(async () => {
  await sql(`TRUNCATE journey_publishes, journey_drafts, campaign_nodes, campaigns, user_metric_definitions,
    user_event_fields, user_events, user_campaign_state_transitions, system_users CASCADE`);
  for (const user of [LAN, HOA, MINH]) {
    await sql("INSERT INTO system_users (id, email, role, oidc_issuer, oidc_subject) VALUES ($1, $2, $3, 'idp', $1)", [user.userId, user.email, user.role]);
  }
  for (const need of CART.needs) await sql("INSERT INTO user_events (id, event_name) VALUES ($1, $1)", [need.name]);
  signIn(LAN);
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("pause and resume (CMP-FR-04, CMP-FR-05, CMP-FR-07)", () => {
  it("lets the owner pause an active journey and resume it, rebuilding its node rows from the stored tree", async () => {
    await campaign("active");

    expect(await pauseJourneyAction(ID)).toEqual({ status: "paused" });
    expect(await stored()).toBe("paused");
    expect(await resumeJourneyAction(ID)).toEqual({ status: "active" });
    expect(await stored()).toBe("active");
    expect(Number((await sql("SELECT count(*)::int AS n FROM campaign_nodes WHERE campaign_id = $1", [ID]))[0].n)).toBeGreaterThan(0);
  });

  it("refuses an editor who does not own the journey, and changes nothing", async () => {
    await campaign("active");
    signIn(HOA);

    expect(await pauseJourneyAction(ID)).toHaveProperty("error");
    expect(await stored()).toBe("active");
  });

  it("lets an admin pause a journey with no owner", async () => {
    await campaign("active", null);
    signIn(MINH);

    expect(await pauseJourneyAction(ID)).toEqual({ status: "paused" });
  });

  it("refuses to pause a paused journey", async () => {
    await campaign("paused");

    expect(await pauseJourneyAction(ID)).toHaveProperty("error");
    expect(await stored()).toBe("paused");
  });
});

describe("delete (CMP-FR-06, CMP-FR-07, CMP-FR-19)", () => {
  it("lets the owner delete the journey and its node rows", async () => {
    await campaign("active");
    await resumeOrNodes();

    expect(await deleteJourneyAction(ID)).toEqual({ status: "deleted" });
    expect(await stored()).toBeNull();
    expect(await sql("SELECT * FROM campaign_nodes WHERE campaign_id = $1", [ID])).toEqual([]);
  });

  it("refuses an editor who does not own the journey", async () => {
    await campaign("paused");
    signIn(HOA);

    expect(await deleteJourneyAction(ID)).toHaveProperty("error");
    expect(await stored()).toBe("paused");
  });

  it("counts nobody in a journey nobody entered", async () => {
    await campaign("active");

    expect(await peopleInJourneyAction(ID)).toEqual({ people: 0 });
  });

  async function resumeOrNodes(): Promise<void> {
    await pauseJourneyAction(ID);
    await resumeJourneyAction(ID);
  }
});

describe("duplicate (CMP-FR-09)", () => {
  it("copies a colleague's published journey into a draft of the caller's own", async () => {
    await campaign("active");
    signIn(HOA);

    const copy = await duplicateJourneyAction(ID);

    expect(copy).toEqual({ id: expect.stringMatching(/^CAMP-[0-9A-F]{16}$/), version: 1 });
    const [row] = await sql("SELECT owner_id, name, description, origin, root FROM journey_drafts");
    expect(row).toEqual({ owner_id: HOA.userId, name: "Copy of Welcome series", description: "Hi", origin: `duplicate:${ID}`, root: CART.root });
    expect(await stored()).toBe("active");
  });

  it("says the journey is missing when no published journey has the id", async () => {
    expect(await duplicateJourneyAction("CAMP-FFFFFFFFFFFFFFFF")).toEqual({ status: "missing" });
    expect(await sql("SELECT * FROM journey_drafts")).toEqual([]);
  });
});

describe("every lifecycle action needs a session (CMP-NFR-02)", () => {
  it.each([
    ["pause", () => pauseJourneyAction(ID)],
    ["resume", () => resumeJourneyAction(ID)],
    ["delete", () => deleteJourneyAction(ID)],
    ["duplicate", () => duplicateJourneyAction(ID)],
    ["count", () => peopleInJourneyAction(ID)],
  ])("%s is refused and touches nothing", async (_name, action) => {
    await campaign("active");
    signIn(null);

    expect(await action()).toEqual({ error: "Unauthorized" });
    expect(await stored()).toBe("active");
    expect(await sql("SELECT * FROM journey_drafts")).toEqual([]);
  });
});
