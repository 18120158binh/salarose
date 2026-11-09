/** @jest-environment node */

// Metric definitions are written by publish, and by pause, resume, and delete. These tests replace the pg Pool with an in-memory model of the tables they
// touch. Like Postgres under READ COMMITTED, each statement sees the committed rows plus the
// rows its own transaction wrote, and pg_advisory_xact_lock blocks until the holder commits or
// rolls back. Hooks let a test hold one transaction at a statement while another runs.
import type { AdminSession } from "@/shared/auth/types";

interface EventRow {
  event_name: string;
  display_name: string;
}
interface FieldRow {
  user_event_id: string;
  field_path: string;
  display_name: string;
  data_type: string;
  default_value: string | null;
}
type DefinitionRow = Record<string, unknown>;
interface CampaignRow {
  name: string;
  status: string;
  root: unknown;
  created_user: string | null;
}
interface NodeRow {
  campaign_id: string;
  node_id: string;
  node_type: string;
  parent_node_id: string | null;
  parent_branch: string | null;
  trigger_json: string | null;
  conditions_json: string | null;
  paths_json: string | null;
  action_json: string | null;
  goal_id: string | null;
}
interface MockTables {
  events: Map<string, EventRow>;
  fields: FieldRow[];
  definitions: Map<string, DefinitionRow>;
  campaigns: Map<string, CampaignRow>;
  nodes: NodeRow[];
}
interface MockResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}
interface MockClient {
  id: number;
  log: Array<(tables: MockTables) => MockResult> | null;
}
interface MockHooks {
  before: (client: MockClient, text: string) => Promise<void> | void;
  after: (client: MockClient, text: string) => void;
  onLockWait: (client: MockClient) => void;
}

