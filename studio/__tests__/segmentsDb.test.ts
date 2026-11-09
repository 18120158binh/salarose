/** @jest-environment node */

// The segment functions in shared/lib/db.ts talk to Postgres through a pg Pool. These tests
// replace the pool with a small model of segments, campaigns and their node rows, the event
// catalog, and metric definitions, so each test can save, delete, or pause and then read what
// is stored.
interface MockStatement {
  text: string;
  values: unknown[];
}
interface MockCampaign {
  id: string;
  name: string;
  status: string;
  // The campaign's created_user, or none when that user was deleted.
  ownerId?: string;
  // A node row as to_jsonb(campaign_nodes) returns it.
  node: Record<string, unknown>;
}
interface MockWorld {
  segments: Map<string, { name: string; description: string; conditions_json: unknown; creator?: string }>;
  campaigns: MockCampaign[];
  metrics: Map<string, { processing_mode: string; name: string; filter_conditions: string; created_by?: unknown }>;
}

const mockStatements: MockStatement[] = [];
let mockWorld: MockWorld;

jest.mock("../../shared/node_modules/pg", () => {
  const result = (rows: Record<string, unknown>[]) => ({ rows, rowCount: rows.length });
  const query = async (rawText: string, values: unknown[] = []) => {
    const text = rawText.replace(/\s+/g, " ").trim();
    mockStatements.push({ text, values });
    const world = mockWorld;
    if (text.includes("to_jsonb(campaign_nodes)")) {
      return result(world.campaigns
        .filter((campaign) => campaign.status === "active" || campaign.status === "paused")
        .map((campaign) => ({ campaign_id: campaign.id, campaign_name: campaign.name, status: campaign.status, owner_id: campaign.ownerId ?? null, node: campaign.node })));
    }
    if (text.startsWith("SELECT name, description, conditions_json FROM segments WHERE id = $1 FOR UPDATE")) {
      const segment = world.segments.get(String(values[0]));
      return result(segment ? [{ ...segment }] : []);
    }
    if (text.startsWith("SELECT id FROM segments WHERE id = $1 FOR UPDATE")) {
      return result(world.segments.has(String(values[0])) ? [{ id: values[0] }] : []);
    }
    if (text.startsWith("SELECT id, name, description, conditions_json, updated_at FROM segments")) {
      return result([...world.segments].map(([id, segment]) => ({ id, ...segment, updated_at: null })));
    }
    if (text.includes("FROM segments LEFT JOIN system_users") && text.endsWith("WHERE segments.id = $1")) {
      const segment = world.segments.get(String(values[0]));
      return result(segment ? [{ id: values[0], ...segment, created_by: segment.creator ?? null, created_at: "2026-11-03T08:42:00Z", updated_at: null }] : []);
    }
    if (text.includes("FROM segments LEFT JOIN system_users")) {
      return result([...world.segments].map(([id, segment]) => ({
        id, name: segment.name, description: segment.description, updated_at: null, created_by: segment.creator ?? null,
      })));
    }
    if (text === "SELECT id, conditions_json FROM segments") {
      return result([...world.segments].map(([id, segment]) => ({ id, conditions_json: segment.conditions_json })));
    }
    if (text.startsWith("SELECT id, event_name, display_name FROM user_events WHERE event_name")) {
      return result(values[0] === "add_to_cart" ? [{ id: "ue_cart", event_name: "add_to_cart", display_name: "Add to cart" }] : []);
    }
    if (text.startsWith("SELECT event_name, display_name FROM user_events WHERE id")) {
      return result([{ event_name: "add_to_cart", display_name: "Add to cart" }]);
    }
    if (text.startsWith("INSERT INTO user_metric_definitions")) {
      const id = String(values[0]);
      if (!world.metrics.has(id)) {
        world.metrics.set(id, {
          processing_mode: "PAUSED", name: String(values[1]), filter_conditions: String(values[6]), created_by: values[10],
        });
      }
      return result([]);
    }
    if (text.startsWith("UPDATE user_metric_definitions SET processing_mode")) {
      const live = new Set(values[0] as string[]);
      for (const [id, metric] of world.metrics) metric.processing_mode = live.has(id) ? "LIVE" : "PAUSED";
      return result([]);
    }
    if (text.startsWith("INSERT INTO segments")) {
      world.segments.set(String(values[0]), {
        name: String(values[1]),
        description: String(values[2]),
        conditions_json: JSON.parse(String(values[3])),
      });
      return result([{}]);
    }
    if (text.startsWith("DELETE FROM segments")) {
      world.segments.delete(String(values[0]));
      return result([{}]);
    }
    if (text.startsWith("SELECT created_user, status, root FROM campaigns")) {
      const campaign = world.campaigns.find((item) => item.id === values[0]);
      return result(campaign ? [{ created_user: "u1", status: campaign.status, root: {} }] : []);
    }
    if (text.startsWith("UPDATE campaigns SET status")) {
      const campaign = world.campaigns.find((item) => item.id === values[1]);
      if (campaign) campaign.status = String(values[0]);
      return result([{}]);
    }
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
  behaviorMetricId,
  deleteSegment,
  ensureDbInitialized,
  getSegmentDetail,
  listSegmentSummaries,
  listSegments,
  saveSegment,
  updateCampaignStatus,
} from "@/lib/db";
import { parseSegmentInput, type SegmentId } from "shared/lib/segments";
import { UserFacingError } from "shared/lib/userFacingError";

const SEGMENT_ID = "SEG-4f1c9a0b2d3e5f67" as SegmentId;

const hanoiCartBuilders = () => parseSegmentInput({
  name: "Hanoi cart builders",
  description: "",
  conditions: {
    groups: [
      { conditions: [{ type: "profile_property", field: "city", op: "IN", value: ["Hanoi"] }] },
      {
        conditions: [{
          type: "behavior", event: "add_to_cart", measure: "COUNT",
          window: { value: 7, unit: "DAYS" }, op: ">=", value: 3,
        }],
      },
    ],
  },
});

// A campaign whose check node tests "is in" the segment.
function campaignUsing(id: string, name: string, status: string, segmentId: string = SEGMENT_ID): MockCampaign {
  return {
    id,
    name,
    status,
    node: {
      campaign_id: id,
      node_id: "check_1",
      condition_json: JSON.stringify({
        groups: [{ conditions: [{ type: "segment_membership", segment_id: segmentId, op: "in" }] }],
      }),
      campaign_node_count: 3,
    },
  };
}

// Saves the contract's segment under SEGMENT_ID and returns the metric id its save derived.
async function storeHanoiCartBuilders(): Promise<string> {
  const created = await saveSegment(hanoiCartBuilders(), "u1");
  if (!created.saved) throw new Error("the segment was not saved");
  const stored = mockWorld.segments.get(created.id)!;
  mockWorld.segments.delete(created.id);
  mockWorld.segments.set(SEGMENT_ID, stored);
  const behavior = (stored.conditions_json as { groups: { conditions: { metric_id?: string }[] }[] }).groups[1].conditions[0];
  return behavior.metric_id!;
}

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://test";
  mockWorld = { segments: new Map(), campaigns: [], metrics: new Map() };
  await ensureDbInitialized();
});

