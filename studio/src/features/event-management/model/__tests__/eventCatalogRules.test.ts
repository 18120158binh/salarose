/** @jest-environment node */
// The catalog's server-side change rules (CAT-FR-08, CAT-FR-11, CAT-FR-12, CAT-FR-19), against a
// scripted Postgres: each refusal happens inside the change's transaction and writes nothing.

type Row = Record<string, unknown>;
const mockState = {
  fields: [] as Row[],
  metrics: [] as Row[],
  segments: [] as Row[],
  statements: [] as string[],
};

function respond(text: string): { rows: Row[]; rowCount: number } {
  const sql = text.replace(/\s+/g, " ").trim();
  mockState.statements.push(sql);
  const rows = (list: Row[]) => ({ rows: list, rowCount: list.length });
  if (sql.includes("to_regclass")) return rows([]);
  if (sql.startsWith("SELECT event_name, item_key FROM user_events")) return rows([{ event_name: "com.acme/add_to_cart", item_key: null }]);
  if (sql.startsWith("SELECT event_name FROM user_events")) return rows([{ event_name: "com.acme/add_to_cart" }]);
  if (sql.startsWith("SELECT 1 FROM user_events") || sql.includes("FROM user_events WHERE id")) return rows([{ id: "ue_1" }]);
  if (sql.startsWith("SELECT data_type FROM user_event_fields")) return rows(mockState.fields.slice(0, 1));
  if (sql.startsWith("SELECT field_path FROM user_event_fields") && sql.includes("data_type <> 'json'")) {
    return rows(mockState.fields.filter((field) => field.data_type !== "json"));
  }
  if (sql.startsWith("SELECT field_path FROM user_event_fields")) return rows([]);
  if (sql.includes("FROM user_metric_definitions")) return rows(mockState.metrics);
  if (sql.includes("FROM campaign_nodes")) return rows([]);
  if (sql.includes("FROM segments")) return rows(mockState.segments);
  return rows([]);
}

jest.mock("pg", () => {
  const client = { query: jest.fn(async (text: string) => respond(text)), release: jest.fn() };
  return {
    Pool: jest.fn(() => ({ query: jest.fn(async (text: string) => respond(text)), connect: jest.fn(async () => client) })),
  };
});

process.env.DATABASE_URL = "postgres://test";

import { addUserEventFields, deleteUserEvent, getUserEventSegments, updateUserEventField } from "shared/lib/db";

const SUM_PRICE = {
  id: "m1",
  display_name: "Cart value, last 30 days",
  agg_field: "product.price",
  default_properties: {},
  filter_conditions: {},
};
const SEGMENT = {
  id: "SEG-0000000000000001",
  name: "Big carts",
  conditions_json: {
    groups: [
      {
        conditions: [
          { type: "behavior", event: "com.acme/add_to_cart", measure: "SUM", attribute: "quantity", window: { value: 7, unit: "DAYS" }, op: ">=", value: 2 },
        ],
      },
    ],
  },
};

const writes = () => mockState.statements.filter((sql) => /^(UPDATE|INSERT|DELETE)/.test(sql));

beforeEach(() => {
  mockState.fields = [];
  mockState.metrics = [];
  mockState.segments = [];
  mockState.statements = [];
});

describe("a type change (CAT-FR-11)", () => {
  it("is refused while a metric reads the field, names it, offers the safe way, and writes nothing", async () => {
    mockState.fields = [{ field_path: "product.price", data_type: "number" }];
    mockState.metrics = [SUM_PRICE];

    const change = updateUserEventField("ue_1", "product.price", "product.price", "Price", "string");

    await expect(change).rejects.toThrow(/is in use, so it cannot be retyped[\s\S]*Cart value, last 30 days[\s\S]*The safe way/);
    expect(writes()).toEqual([]);
    expect(mockState.statements).toContain("ROLLBACK");
  });

  it("goes ahead when nothing reads the field", async () => {
    mockState.fields = [{ field_path: "quantity", data_type: "number" }];

    await updateUserEventField("ue_1", "quantity", "quantity", "Quantity", "string");

    expect(writes().some((sql) => sql.startsWith("UPDATE user_event_fields SET field_path"))).toBe(true);
  });

  it("is refused while a segment reads the field", async () => {
    mockState.fields = [{ field_path: "quantity", data_type: "number" }];
    mockState.segments = [SEGMENT];

    await expect(updateUserEventField("ue_1", "quantity", "quantity", "Quantity", "string")).rejects.toThrow(/Segments:\n- Big carts/);
    expect(writes()).toEqual([]);
  });
});

describe("adding inside a field that is not a group (CAT-FR-19)", () => {
  it("is refused while the field is in use", async () => {
    mockState.fields = [{ field_path: "product.price", data_type: "number" }];
    mockState.metrics = [SUM_PRICE];

    await expect(addUserEventFields("ue_1", [{ field_path: "product.price.amount", display_name: "", data_type: "number" }])).rejects.toThrow(
      /cannot be turned into a group/,
    );
    expect(writes()).toEqual([]);
  });

  it("turns a field nothing uses into a group", async () => {
    mockState.fields = [{ field_path: "quantity", data_type: "number" }];

    await addUserEventFields("ue_1", [{ field_path: "quantity.unit", display_name: "", data_type: "string" }]);

    expect(writes().some((sql) => sql.startsWith("UPDATE user_event_fields SET data_type = 'json'"))).toBe(true);
  });
});

describe("deleting an event (CAT-FR-08)", () => {
  it("is refused while the event has a metric definition, which is never deleted", async () => {
    mockState.metrics = [SUM_PRICE];

    await expect(deleteUserEvent("ue_1")).rejects.toThrow(/cannot be deleted[\s\S]*Cart value, last 30 days[\s\S]*Hide it from the builder/);
    expect(writes()).toEqual([]);
    expect(mockState.statements.some((sql) => sql.includes("pg_advisory_xact_lock"))).toBe(true);
  });

  it("is refused while a segment uses the event", async () => {
    mockState.segments = [SEGMENT];

    await expect(deleteUserEvent("ue_1")).rejects.toThrow(/Segments:\n- Big carts/);
    expect(writes()).toEqual([]);
  });

  it("deletes an event nothing uses", async () => {
    await deleteUserEvent("ue_1");

    expect(writes()).toEqual(["DELETE FROM user_events WHERE id = $1"]);
    expect(mockState.statements).toContain("COMMIT");
  });
});

describe("the segments that use an event (CAT-FR-20)", () => {
  it("gives each segment its description for the second line of Where it's used", async () => {
    mockState.segments = [{ ...SEGMENT, description: "A cart of 2 or more items" }];

    await expect(getUserEventSegments("ue_1")).resolves.toEqual([
      { id: "SEG-0000000000000001", name: "Big carts", description: "A cart of 2 or more items" },
    ]);
  });
});