let mockCommitted: MockTables;
let mockHooks: MockHooks;
let mockClientCount = 0;
let mockLockOwner: MockClient | null = null;
let mockLockWaiters: Array<() => void> = [];
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
  const copy = (t: MockTables): MockTables => ({
    events: new Map([...t.events].map(([id, row]) => [id, { ...row }])),
    fields: t.fields.map((row) => ({ ...row })),
    definitions: new Map([...t.definitions].map(([id, row]) => [id, { ...row }])),
    campaigns: new Map([...t.campaigns].map(([id, row]) => [id, { ...row }])),
    nodes: t.nodes.map((row) => ({ ...row })),
  });
  const pgError = (message: string, code: string) => Object.assign(new Error(message), { code });

  // A literal or a parameter in a VALUES list or a SET clause.
  const operand = (token: string, values: unknown[]): unknown => {
    const bare = token.trim().replace(/::\w+(\[\])?$/, "");
    const parameter = /^\$(\d+)$/.exec(bare);
    if (parameter) return values[Number(parameter[1]) - 1];
    const literal = /^'(.*)'$/.exec(bare);
    if (literal) return literal[1];
    if (/^\d+$/.test(bare)) return Number(bare);
    if (bare === "NULL") return null;
    throw new Error(`Unsupported operand ${token}`);
  };
  const definitionDefaults = (): DefinitionRow => ({
    processing_mode: "LIVE",
    event_name: "",
    default_properties: "{}",
    filter_conditions: "{}",
    agg_operator: "COUNT",
    agg_field: null,
    value_type: "PRESENCE",
    retention_ms: 2592000000,
  });
  const checkEvent = (t: MockTables, row: DefinitionRow) => {
    if (row.user_event_id != null && !t.events.has(String(row.user_event_id))) {
      throw pgError(
        'insert or update on table "user_metric_definitions" violates foreign key constraint',
        "23503",
      );
    }
  };

  // Each statement becomes an operation on a set of tables: the reader's view for a read, and
  // the committed tables too for a write, once its transaction commits.
  type Operation = { write: boolean; run: (t: MockTables) => MockResult };
  const operation = (text: string, values: unknown[]): Operation => {
    const read = (run: Operation["run"]): Operation => ({ write: false, run });
    const write = (run: Operation["run"]): Operation => ({ write: true, run });

    // The start-up check, its upgrade steps, and its checks of system_users.
    if (
      /to_regclass|ALTER TABLE system_users/.test(text)
      || text.startsWith("CREATE UNIQUE INDEX")
      || text.includes("information_schema.columns")
    ) {
      return read(() => result([]));
    }

    if (text.startsWith("SELECT") && /FROM user_events WHERE event_name = \$1/.test(text)) {
      return read((t) => result([...t.events].filter(([, row]) => row.event_name === values[0]).map(([id]) => ({ id }))));
    }
    const userEvent = /FROM user_events WHERE id = \$1/.exec(text);
    if (text.startsWith("SELECT") && userEvent) {
      return read((t) => {
        const row = t.events.get(String(values[0]));
        return result(row ? [{ id: values[0], ...row }] : []);
      });
    }
    if (text.startsWith("SELECT") && /FROM user_event_fields WHERE user_event_id = \$1/.test(text)) {
      return read((t) => result(t.fields.filter((row) => row.user_event_id === values[0]).map((row) => ({ ...row }))));
    }

    // Metric definitions.
    if (text.startsWith("SELECT") && text.includes("FROM user_metric_definitions WHERE")) {
      const where = text.split("FROM user_metric_definitions WHERE ")[1].replace(/ (LIMIT 1|FOR UPDATE)/g, "");
      return read((t) => {
        let rows: DefinitionRow[] = [...t.definitions].map(([id, row]) => ({ id, ...row }));
        if (where.startsWith("id = ANY($1")) {
          rows = rows.filter((row) => (values[0] as string[]).includes(String(row.id)));
        } else if (where.startsWith("id = $1")) {
          rows = rows.filter((row) => row.id === values[0]);
          if (where.includes("user_event_id = $2")) rows = rows.filter((row) => row.user_event_id === values[1]);
        } else {
          throw new Error(`Unsupported WHERE ${where}`);
        }
        return result(rows);
      });
    }
    const insertDefinition = /^INSERT INTO user_metric_definitions \(([^)]*)\) VALUES \(([^)]*)\)(.*)$/.exec(text);
    if (insertDefinition) {
      const columns = insertDefinition[1].split(",").map((c) => c.trim());
      const row: DefinitionRow = definitionDefaults();
      insertDefinition[2].split(",").forEach((token, i) => {
        row[columns[i]] = operand(token, values);
      });
      const conflict = insertDefinition[3].trim();
      const updated = conflict.startsWith("ON CONFLICT (id) DO UPDATE SET")
        ? [...conflict.matchAll(/(\w+) = EXCLUDED\.\w+/g)].map((m) => m[1])
        : null;
      return write((t) => {
        checkEvent(t, row);
        const { id, ...columns } = row;
        const existing = t.definitions.get(String(id));
        if (!existing) {
          t.definitions.set(String(id), columns);
          return result([], 1);
        }
        if (conflict === "ON CONFLICT (id) DO NOTHING") return result([], 0);
        if (!updated) {
          throw pgError('duplicate key value violates unique constraint "user_metric_definitions_pkey"', "23505");
        }
        for (const column of updated) existing[column] = row[column];
        return result([], 1);
      });
    }
    if (text.startsWith("UPDATE user_metric_definitions SET retention_ms = live.retention_ms")) {
      const [ids, millis] = values as [string[], number[]];
      return write((t) => {
        let count = 0;
        ids.forEach((id, i) => {
          const row = t.definitions.get(id);
          if (row && row.retention_ms !== millis[i]) {
            row.retention_ms = millis[i];
            count++;
          }
        });
        return result([], count);
      });
    }
    const updateDefinition = /^UPDATE user_metric_definitions SET (.*) WHERE (.*)$/.exec(text);
    if (updateDefinition) {
      const [, set, where] = updateDefinition;
      if (set.startsWith("processing_mode = CASE WHEN id = ANY($1::text[]) THEN 'LIVE' ELSE 'PAUSED' END")) {
        const live = values[0] as string[];
        return write((t) => {
          let count = 0;
          for (const [id, row] of t.definitions) {
            if (row.processing_mode !== "LIVE" && row.processing_mode !== "PAUSED") continue;
            const mode = live.includes(id) ? "LIVE" : "PAUSED";
            if (row.processing_mode !== mode) count++;
            row.processing_mode = mode;
          }
          return result([], count);
        });
      }
      if (where !== "id = $1") throw new Error(`Unsupported WHERE ${where}`);
      const assignments = set
        .split(",")
        .map((part) => part.trim().split(" = "))
        .filter(([, value]) => value !== "CURRENT_TIMESTAMP");
      return write((t) => {
        const existing = t.definitions.get(String(values[0]));
        if (!existing) return result([], 0);
        const next = { ...existing };
        for (const [column, value] of assignments) next[column] = operand(value, values);
        checkEvent(t, next);
        Object.assign(existing, next);
        return result([], 1);
      });
    }

    // The metric references of campaign node rows.
    if (text.includes("FROM campaign_nodes JOIN campaigns ON campaigns.id = campaign_nodes.campaign_id")) {
      const where = text.split(" WHERE ")[1] ?? "";
      return read((t) => result(
        t.nodes
          .filter((row) => !where
            || (where.includes("conditions_json IS NOT NULL") && row.conditions_json !== null)
            || (where.includes("paths_json IS NOT NULL") && row.paths_json !== null)
            || (where.includes("node_type = 'segment'") && row.node_type === "segment"))
          .map((row) => ({ ...row, status: t.campaigns.get(row.campaign_id)?.status })),
      ));
    }

    // Campaigns and their node rows.
    if (text.startsWith("SELECT") && /FROM campaigns WHERE id = \$1/.test(text)) {
      return read((t) => {
        const row = t.campaigns.get(String(values[0]));
        return result(row ? [{ id: values[0], ...row }] : []);
      });
    }
    if (text.startsWith("INSERT INTO campaigns ")) {
      const [id, name, , status, root, owner] = values as string[];
      return write((t) => {
        const existing = t.campaigns.get(id);
        if (!existing) {
          t.campaigns.set(id, { name, status, root: JSON.parse(root), created_user: owner });
          return result([], 1);
        }
        if (existing.created_user !== owner) return result([], 0);
        t.campaigns.set(id, { ...existing, name, status, root: JSON.parse(root) });
        return result([], 1);
      });
    }
    if (text.startsWith("UPDATE campaigns SET status")) {
      const [status, id] = values as string[];
      return write((t) => {
        const existing = t.campaigns.get(id);
        if (existing) existing.status = status;
        return result([], existing ? 1 : 0);
      });
    }
    if (text === "DELETE FROM campaigns WHERE id = $1") {
      return write((t) => {
        const existed = t.campaigns.delete(String(values[0]));
        t.nodes = t.nodes.filter((row) => row.campaign_id !== values[0]);
        return result([], existed ? 1 : 0);
      });
    }
    // Every metric sync reads the segments, whose metrics stay LIVE. These tests store none.
    if (text === "SELECT id, conditions_json FROM segments") {
      return read(() => result([]));
    }
    // Each publish and resume takes a graph version. These tests do not check it.
    if (text === "SELECT nextval('campaign_graph_version_seq') AS version") {
      return read(() => result([{ version: "1" }]));
    }
    if (text === "SELECT graph_version FROM campaign_nodes WHERE campaign_id = $1 LIMIT 1") {
      return read(() => result([{ graph_version: "1" }]));
    }
    if (text === "DELETE FROM campaign_nodes WHERE campaign_id = $1") {
      return write((t) => {
        t.nodes = t.nodes.filter((row) => row.campaign_id !== values[0]);
        return result([]);
      });
    }
    if (text.startsWith("INSERT INTO campaign_nodes")) {
      const [
        campaign_id, node_id, node_type, parent_node_id, parent_branch,
        trigger_json, conditions_json, paths_json, action_json, goal_id,
      ] = values as (string | null)[];
      return write((t) => {
        t.nodes.push({
          campaign_id: campaign_id!, node_id: node_id!, node_type: node_type!, parent_node_id, parent_branch,
          trigger_json, conditions_json, paths_json, action_json, goal_id,
        });
        return result([], 1);
      });
    }
    throw new Error(`Unexpected statement: ${text}`);
  };

  const releaseLock = (client: MockClient) => {
    if (mockLockOwner !== client) return;
    mockLockOwner = null;
    const waiters = mockLockWaiters;
    mockLockWaiters = [];
    waiters.forEach((wake) => wake());
  };

  const query = async (client: MockClient, rawText: string, values: unknown[] = []): Promise<MockResult> => {
    const text = rawText.replace(/\s+/g, " ").trim();
    await mockHooks.before(client, text);
    let answer: MockResult = result([]);
    if (text === "BEGIN") {
      client.log = [];
    } else if (text === "COMMIT") {
      for (const run of client.log ?? []) run(mockCommitted);
      client.log = null;
      releaseLock(client);
    } else if (text === "ROLLBACK") {
      client.log = null;
      releaseLock(client);
    } else if (text.includes("pg_advisory_xact_lock")) {
      while (mockLockOwner && mockLockOwner !== client) {
        mockHooks.onLockWait(client);
        await new Promise<void>((wake) => mockLockWaiters.push(wake));
      }
      mockLockOwner = client;
    } else {
      const op = operation(text, values);
      const view = copy(mockCommitted);
      for (const run of client.log ?? []) run(view);
      answer = op.run(view);
      if (op.write) {
        if (client.log) client.log.push(op.run);
        else op.run(mockCommitted);
      }
    }
    mockHooks.after(client, text);
    return answer;
  };

  const autocommit: MockClient = { id: 0, log: null };
  return {
    Pool: jest.fn().mockImplementation(() => ({
      query: (text: string, values?: unknown[]) => query(autocommit, text, values),
      connect: async () => {
        const client: MockClient = { id: ++mockClientCount, log: null };
        return { query: (text: string, values?: unknown[]) => query(client, text, values), release: () => undefined };
      },
    })),
  };
});