beforeEach(() => {
  mockStatements.length = 0;
  mockWorld = { segments: new Map(), campaigns: [], metrics: new Map() };
});

describe("saveSegment", () => {
  it("stores the segment with two groups and derives a LIVE metric definition for its behavior condition (SEG-FR-06)", async () => {
    const result = await saveSegment(hanoiCartBuilders(), "u1");

    expect(result).toEqual({ saved: true, id: expect.stringMatching(/^SEG-[0-9a-f]{16}$/) });
    const stored = mockWorld.segments.get((result as { id: string }).id)!;
    const groups = (stored.conditions_json as { groups: { conditions: Record<string, unknown>[] }[] }).groups;
    expect(groups).toHaveLength(2);
    const metricId = groups[1].conditions[0].metric_id as string;
    expect(metricId).toMatch(/^m_[0-9a-f]{16}$/);
    expect(mockWorld.metrics.get(metricId)).toEqual({
      processing_mode: "LIVE", name: "COUNT add_to_cart", filter_conditions: "{}", created_by: "u1",
    });
  });

  it("takes the metric-definitions lock before it reads the catalog, as an event delete or field change does (CAT-FR-08, CAT-FR-11)", async () => {
    await saveSegment(hanoiCartBuilders(), "u1");

    const texts = mockStatements.map((statement) => statement.text);
    const lock = texts.indexOf("SELECT pg_advisory_xact_lock(hashtext('user_metric_definitions'))");
    expect(lock).toBeGreaterThan(texts.indexOf("BEGIN"));
    expect(lock).toBeLessThan(texts.findIndex((text) => text.includes("INSERT INTO segments")));
  });

  it("derives one metric id for two conditions that count the same thing over different windows", async () => {
    const input = hanoiCartBuilders();
    input.conditions.groups.push({
      conditions: [{ type: "behavior", event: "add_to_cart", measure: "COUNT", window: { value: 30, unit: "DAYS" }, op: "<", value: 10 }],
    });

    const result = await saveSegment(input, "u1");

    const groups = (mockWorld.segments.get((result as { id: string }).id)!.conditions_json as {
      groups: { conditions: { metric_id?: string }[] }[];
    }).groups;
    expect(groups[2].conditions[0].metric_id).toBe(groups[1].conditions[0].metric_id);
    expect(mockWorld.metrics.size).toBe(1);
  });

  it("refuses a behavior condition on an event that is not in the catalog, and names the event", async () => {
    const input = hanoiCartBuilders();
    Object.assign(input.conditions.groups[1].conditions[0], { event: "add_to_wishlist" });

    await expect(saveSegment(input, "u1")).rejects.toThrow(new UserFacingError("Event add_to_wishlist is not in the catalog."));
    expect(mockWorld.segments.size).toBe(0);
    expect(mockStatements.at(-1)?.text).toBe("ROLLBACK");
  });

  it("asks to confirm an edit while two active campaigns use the segment, naming both, and writes nothing", async () => {
    await storeHanoiCartBuilders();
    mockWorld.campaigns = [campaignUsing("CAMP-A", "Cart rescue", "active"), campaignUsing("CAMP-B", "VIP push", "active")];
    const edit = { ...hanoiCartBuilders(), id: SEGMENT_ID, name: "Renamed" };

    const result = await saveSegment(edit, "u1");

    expect(result).toEqual({
      saved: false,
      confirm: [
        { campaignId: "CAMP-A", campaignName: "Cart rescue", status: "active", kinds: ["condition"], ownerId: null },
        { campaignId: "CAMP-B", campaignName: "VIP push", status: "active", kinds: ["condition"], ownerId: null },
      ],
    });
    expect(mockWorld.segments.get(SEGMENT_ID)?.name).toBe("Hanoi cart builders");
  });

  it("writes a confirmed change of city, so the decision job reads the new definition through CDC", async () => {
    await storeHanoiCartBuilders();
    mockWorld.campaigns = [campaignUsing("CAMP-A", "Cart rescue", "active")];
    const edit = { ...hanoiCartBuilders(), id: SEGMENT_ID };
    Object.assign(edit.conditions.groups[0].conditions[0], { value: ["Da Nang"] });

    const result = await saveSegment(edit, "u1", ["CAMP-A"]);

    expect(result).toEqual({ saved: true, id: SEGMENT_ID });
    const groups = (mockWorld.segments.get(SEGMENT_ID)!.conditions_json as { groups: { conditions: { value?: unknown }[] }[] }).groups;
    expect(groups[0].conditions[0].value).toEqual(["Da Nang"]);
  });
});