import { publishCampaignAction, toggleCampaignStatusAction, deleteCampaignAction } from "@/app/actions";
import { behaviorMetricId } from "@/lib/db";

const lan: AdminSession = { userId: "user_lan", email: "lan@example.com", role: "editor" };
const minh: AdminSession = { userId: "user_minh", email: "minh@example.com", role: "editor" };
const DAY = 86_400_000;

type Window = { value: number; unit: string };
// What a behavior condition counts, and its window, as the marketer states them in the editor.
interface Behavior {
  event?: string;
  measure: string;
  attribute?: string;
  filters?: unknown;
  window?: Window | null;
  op?: string;
  value?: number;
  metric_id?: string;
}
const behavior = ({ event = "add_to_cart", window = { value: 7, unit: "DAYS" }, op = ">=", value = 1, ...rest }: Behavior) => ({
  type: "behavior",
  event,
  ...rest,
  ...(window ? { window } : {}),
  op,
  value,
});
// The metric id publish derives for a condition, by the rule segments use too.
const idOf = (b: Behavior) => behaviorMetricId(behavior(b) as Parameters<typeof behaviorMetricId>[0]);
const groups = (...conditions: unknown[]) => ({ groups: [{ conditions }] });

const end = { type: "end", goalId: "goal_default" };
function journey(next: unknown) {
  return {
    type: "setup",
    id: "setup-1",
    label: "Trigger",
    description: "Define journey settings",
    triggerType: "user",
    triggerEventName: "add_to_cart",
    next,
  };
}
const checkJourney = (...conditions: Behavior[]) =>
  journey({
    type: "check",
    id: "check-1",
    label: "Check",
    eventName: "add_to_cart",
    conditions: groups(...conditions.map(behavior)),
    next: { type: "YesPath", yes: end },
  });
// A condition split, which only a behavior condition can fire.
const segmentJourney = (condition: Behavior) =>
  journey({
    type: "segment",
    id: "segment-1",
    label: "Buyers",
    conditions: groups(behavior(condition)),
    next: { type: "YesPath", yes: end },
  });
const draft = (id: string, root: unknown) => ({ id, name: id, description: "", root });

const nodeRow = (campaignId: string, row: Partial<NodeRow> & Pick<NodeRow, "node_id" | "node_type">): NodeRow => ({
  campaign_id: campaignId,
  parent_node_id: null,
  parent_branch: null,
  trigger_json: null,
  conditions_json: null,
  paths_json: null,
  action_json: null,
  goal_id: null,
  ...row,
});
const definition = (id: string) => mockCommitted.definitions.get(id);
// The behavior conditions that publish wrote into a campaign's check row.
const publishedConditions = (campaignId: string) => {
  const row = mockCommitted.nodes.find((node) => node.campaign_id === campaignId && node.node_id === "check-1");
  return JSON.parse(String(row?.conditions_json)).groups[0].conditions as Record<string, unknown>[];
};

const cartValue: Behavior = { measure: "SUM", attribute: "product.price", op: ">", value: 1000000 };
const purchases: Behavior = { event: "purchase", measure: "COUNT" };