describe("behaviorMetricId", () => {
  it("pins the id of a condition with an attribute and filters, as campaign management's example gives it", () => {
    const parsed = parseSegmentInput({
      name: "Phone buyers",
      conditions: { groups: [{ conditions: [{
        type: "behavior", event: " add_to_cart ", measure: "sum", attribute: "product.price",
        filters: { groups: [{ conditions: [
          { type: "event_property", field: "product.category", op: "IN", value: [" phones", "tablets "] },
          { type: "event_property", field: "product.price", op: ">", value: 500000 },
        ] }] },
        window: { value: 30, unit: "DAYS" }, op: ">=", value: 1,
      }] }] },
    });
    const condition = parsed.conditions.groups[0].conditions[0];
    if (condition.type !== "behavior") throw new Error("not a behavior condition");

    expect(behaviorMetricId(condition)).toBe("m_514afd5c430cce3b");
    expect(behaviorMetricId({ ...condition, filters: undefined })).not.toBe("m_514afd5c430cce3b");
  });

  it("treats filters with no groups as no filters, and a string threshold as another value", () => {
    const base = { type: "behavior", event: "add_to_cart", measure: "COUNT", window: { value: 7, unit: "DAYS" }, op: ">=", value: 3 };
    const metricOf = (condition: Record<string, unknown>) => {
      const parsed = parseSegmentInput({ name: "s", conditions: { groups: [{ conditions: [condition] }] } }).conditions.groups[0].conditions[0];
      if (parsed.type !== "behavior") throw new Error("not a behavior condition");
      return behaviorMetricId(parsed);
    };
    const filtered = (value: unknown) => metricOf({ ...base, filters: { groups: [{ conditions: [{ type: "event_property", field: "product.price", op: "=", value }] }] } });

    expect(metricOf({ ...base, filters: { groups: [] } })).toBe(metricOf(base));
    expect(filtered(500000)).not.toBe(filtered("500000"));
  });
});