beforeAll(() => {
  process.env.DATABASE_URL = "postgres://test";
});

// The catalog has add_to_cart and purchase. Minh's active campaign c_minh sums the cart value
// over 7 days, and its definition exists. Lan's active campaign c_lan uses no metric.
beforeEach(() => {
  mockSession = lan;
  mockClientCount = 0;
  mockLockOwner = null;
  mockLockWaiters = [];
  mockHooks = { before: () => undefined, after: () => undefined, onLockWait: () => undefined };
  mockCommitted = {
    events: new Map([
      ["ue_cart", { event_name: "add_to_cart", display_name: "Add to cart" }],
      ["ue_purchase", { event_name: "purchase", display_name: "Purchase" }],
    ]),
    fields: [
      { user_event_id: "ue_cart", field_path: "product.price", display_name: "Price", data_type: "number", default_value: null },
      { user_event_id: "ue_cart", field_path: "product.id", display_name: "Product ID", data_type: "string", default_value: null },
      { user_event_id: "ue_cart", field_path: "product.category", display_name: "Category", data_type: "string", default_value: null },
      { user_event_id: "ue_cart", field_path: "gift", display_name: "Gift", data_type: "boolean", default_value: null },
    ],
    definitions: new Map([
      [idOf(cartValue), {
        name: "SUM add_to_cart", display_name: "Add to cart — Sum of Price", user_event_id: "ue_cart",
        event_name: "add_to_cart", agg_operator: "SUM", agg_field: "product.price", processing_mode: "LIVE",
        value_type: "NUMBER", default_properties: "{}", filter_conditions: "{}", retention_ms: 7 * DAY,
      }],
    ]),
    campaigns: new Map([
      ["c_lan", { name: "Cart recovery", status: "active", root: journey(end), created_user: lan.userId }],
      ["c_minh", { name: "Big carts", status: "active", created_user: minh.userId, root: checkJourney(cartValue) }],
    ]),
    nodes: [
      nodeRow("c_lan", { node_id: "setup-1", node_type: "setup", trigger_json: JSON.stringify({ kind: "event", event: "add_to_cart" }) }),
      nodeRow("c_lan", { node_id: "setup-1-next-end", node_type: "end", parent_node_id: "setup-1", parent_branch: "next" }),
      nodeRow("c_minh", { node_id: "setup-1", node_type: "setup", trigger_json: JSON.stringify({ kind: "event", event: "add_to_cart" }) }),
      nodeRow("c_minh", {
        node_id: "check-1",
        node_type: "check",
        parent_node_id: "setup-1",
        parent_branch: "next",
        conditions_json: JSON.stringify(groups({ ...behavior(cartValue), metric_id: idOf(cartValue) })),
      }),
    ],
  };
});

describe("publish derives each behavior condition's metric", () => {
  it("creates a live definition for \"add_to_cart COUNT >= 3 in 7 days\" and writes its id into the node row", async () => {
    const atLeastThree: Behavior = { measure: "COUNT", value: 3 };

    await expect(publishCampaignAction(draft("c_new", checkJourney(atLeastThree)))).resolves.toEqual({ success: true });

    const metricId = idOf(atLeastThree);
    expect(metricId).toMatch(/^m_[0-9a-f]{16}$/);
    expect(publishedConditions("c_new")).toEqual([expect.objectContaining({ metric_id: metricId, window: { value: 7, unit: "DAYS" } })]);
    expect(definition(metricId)).toEqual(expect.objectContaining({
      name: "COUNT add_to_cart",
      event_name: "add_to_cart",
      agg_operator: "COUNT",
      agg_field: null,
      value_type: "PRESENCE",
      processing_mode: "LIVE",
      created_by: lan.userId,
    }));
  });

  // CMP-FR-11: the window, operator, and threshold are not part of the id.
  it("names one definition for conditions that count the same thing, and another for a different measure", async () => {
    await expect(publishCampaignAction(draft("c_a", checkJourney({ measure: "COUNT", value: 3 })))).resolves.toEqual({ success: true });
    await expect(publishCampaignAction(draft("c_b", checkJourney({
      measure: "COUNT", op: "=", value: 0, window: { value: 30, unit: "DAYS" },
    })))).resolves.toEqual({ success: true });
    await expect(publishCampaignAction(draft("c_c", checkJourney(cartValue)))).resolves.toEqual({ success: true });

    const [a, b, c] = ["c_a", "c_b", "c_c"].map((id) => publishedConditions(id)[0].metric_id);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(c).toBe(idOf(cartValue));
  });

  // CMP-FR-11 and CMP-FR-13: the filters are part of the id, and the definition counts only the
  // events they pass.
  it("names different definitions for different filters, and writes each one's filters", async () => {
    const phones: Behavior = {
      measure: "COUNT",
      filters: groups({ type: "event_property", field: "product.category", op: "=", value: "phones" }),
    };
    const tablets: Behavior = {
      measure: "COUNT",
      filters: groups({ type: "event_property", field: "product.category", op: "=", value: "tablets" }),
    };

    await expect(publishCampaignAction(draft("c_new", checkJourney(phones, tablets)))).resolves.toEqual({ success: true });

    const [phoneId, tabletId] = publishedConditions("c_new").map((condition) => condition.metric_id);
    expect(phoneId).not.toBe(tabletId);
    expect(JSON.parse(String(definition(String(phoneId))?.filter_conditions))).toEqual({
      type: "and",
      expressions: [{ type: "or", expressions: [{ type: "comparison", left: "product.category", op: "=", right: "phones" }] }],
    });
  });

  // The same inputs as the pinned segment id in segmentsDb.test.ts, so a campaign and a segment
  // that count the same thing name one definition.
  it("derives the id that a segment with the same condition names", async () => {
    const pinned: Behavior = {
      measure: "SUM",
      attribute: "product.price",
      filters: groups(
        { type: "event_property", field: "product.category", op: "IN", value: ["phones", "tablets"] },
        { type: "event_property", field: "product.price", op: ">", value: 500000 },
      ),
      window: { value: 30, unit: "DAYS" },
      op: ">=",
      value: 1000000,
    };

    await expect(publishCampaignAction(draft("c_new", checkJourney(pinned)))).resolves.toEqual({ success: true });

    expect(publishedConditions("c_new")[0].metric_id).toBe("m_514afd5c430cce3b");
    expect(definition("m_514afd5c430cce3b")?.processing_mode).toBe("LIVE");
  });

  it("replaces a metric id the journey names with the derived one, and creates no definition for it", async () => {
    await expect(publishCampaignAction(draft("c_new", checkJourney({ ...cartValue, metric_id: "m_cart_value" })))).resolves.toEqual({
      success: true,
    });

    expect(publishedConditions("c_new")[0].metric_id).toBe(idOf(cartValue));
    expect(definition("m_cart_value")).toBeUndefined();
  });

  // CMP-FR-14: publish changes only processing_mode and the retention period of a definition.
  it("leaves the name, filters, and default properties of a definition that exists", async () => {
    const stored = definition(idOf(cartValue))!;
    Object.assign(stored, {
      name: "cart_value",
      display_name: "Cart value",
      default_properties: JSON.stringify({ type: "comparison", left: "platform", op: "=", right: "mob" }),
    });
    const before = { ...stored };

    await expect(publishCampaignAction(draft("c_new", checkJourney(cartValue)))).resolves.toEqual({ success: true });

    expect(definition(idOf(cartValue))).toEqual(before);
  });

  it.each(["LATEST", "PRICE_DROP", "DIFF"])("creates a %s metric with that function", async (fn) => {
    const condition: Behavior = { measure: fn, attribute: "product.price" };

    await expect(publishCampaignAction(draft("c_new", checkJourney(condition)))).resolves.toEqual({ success: true });

    expect(definition(idOf(condition))).toEqual(expect.objectContaining({
      agg_operator: fn,
      agg_field: "product.price",
      value_type: "NUMBER",
      processing_mode: "LIVE",
    }));
  });
});