describe("creating a segment again", () => {
  const NEW_ID = "SEG-00000000000000aa" as SegmentId;

  it("changes nothing when the same create arrives twice", async () => {
    const create = { ...hanoiCartBuilders(), id: NEW_ID, create: true };

    expect(await saveSegment(create, "u1")).toEqual({ saved: true, id: NEW_ID });
    const first = structuredClone(mockWorld.segments.get(NEW_ID));
    mockStatements.length = 0;
    expect(await saveSegment({ ...hanoiCartBuilders(), id: NEW_ID, create: true }, "u1")).toEqual({ saved: true, id: NEW_ID });

    expect(mockWorld.segments.size).toBe(1);
    expect(mockWorld.segments.get(NEW_ID)).toEqual(first);
    expect(mockStatements.some((s) => s.text.startsWith("INSERT INTO segments"))).toBe(false);
  });

  it("refuses a create whose id holds another segment", async () => {
    await saveSegment({ ...hanoiCartBuilders(), id: NEW_ID, create: true }, "u1");

    await expect(saveSegment({ ...hanoiCartBuilders(), id: NEW_ID, create: true, name: "Other" }, "u1"))
      .rejects.toThrow(new UserFacingError(`Segment ${NEW_ID} already exists.`));
    expect(mockWorld.segments.get(NEW_ID)?.name).toBe("Hanoi cart builders");
  });
});

describe("metric processing modes", () => {
  it("makes the metric of a segment that no campaign uses LIVE at save, and PAUSED once it is deleted", async () => {
    const metricId = await storeHanoiCartBuilders();
    expect(mockWorld.metrics.get(metricId)?.processing_mode).toBe("LIVE");

    await deleteSegment(SEGMENT_ID);
    expect(mockWorld.metrics.get(metricId)?.processing_mode).toBe("PAUSED");
  });

  it("keeps a segment's metric LIVE when the one active campaign that uses the segment is paused", async () => {
    const metricId = await storeHanoiCartBuilders();
    mockWorld.campaigns = [campaignUsing("CAMP-A", "Cart rescue", "active")];

    await updateCampaignStatus("CAMP-A", "paused", { userId: "u1", isAdmin: false }, () => []);
    expect(mockWorld.metrics.get(metricId)?.processing_mode).toBe("LIVE");
  });
});

describe("deleteSegment", () => {
  it("refuses while a paused campaign tests the segment, and names the campaign", async () => {
    await storeHanoiCartBuilders();
    mockWorld.campaigns = [campaignUsing("CAMP-P", "Winback", "paused")];

    await expect(deleteSegment(SEGMENT_ID)).rejects.toThrow(
      new UserFacingError("The segment cannot be deleted while campaigns use it: Winback (paused)."),
    );
    expect(mockWorld.segments.has(SEGMENT_ID)).toBe(true);
  });

  it("succeeds when the segment is already gone, as a retried delete finds it", async () => {
    await expect(deleteSegment(SEGMENT_ID)).resolves.toBeUndefined();
    expect(mockStatements.at(-1)?.text).toBe("COMMIT");
  });

  it("deletes a segment that no campaign uses", async () => {
    await storeHanoiCartBuilders();
    mockWorld.campaigns = [campaignUsing("CAMP-O", "Other", "active", "SEG-0000000000000000")];

    await deleteSegment(SEGMENT_ID);

    expect(mockWorld.segments.has(SEGMENT_ID)).toBe(false);
  });
});