// CMP-FR-02: a refused publish writes nothing and says why.
describe("publish refuses a behavior condition that breaks step 2", () => {
  it.each([
    ["an event that is not in the catalog", { event: "add_to_wishlist", measure: "COUNT" }, "Node check-1: Event add_to_wishlist is not in the catalog."],
    ["SUM with no attribute", { measure: "SUM" }, "Node check-1: SUM needs an attribute."],
    ["COUNT with an attribute", { measure: "COUNT", attribute: "product.price" }, "Node check-1: COUNT reads no attribute."],
    ["a measure that is not a metric function", { measure: "P99" }, "Node check-1: the measure must be one of"],
  ])("refuses %s", async (_, condition, message) => {
    const result = await publishCampaignAction(draft("c_new", checkJourney(condition)));

    expect(result).toEqual({ error: expect.stringContaining(message) });
    expect(mockCommitted.campaigns.has("c_new")).toBe(false);
    expect(mockCommitted.definitions.size).toBe(1);
  });

  it("refuses a condition with no window", async () => {
    const result = await publishCampaignAction(draft("c_new", checkJourney({ measure: "COUNT", window: null })));

    expect(result).toEqual({ error: expect.stringContaining("window") });
    expect(mockCommitted.campaigns.has("c_new")).toBe(false);
  });
});

describe("metric processing modes", () => {
  it("turns on a metric that only a condition split of an active campaign uses, and off when it pauses", async () => {
    await expect(publishCampaignAction(draft("c_seg", segmentJourney(purchases)))).resolves.toEqual({ success: true });
    expect(definition(idOf(purchases))?.processing_mode).toBe("LIVE");

    await expect(toggleCampaignStatusAction("c_seg", "paused")).resolves.toEqual({ success: true });
    expect(definition(idOf(purchases))?.processing_mode).toBe("PAUSED");
  });

  it("counts only a campaign whose stored status is active as active", async () => {
    mockCommitted.campaigns.set("c_minh", { ...mockCommitted.campaigns.get("c_minh")!, status: "LIVE" });

    await expect(publishCampaignAction(draft("c_seg", segmentJourney(purchases)))).resolves.toEqual({ success: true });

    expect(definition(idOf(purchases))?.processing_mode).toBe("LIVE");
    expect(definition(idOf(cartValue))?.processing_mode).toBe("PAUSED");
  });

  it("skips a stored metric condition that does not parse, and still publishes", async () => {
    mockCommitted.campaigns.set("c_legacy", { name: "Legacy", status: "active", root: journey(end), created_user: null });
    mockCommitted.nodes.push(nodeRow("c_legacy", { node_id: "check-1", node_type: "check", conditions_json: "{not json" }));
    jest.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(publishCampaignAction(draft("c_new", checkJourney(purchases)))).resolves.toEqual({ success: true });
    expect(definition(idOf(purchases))?.processing_mode).toBe("LIVE");
    expect(definition(idOf(cartValue))?.processing_mode).toBe("LIVE");
  });

  it("keeps a metric live when a pause recomputes the modes while a publish that uses it commits", async () => {
    // A publishes c_new, which uses the purchase count. B pauses c_lan, which uses no metric.
    // A holds at COMMIT until B has read the references or is waiting for A. B holds before it
    // writes the modes until A has committed.
    let aReachedCommit!: () => void;
    const aAtCommit = new Promise<void>((resolve) => { aReachedCommit = resolve; });
    let letACommit!: () => void;
    const aMayCommit = new Promise<void>((resolve) => { letACommit = resolve; });
    let aCommitted!: () => void;
    const aDone = new Promise<void>((resolve) => { aCommitted = resolve; });
    mockHooks = {
      before: async (client, text) => {
        if (client.id === 1 && text === "COMMIT") {
          aReachedCommit();
          await aMayCommit;
        }
        if (client.id === 2 && text.startsWith("UPDATE user_metric_definitions")) await aDone;
      },
      after: (client, text) => {
        if (client.id === 1 && text === "COMMIT") aCommitted();
        if (client.id === 2 && text.includes("FROM campaign_nodes JOIN campaigns")) letACommit();
      },
      onLockWait: (client) => {
        if (client.id === 2) letACommit();
      },
    };

    const a = publishCampaignAction(draft("c_new", checkJourney(purchases)));
    await aAtCommit;
    const b = toggleCampaignStatusAction("c_lan", "paused");

    await expect(Promise.all([a, b])).resolves.toEqual([{ success: true }, { success: true }]);
    expect(mockCommitted.campaigns.get("c_new")?.status).toBe("active");
    expect(definition(idOf(purchases))?.processing_mode).toBe("LIVE");
  });
});

// CMP-FR-16: the retention period is the longest window among the conditions that keep the
// definition live.
describe("metric retention periods", () => {
  const monthOfCartValue: Behavior = { ...cartValue, window: { value: 30, unit: "DAYS" } };
  const retention = () => definition(idOf(cartValue))?.retention_ms;

  it("takes the longest window on publish, and the next longest when that campaign pauses", async () => {
    await expect(publishCampaignAction(draft("c_month", checkJourney(monthOfCartValue)))).resolves.toEqual({ success: true });
    expect(retention()).toBe(30 * DAY);

    await expect(toggleCampaignStatusAction("c_month", "paused")).resolves.toEqual({ success: true });
    expect(retention()).toBe(7 * DAY);

    await expect(toggleCampaignStatusAction("c_month", "active")).resolves.toEqual({ success: true });
    expect(retention()).toBe(30 * DAY);

    await expect(deleteCampaignAction("c_month")).resolves.toEqual({ success: true });
    expect(retention()).toBe(7 * DAY);
  });

  it("keeps the retention period of a definition that no active campaign names", async () => {
    await expect(publishCampaignAction(draft("c_month", checkJourney(monthOfCartValue)))).resolves.toEqual({ success: true });
    mockSession = minh;
    await expect(toggleCampaignStatusAction("c_minh", "paused")).resolves.toEqual({ success: true });
    mockSession = lan;
    await expect(toggleCampaignStatusAction("c_month", "paused")).resolves.toEqual({ success: true });

    expect(definition(idOf(cartValue))).toEqual(expect.objectContaining({ processing_mode: "PAUSED", retention_ms: 30 * DAY }));
  });

  it("counts a week as 7 days and a month as 30", async () => {
    await expect(publishCampaignAction(draft("c_new", checkJourney(
      { ...cartValue, window: { value: 5, unit: "WEEKS" } },
      { ...cartValue, window: { value: 1, unit: "MONTHS" } },
    )))).resolves.toEqual({ success: true });

    expect(retention()).toBe(35 * DAY);
  });
});

describe("metric value types", () => {
  it.each([
    ["SUM", "product.price", "NUMBER"],
    ["DISTINCT_COUNT", "product.id", "STRING"],
    ["DISTINCT_COUNT", "gift", "BOOLEAN"],
    ["SUM", "coupon", "STRING"],
  ])("publish stores %s of %s with the attribute's catalog type", async (measure, attribute, valueType) => {
    await expect(publishCampaignAction(draft("c_new", checkJourney({ measure, attribute })))).resolves.toEqual({ success: true });

    expect(definition(idOf({ measure, attribute }))).toEqual(expect.objectContaining({ agg_field: attribute, value_type: valueType }));
  });
});

const condition = (text: unknown) => JSON.parse(String(text));
const equals = (left: string, right: string) => ({ type: "comparison", left, op: "=", right });

describe("metric conditions the decision job can load", () => {
  it("publish writes the catalog's default values as a condition on each attribute path", async () => {
    mockCommitted.fields.push(
      { user_event_id: "ue_purchase", field_path: "screen_location", display_name: "Screen", data_type: "string", default_value: "checkout" },
      { user_event_id: "ue_purchase", field_path: "order.channel", display_name: "Channel", data_type: "string", default_value: "web" },
      { user_event_id: "ue_purchase", field_path: "order.total", display_name: "Total", data_type: "number", default_value: null },
    );
    const spent: Behavior = { event: "purchase", measure: "SUM", attribute: "order.total" };

    await expect(publishCampaignAction(draft("c_new", checkJourney(spent)))).resolves.toEqual({ success: true });

    const written = definition(idOf(spent));
    expect(condition(written?.default_properties)).toEqual({
      type: "and",
      expressions: [equals("screen_location", "checkout"), equals("order.channel", "web")],
    });
    expect(condition(written?.filter_conditions)).toEqual({});
  });

  it("publish writes {} for an event without default values", async () => {
    await expect(publishCampaignAction(draft("c_new", checkJourney(purchases)))).resolves.toEqual({ success: true });

    expect(condition(definition(idOf(purchases))?.default_properties)).toEqual({});
  });
});