describe("listSegments", () => {
  it("lists each segment with the campaigns that use it", async () => {
    await storeHanoiCartBuilders();
    mockWorld.campaigns = [campaignUsing("CAMP-A", "Cart rescue", "active")];

    expect(await listSegments()).toEqual([
      expect.objectContaining({
        id: SEGMENT_ID,
        name: "Hanoi cart builders",
        usedBy: [{ campaignId: "CAMP-A", campaignName: "Cart rescue", status: "active", kinds: ["condition"], ownerId: null }],
      }),
    ]);
  });
});

// A campaign whose node row holds the trigger and the conditions given, as JSON columns.
function campaignWithNode(id: string, name: string, status: string, columns: Record<string, unknown>): MockCampaign {
  const json = Object.fromEntries(Object.entries(columns).map(([column, value]) => [column, JSON.stringify(value)]));
  return { id, name, status, node: { campaign_id: id, node_id: "setup", campaign_node_count: 3, ...json } };
}

describe("getSegmentDetail (SEG-FR-01, SEG-FR-07)", () => {
  it("returns one segment's conditions, creator, creation time, and the journeys that use it", async () => {
    mockWorld.segments.set(SEGMENT_ID, { name: "Hanoi cart builders", description: "", conditions_json: hanoiCartBuilders().conditions, creator: "lan@example.com" });
    mockWorld.campaigns = [campaignUsing("CAMP-B", "VIP push", "paused")];

    const segment = await getSegmentDetail(SEGMENT_ID);

    expect(segment).toMatchObject({
      id: SEGMENT_ID,
      name: "Hanoi cart builders",
      createdBy: "lan@example.com",
      createdAt: "2026-11-03T08:42:00Z",
      usedBy: [{ campaignId: "CAMP-B", status: "paused", kinds: ["condition"] }],
    });
    expect(segment?.conditions.groups).toHaveLength(2);
  });

  it("returns null when no segment has the id", async () => {
    await expect(getSegmentDetail("SEG-0000000000000009" as SegmentId)).resolves.toBeNull();
  });
});

describe("listSegmentSummaries (SEG-FR-09)", () => {
  beforeEach(() => {
    mockWorld.segments.set(SEGMENT_ID, { name: "Hanoi cart builders", description: "", conditions_json: { groups: [] }, creator: "lan@example.com" });
    mockWorld.segments.set("SEG-0000000000000001", { name: "Idle", description: "", conditions_json: { groups: [] } });
  });

  it("names a campaign whose entry trigger uses the segment, and a paused one that tests it, with status, kind, and owner", async () => {
    mockWorld.campaigns = [
      { ...campaignWithNode("CAMP-A", "Cart rescue", "active", { trigger_json: { kind: "segment_entry", segment_id: SEGMENT_ID } }), ownerId: "u-lan" },
      campaignUsing("CAMP-B", "VIP push", "paused"),
    ];

    const [hanoi] = await listSegmentSummaries();

    expect(hanoi.usedBy).toEqual([
      { campaignId: "CAMP-A", campaignName: "Cart rescue", status: "active", kinds: ["entry_trigger"], ownerId: "u-lan" },
      { campaignId: "CAMP-B", campaignName: "VIP push", status: "paused", kinds: ["condition"], ownerId: null },
    ]);
  });

  it("lists a campaign once, with every way its nodes use the segment", async () => {
    mockWorld.campaigns = [
      campaignWithNode("CAMP-C", "Back in stock", "active", {
        trigger_json: { kind: "business_event", event: "back_in_stock", audience: { type: "segment", segment_id: SEGMENT_ID } },
      }),
      campaignUsing("CAMP-C", "Back in stock", "active"),
    ];

    const [hanoi] = await listSegmentSummaries();

    expect(hanoi.usedBy).toEqual([
      { campaignId: "CAMP-C", campaignName: "Back in stock", status: "active", kinds: ["event_audience", "condition"], ownerId: null },
    ]);
  });

  it("lists every segment with its creator, or none when the creator's user is gone", async () => {
    const summaries = await listSegmentSummaries();

    expect(summaries.map(({ name, createdBy, usedBy }) => ({ name, createdBy, usedBy }))).toEqual([
      { name: "Hanoi cart builders", createdBy: "lan@example.com", usedBy: [] },
      { name: "Idle", createdBy: null, usedBy: [] },
    ]);
  });

  it("only reads (SEG-FR-10)", async () => {
    await listSegmentSummaries();

    expect(mockStatements.length).toBeGreaterThan(0);
    expect(mockStatements.every((statement) => statement.text.startsWith("SELECT"))).toBe(true);
  });
});
