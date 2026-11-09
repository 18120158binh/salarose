/** @jest-environment node */

// The catalog functions in shared/lib/db.ts talk to Postgres through a pg Pool. These tests
// replace the pool with a fake that records each statement and answers it from mockRespond.
interface MockStatement {
  text: string;
  values: unknown[];
}
interface MockResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

const mockStatements: MockStatement[] = [];
let mockRespond: (statement: MockStatement) => MockResult = () => ({ rows: [], rowCount: 0 });

jest.mock("../../shared/node_modules/pg", () => {
  const query = async (text: string, values: unknown[] = []) => {
    const statement = { text: text.replace(/\s+/g, " ").trim(), values };
    mockStatements.push(statement);
    return mockRespond(statement);
  };
  return {
    Pool: jest.fn().mockImplementation(() => ({
      query,
      connect: async () => ({ query, release: () => undefined }),
    })),
  };
});

import {
  addUserEventFields,
  createUserEvent,
  createUserEventField,
  createUserEventWithFields,
  deleteUserEvent,
  deleteUserEventField,
  ensureDbInitialized,
  findUserEventByName,
  getUserEventFields,
  getUserEvents,
  getUserEventSummariesPage,
  getUserEventUsage,
  setUserEventFieldRequired,
  setUserEventSchemaEnforcement,
  setUserEventStatus,
  updateUserEvent,
  updateUserEventDetails,
  updateUserEventField,
} from "@/lib/db";
import { UserFacingError } from "shared/lib/userFacingError";

const rows = (...items: Record<string, unknown>[]): MockResult => ({ rows: items, rowCount: items.length });
const person = { kind: "person" } as const;
const none: MockResult = { rows: [], rowCount: 0 };

// Statements other than the transaction markers, in the order they ran.
function dataStatements(): MockStatement[] {
  return mockStatements.filter((s) => !["BEGIN", "COMMIT", "ROLLBACK"].includes(s.text));
}

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://test";
  await ensureDbInitialized();
});

beforeEach(() => {
  mockStatements.length = 0;
  mockRespond = () => none;
});

describe("deleteUserEvent", () => {
  // ue_1 is add_to_cart. Nothing uses it unless a test answers the use queries.
  const unused = (s: MockStatement): MockResult =>
    s.text.startsWith("SELECT event_name FROM user_events") && s.values[0] === "ue_1" ? rows({ event_name: "add_to_cart" }) : none;
  const writes = () => dataStatements().filter((s) => /^(INSERT|UPDATE|DELETE)\b/.test(s.text));

  it("deletes only the event row with that id, after the use check, in one transaction (CAT-FR-08)", async () => {
    mockRespond = unused;

    await deleteUserEvent("ue_1");

    expect(writes()).toEqual([{ text: "DELETE FROM user_events WHERE id = $1", values: ["ue_1"] }]);
    expect(mockStatements[0].text).toBe("BEGIN");
    expect(mockStatements.at(-1)?.text).toBe("COMMIT");
  });

  it("refuses while a metric definition uses the event, names it, and deletes nothing (CAT-FR-08)", async () => {
    mockRespond = (s) =>
      s.text.includes("FROM user_metric_definitions WHERE user_event_id")
        ? rows({ id: "m_add_to_cart_count", display_name: "Add to cart count" })
        : unused(s);

    await expect(deleteUserEvent("ue_1")).rejects.toThrow(
      [
        "This event is in use, so it cannot be deleted. Nothing changed.",
        "",
        "Metric definitions, which are kept for history and never deleted:",
        "- Add to cart count (m_add_to_cart_count)",
        "",
        "Hide it from the builder to retire it.",
      ].join("\n"),
    );
    expect(writes()).toEqual([]);
    expect(mockStatements.at(-1)?.text).toBe("ROLLBACK");
  });

  it("fails when no event has that id, such as a system name", async () => {
    await expect(deleteUserEvent("add_to_cart")).rejects.toThrow("Event add_to_cart not found.");
  });
});

describe("attribute writes on an unknown event id", () => {
  // Only ue_1 exists. A lookup by system name must not find it.
  beforeEach(() => {
    mockRespond = (s) =>
      s.text.startsWith("SELECT") && s.text.includes("FROM user_events") && s.values[0] === "ue_1"
        ? rows({ id: "ue_1" })
        : none;
  });

  it.each([
    ["createUserEventField", () => createUserEventField("add_to_cart", "price", "Price", "number")],
    ["updateUserEventField", () => updateUserEventField("add_to_cart", "price", "amount", "Amount", "number")],
    ["deleteUserEventField", () => deleteUserEventField("price", "add_to_cart")],
  ])("%s fails and writes no attribute", async (_name, write) => {
    await expect(write()).rejects.toThrow("Event add_to_cart not found.");
    expect(dataStatements().filter((s) => /^(INSERT|UPDATE|DELETE)\b/.test(s.text) && s.text.includes("user_event_fields"))).toEqual([]);
  });

  it("createUserEventField writes the attribute under a known id", async () => {
    await createUserEventField("ue_1", "price", "Price", "number", "10");

    expect(dataStatements().filter((s) => s.text.startsWith("INSERT INTO user_event_fields"))).toEqual([
      expect.objectContaining({ values: ["ue_1", "price", "Price", "number", "10"] }),
    ]);
  });
});

describe("creating an event with a system name that exists", () => {
  beforeEach(() => {
    mockRespond = (s) => {
      if (s.text.startsWith("INSERT INTO user_events ")) {
        throw Object.assign(
          new Error('duplicate key value violates unique constraint "user_events_event_name_key"'),
          { code: "23505", constraint: "user_events_event_name_key" },
        );
      }
      return none;
    };
  });

  it("createUserEventWithFields rejects it with a plain message and rolls back", async () => {
    await expect(createUserEventWithFields("add_to_cart", "Add to cart", undefined, person, [])).rejects.toThrow(
      'An event with the system name "add_to_cart" already exists.',
    );
    expect(mockStatements.map((s) => s.text)).toContain("ROLLBACK");
  });

  it("createUserEvent rejects it with a plain message", async () => {
    await expect(createUserEvent("add_to_cart", "Add to cart")).rejects.toThrow(
      'An event with the system name "add_to_cart" already exists.',
    );
  });
});

describe("getUserEventUsage", () => {
  // ue_1 is the event add_to_cart. Each node row carries the three rule columns, as campaign_nodes does.
  function respondWithNodes(...nodes: Record<string, unknown>[]) {
    mockRespond = (s) => {
      if (s.text.includes("FROM user_events ")) {
        return s.values[0] === "ue_1" ? rows({ id: "ue_1", event_name: "add_to_cart" }) : none;
      }
      if (s.text.includes("FROM user_metric_definitions")) {
        return rows(
          { id: "m_add_to_cart_count", display_name: "Add to cart count", agg_operator: "COUNT", agg_field: null },
          { id: "m_add_to_cart_sum_price", display_name: "Add to cart total price", agg_operator: "SUM", agg_field: "product.price" },
        );
      }
      if (s.text.includes("FROM campaign_nodes")) {
        return rows(
          ...nodes.map((node) => ({ trigger_json: null, conditions_json: null, paths_json: null, ...node })),
        );
      }
      return none;
    };
  }
  const campaign = (id: string, name: string, status = "active") => ({
    campaign_id: id,
    campaign_name: name,
    campaign_status: status,
  });
  const trigger = (event: string) => JSON.stringify({ kind: "event", event });
  const behaviorOn = (event: string, metricId: string) => JSON.stringify({
    groups: [{ conditions: [{ type: "behavior", event, measure: "COUNT", op: ">=", value: 1, metric_id: metricId }] }],
  });

  it("lists the event's metric definitions and the campaigns whose behavior conditions use it", async () => {
    respondWithNodes(
      { ...campaign("c_recovery", "Cart recovery"), node_id: "check-1", conditions_json: behaviorOn("add_to_cart", "m_add_to_cart_count") },
      { ...campaign("c_recovery", "Cart recovery"), node_id: "check-2", conditions_json: behaviorOn("add_to_cart", "m_add_to_cart_sum_price") },
      // A behavior condition on a branch of a multi-branch check.
      {
        ...campaign("c_branch", "Branch upsell", "paused"),
        node_id: "check-1",
        paths_json: JSON.stringify({
          path_type: "MultiBranchPath",
          branches: [{ key: "vip", conditions: JSON.parse(behaviorOn("add_to_cart", "m_add_to_cart_count")) }, { key: "regular" }],
        }),
      },
      { ...campaign("c_views", "Browse reminder"), node_id: "check-1", conditions_json: behaviorOn("view_item", "m_view_count") },
    );

    await expect(getUserEventUsage("ue_1")).resolves.toEqual({
      metrics: [
        { id: "m_add_to_cart_count", displayName: "Add to cart count", measure: "Times performed" },
        { id: "m_add_to_cart_sum_price", displayName: "Add to cart total price", measure: "Sum of product.price" },
      ],
      metricCampaigns: [
        { id: "c_recovery", name: "Cart recovery", status: "active" },
        { id: "c_branch", name: "Branch upsell", status: "paused" },
      ],
      conditionCampaigns: [],
    });
  });

  it("lists the campaigns whose trigger is the event, and not a longer name", async () => {
    respondWithNodes(
      { ...campaign("c_trigger", "Cart trigger"), node_id: "setup-1", trigger_json: trigger("add_to_cart") },
      {
        ...campaign("c_watch", "Cart watch", "paused"),
        node_id: "watch-1",
        trigger_json: trigger("add_to_cart"),
        paths_json: JSON.stringify({ path_type: "SuccessOrTimeoutPath", limit: { value: 15, unit: "MINUTES" } }),
      },
      // Same prefix, different event.
      { ...campaign("c_v2", "Cart v2"), node_id: "setup-1", trigger_json: trigger("add_to_cart_v2") },
      // The name as an attribute value is not the event.
      {
        ...campaign("c_attr", "Attribute value"),
        node_id: "check-1",
        trigger_json: JSON.stringify({
          kind: "event",
          event: "view_item",
          filters: { groups: [{ conditions: [{ type: "event_property", field: "page.url", op: "=", value: "add_to_cart" }] }] },
        }),
      },
    );

    const usage = await getUserEventUsage("ue_1");

    expect(usage.conditionCampaigns).toEqual([
      { id: "c_trigger", name: "Cart trigger", status: "active" },
      { id: "c_watch", name: "Cart watch", status: "paused" },
    ]);
    expect(usage.metricCampaigns).toEqual([]);
  });

  it("skips a node whose JSON does not parse, logs it, and still lists the rest", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    respondWithNodes(
      { ...campaign("c_broken", "Broken metrics"), node_id: "check-9", conditions_json: "{not json" },
      { ...campaign("c_broken_trigger", "Broken trigger"), node_id: "setup-9", trigger_json: "{not json" },
      {
        ...campaign("c_recovery", "Cart recovery"),
        node_id: "check-1",
        trigger_json: trigger("add_to_cart"),
        conditions_json: behaviorOn("add_to_cart", "m_add_to_cart_count"),
      },
    );

    try {
      const usage = await getUserEventUsage("ue_1");

      expect(usage.metricCampaigns).toEqual([{ id: "c_recovery", name: "Cart recovery", status: "active" }]);
      expect(usage.conditionCampaigns).toEqual([{ id: "c_recovery", name: "Cart recovery", status: "active" }]);
      const logged = warn.mock.calls.map((call) => call.join(" "));
      expect(logged).toEqual([
        expect.stringMatching(/c_broken\b.*check-9/),
        expect.stringMatching(/c_broken_trigger.*setup-9/),
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("fails when no event has that id", async () => {
    await expect(getUserEventUsage("ue_missing")).rejects.toThrow("Event ue_missing not found.");
  });
});

describe("renaming or deleting an attribute", () => {
  // ue_1 is add_to_cart and ue_2 is view_item. Both have product.price.
  const eventNames: Record<string, string> = { ue_1: "add_to_cart", ue_2: "view_item" };
  // A metric definition's filter_conditions still use the comparison tree.
  const comparison = (left: string, right: string, op = "=") => ({ type: "comparison", left, op, right });
  const filter = (field: string, value: unknown, op = ">") => ({ type: "event_property", field, op, value });
  const triggerOn = (event: string, ...filters: Record<string, unknown>[]) =>
    JSON.stringify({ kind: "event", event, filters: { groups: [{ conditions: filters }] } });
  const behaviorOn = (eventName: string, attribute: string) => JSON.stringify({
    groups: [{ conditions: [{ type: "behavior", event: eventName, measure: "SUM", attribute, op: ">", value: 1, metric_id: "m_metric" }] }],
  });
  const node = (campaignId: string, campaignName: string, nodeId: string, columns: Record<string, unknown>) => ({
    campaign_id: campaignId,
    campaign_name: campaignName,
    campaign_status: "active",
    node_id: nodeId,
    trigger_json: null,
    conditions_json: null,
    paths_json: null,
    ...columns,
  });
  const metric = (id: string, displayName: string, columns: Record<string, unknown> = {}) => ({
    id,
    display_name: displayName,
    agg_field: null,
    default_properties: {},
    filter_conditions: {},
    ...columns,
  });

  // The metric definitions of each event id, and every campaign node row.
  function respondWith(metricsByEvent: Record<string, Record<string, unknown>[]>, nodes: Record<string, unknown>[]) {
    mockRespond = (s) => {
      if (s.text.includes("FROM user_events ")) {
        const name = eventNames[String(s.values[0])];
        return name ? rows({ id: s.values[0], event_name: name }) : none;
      }
      if (s.text.includes("FROM user_metric_definitions")) return rows(...(metricsByEvent[String(s.values[0])] ?? []));
      if (s.text.includes("FROM campaign_nodes")) return rows(...nodes);
      return none;
    };
  }
  const fieldWrites = () => dataStatements().filter((s) => s.text.startsWith("UPDATE user_event_fields"));

  it("refuses to rename an attribute in use and names each metric definition, campaign, and node", async () => {
    respondWith(
      {
        ue_1: [
          metric("m_add_to_cart_sum_product_price", "Add to cart total price", { agg_field: "product.price" }),
          metric("m_big_carts", "Big carts", {
            filter_conditions: { type: "and", expressions: [comparison("product.price", "100", ">")] },
          }),
          metric("m_add_to_cart_count", "Add to cart count"),
        ],
      },
      [
        node("c_recovery", "Cart recovery", "setup-1", {
          trigger_json: triggerOn("add_to_cart", filter("product.price", 500000)),
        }),
        node("c_recovery", "Cart recovery", "check-2", { conditions_json: behaviorOn("add_to_cart", "product.price") }),
        node("c_upsell", "Upsell", "check-1", {
          trigger_json: JSON.stringify({ kind: "event", event: "add_to_cart" }),
          paths_json: JSON.stringify({
            path_type: "MultiBranchPath",
            branches: [{ key: "vip", filters: { groups: [{ conditions: [filter("product.price", 1000)] }] } }, { key: "else" }],
          }),
        }),
        node("c_quantity", "Quantity", "setup-1", {
          trigger_json: triggerOn("add_to_cart", filter("quantity", 2)),
        }),
      ],
    );

    await expect(updateUserEventField("ue_1", "product.price", "item.price", "Price", "number")).rejects.toThrow(
      [
        'The attribute "product.price" is in use, so it cannot be renamed. Nothing changed.',
        "",
        "Metric definitions:",
        "- Add to cart total price (m_add_to_cart_sum_product_price)",
        "- Big carts (m_big_carts)",
        "",
        "Campaigns:",
        "- Cart recovery (active), nodes setup-1, check-2",
        "- Upsell (active), node check-1",
        "",
        "The safe way:",
        "1. Add the new field next to the old one.",
        "2. Update the journeys, metrics, and segments that use the old one. A live journey can't be edited in place, so duplicate it, point it at the new field, and swap them.",
        "3. Remove the old field once nothing uses it.",
      ].join("\n"),
    );
    expect(fieldWrites()).toEqual([]);
    expect(mockStatements.map((s) => s.text)).toContain("ROLLBACK");
  });

  it("checks the uses under the lock that publishes and metric definition writes take", async () => {
    respondWith({}, []);

    await updateUserEventField("ue_1", "product.price", "item.price", "Price", "number");

    const texts = dataStatements().map((s) => s.text);
    const lock = texts.indexOf("SELECT pg_advisory_xact_lock(hashtext('user_metric_definitions'))");
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(texts.findIndex((text) => text.includes("FROM campaign_nodes")));
    expect(lock).toBeLessThan(texts.findIndex((text) => text.includes("FROM user_metric_definitions")));
  });

  it("refuses to rename a parent whose child is in use", async () => {
    respondWith({}, [
      node("c_recovery", "Cart recovery", "setup-1", {
        trigger_json: triggerOn("add_to_cart", filter("product.price", 500000)),
      }),
    ]);

    await expect(updateUserEventField("ue_1", "product", "item", "Product", "json")).rejects.toThrow(
      /^The attribute "product" is in use[\s\S]*- Cart recovery \(active\), node setup-1\n\nThe safe way:\n1\. [\s\S]*3\. Remove the old field once nothing uses it\.$/,
    );
    expect(fieldWrites()).toEqual([]);
  });

  it("renames an attribute that only other events and longer paths use", async () => {
    respondWith(
      {
        ue_1: [metric("m_add_to_cart_sum_product_price_old", "Old price", { agg_field: "product.price_old" })],
        ue_2: [metric("m_view_item_sum_product_price", "Viewed price", { agg_field: "product.price" })],
      },
      [
        node("c_views", "Browse", "setup-1", {
          trigger_json: triggerOn("view_item", filter("product.price", 10)),
          conditions_json: behaviorOn("view_item", "product.price"),
        }),
        node("c_old", "Old price", "setup-1", {
          trigger_json: triggerOn("add_to_cart", filter("product.price_old", 10)),
        }),
      ],
    );

    await updateUserEventField("ue_1", "product.price", "item.price", "Price", "number");

    expect(fieldWrites().map((s) => s.values)).toEqual([
      ["item.price", "product.price", "ue_1"],
      ["item.price", "Price", "number", null, null, "ue_1", "product.price"],
    ]);
  });

  it("changes the label and type of an attribute in use when the path stays", async () => {
    respondWith({ ue_1: [metric("m_add_to_cart_sum_product_price", "Total price", { agg_field: "product.price" })] }, []);

    await updateUserEventField("ue_1", "product.price", "product.price", "Unit price", "number", "10");

    expect(fieldWrites().at(-1)?.values).toEqual(["product.price", "Unit price", "number", "10", null, "ue_1", "product.price"]);
  });

  const fieldDeletes = () => dataStatements().filter((s) => s.text.startsWith("DELETE FROM user_event_fields"));

  it("refuses to delete an attribute in use and names each metric definition, campaign, and node", async () => {
    respondWith(
      { ue_1: [metric("m_add_to_cart_sum_product_price", "Add to cart total price", { agg_field: "product.price" })] },
      [
        node("c_recovery", "Cart recovery", "setup-1", {
          trigger_json: triggerOn("add_to_cart", filter("product.price", 500000)),
        }),
        node("c_recovery", "Cart recovery", "check-2", { conditions_json: behaviorOn("add_to_cart", "product.price") }),
      ],
    );

    await expect(deleteUserEventField("product.price", "ue_1")).rejects.toThrow(
      [
        'The attribute "product.price" is in use, so it cannot be deleted. Nothing changed.',
        "",
        "Metric definitions:",
        "- Add to cart total price (m_add_to_cart_sum_product_price)",
        "",
        "Campaigns:",
        "- Cart recovery (active), nodes setup-1, check-2",
        "",
        "The safe way:",
        "1. Add the new field next to the old one.",
        "2. Update the journeys, metrics, and segments that use the old one. A live journey can't be edited in place, so duplicate it, point it at the new field, and swap them.",
        "3. Remove the old field once nothing uses it.",
      ].join("\n"),
    );
    expect(fieldDeletes()).toEqual([]);
    expect(mockStatements.map((s) => s.text)).toContain("ROLLBACK");
  });

  it("refuses to delete a parent whose child is in use", async () => {
    respondWith({}, [
      node("c_recovery", "Cart recovery", "setup-1", {
        trigger_json: triggerOn("add_to_cart", filter("product.price", 500000)),
      }),
    ]);

    await expect(deleteUserEventField("product", "ue_1")).rejects.toThrow(
      /^The attribute "product" is in use, so it cannot be deleted[\s\S]*- Cart recovery \(active\), node setup-1\n\nThe safe way:\n1\. [\s\S]*3\. Remove the old field once nothing uses it\.$/,
    );
    expect(fieldDeletes()).toEqual([]);
  });

  it("checks the uses of a delete under the same lock, then deletes the attribute and its subtree", async () => {
    respondWith(
      { ue_2: [metric("m_view_item_sum_product_price", "Viewed price", { agg_field: "product.price" })] },
      [
        node("c_old", "Old price", "setup-1", {
          trigger_json: triggerOn("add_to_cart", filter("product.price_old", 10)),
        }),
      ],
    );

    await deleteUserEventField("product.price", "ue_1");

    const texts = dataStatements().map((s) => s.text);
    const lock = texts.indexOf("SELECT pg_advisory_xact_lock(hashtext('user_metric_definitions'))");
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(texts.findIndex((text) => text.includes("FROM campaign_nodes")));
    expect(lock).toBeLessThan(texts.findIndex((text) => text.startsWith("DELETE FROM user_event_fields")));
    expect(fieldDeletes().map((s) => s.values)).toEqual([["ue_1", "product.price"]]);
    expect(mockStatements.map((s) => s.text).at(-1)).toBe("COMMIT");
  });
});

describe("the schema gate", () => {
  it("turns an event's gate on and off by its id", async () => {
    mockRespond = (s) => (s.text.startsWith("UPDATE user_events ") ? rows({}) : none);

    await setUserEventSchemaEnforcement("ue_1", true);
    await setUserEventSchemaEnforcement("ue_1", false);

    expect(mockStatements).toEqual([
      { text: "UPDATE user_events SET enforce_schema = $1 WHERE id = $2", values: [true, "ue_1"] },
      { text: "UPDATE user_events SET enforce_schema = $1 WHERE id = $2", values: [false, "ue_1"] },
    ]);
  });

  it("fails when no event has that id", async () => {
    await expect(setUserEventSchemaEnforcement("add_to_cart", true)).rejects.toThrow("Event add_to_cart not found.");
  });

  it("marks one attribute required by its path", async () => {
    mockRespond = (s) => (s.text.startsWith("UPDATE user_event_fields ") ? rows({}) : none);

    await setUserEventFieldRequired("ue_1", "product.price", true);

    expect(mockStatements).toEqual([
      {
        text: "UPDATE user_event_fields SET required = $1 WHERE user_event_id = $2 AND field_path = $3",
        values: [true, "ue_1", "product.price"],
      },
    ]);
  });

  it("fails when the event has no such attribute", async () => {
    await expect(setUserEventFieldRequired("ue_1", "price", true)).rejects.toThrow(
      "Attribute price not found on event ue_1.",
    );
  });

  it("reads the gate with each event and the required flag with each attribute", async () => {
    mockRespond = (s) => {
      if (s.text.includes("FROM user_events ue")) {
        return rows(
          { id: "ue_1", event_name: "add_to_cart", display_name: "Add to cart", field_count: 1, enforce_schema: true, kind: "person" },
          { id: "ue_2", event_name: "view_item", display_name: null, field_count: 0, enforce_schema: false, kind: "person" },
        );
      }
      if (s.text.includes("FROM user_event_fields")) {
        return rows({ field_path: "product.price", display_name: "Price", data_type: "number", required: true });
      }
      return none;
    };

    const page = await getUserEventSummariesPage(null);
    const fields = await getUserEventFields("ue_1");

    expect(page.events.map((event) => [event.id, event.enforceSchema])).toEqual([
      ["ue_1", true],
      ["ue_2", false],
    ]);
    expect(fields.map((field) => [field.value, field.required])).toEqual([["product.price", true]]);
  });
});

describe("normalizing what the catalog stores (CAT-FR-02)", () => {
  const knownEvent = (s: MockStatement) =>
    s.text.startsWith("SELECT 1 FROM user_events") ? rows({}) : none;

  it("stores the system name Add To Cart as add_to_cart, from either create", async () => {
    await createUserEventWithFields(" Add To Cart ", "Add to cart", undefined, person, []);
    await createUserEvent("Add  To Cart", "Add to cart");

    const names = dataStatements()
      .filter((s) => s.text.startsWith("INSERT INTO user_events "))
      .map((s) => s.values[1]);
    expect(names).toEqual(["add_to_cart", "add_to_cart"]);
  });

  it("rejects a blank system name and writes nothing", async () => {
    await expect(createUserEventWithFields("  ", "Blank", undefined, person, [])).rejects.toThrow(
      new UserFacingError("The system name is required."),
    );
    expect(dataStatements()).toEqual([]);
  });

  it("trims each key of an attribute path and lowercases the type", async () => {
    mockRespond = knownEvent;
    await createUserEventWithFields("add_to_cart", "Add to cart", undefined, person, [
      { field_path: " product . price ", display_name: "Price", data_type: " Number " },
    ]);
    await createUserEventField("ue_1", " a. b", "B", "STRING");

    const inserts = dataStatements().filter((s) => s.text.startsWith("INSERT INTO user_event_fields"));
    expect(inserts.map((s) => [s.values[1], s.values[3]])).toEqual([
      ["product.price", "number"],
      ["a.b", "string"],
    ]);
  });

  it.each([
    ["an empty key", "a..b", 'The attribute path "a..b" has an empty key.'],
    ["a leading dot", ".a", 'The attribute path ".a" has an empty key.'],
    ["no key", "  ", "The attribute path is required."],
  ])("rejects a path with %s", async (_case, path, message) => {
    mockRespond = knownEvent;
    await expect(createUserEventField("ue_1", path, "A", "string")).rejects.toThrow(new UserFacingError(message));
    await expect(
      createUserEventWithFields("add_to_cart", "Add to cart", undefined, person, [
        { field_path: path, display_name: "A", data_type: "string" },
      ]),
    ).rejects.toThrow(new UserFacingError(message));
    expect(dataStatements().filter((s) => s.text.startsWith("INSERT"))).toEqual([]);
  });

  it("rejects a type that is not one of the five", async () => {
    mockRespond = knownEvent;
    await expect(createUserEventField("ue_1", "price", "Price", "money")).rejects.toThrow(
      new UserFacingError('The type "money" is not one of string, number, boolean, datetime, json.'),
    );
    await expect(updateUserEventField("ue_1", "price", "price", "Price", "money")).rejects.toThrow(
      'The type "money" is not one of string, number, boolean, datetime, json.',
    );
    expect(dataStatements().filter((s) => s.text.includes("user_event_fields"))).toEqual([]);
  });
});

describe("attribute paths that collide (CAT-FR-03)", () => {
  it("refuses a create with two attributes at one path, instead of dropping one", async () => {
    await expect(
      createUserEventWithFields("add_to_cart", "Add to cart", undefined, person, [
        { field_path: "product.price", display_name: "Price", data_type: "number" },
        { field_path: "product. price", display_name: "Price again", data_type: "string" },
      ]),
    ).rejects.toThrow(new UserFacingError('Two attributes have the path "product.price".'));
    expect(dataStatements()).toEqual([]);
  });

  it("inserts each attribute without skipping a conflict", async () => {
    await createUserEventWithFields("add_to_cart", "Add to cart", undefined, person, [
      { field_path: "price", display_name: "Price", data_type: "number" },
    ]);

    const insert = dataStatements().find((s) => s.text.startsWith("INSERT INTO user_event_fields"));
    expect(insert?.text).not.toContain("ON CONFLICT");
  });

  it("refuses to rename an attribute onto a path that exists, and changes nothing", async () => {
    mockRespond = (s) => {
      if (s.text.includes("FROM user_events ")) return rows({ id: "ue_1", event_name: "add_to_cart" });
      if (s.text.startsWith("SELECT field_path FROM user_event_fields")) return rows({ field_path: "product.sku" });
      return none;
    };

    await expect(updateUserEventField("ue_1", "product.id", "product.sku", "SKU", "string")).rejects.toThrow(
      new UserFacingError('An attribute with the path "product.sku" already exists.'),
    );
    expect(dataStatements().filter((s) => s.text.startsWith("UPDATE user_event_fields"))).toEqual([]);
  });

  it("refuses to move an attribute inside itself", async () => {
    mockRespond = (s) => (s.text.includes("FROM user_events ") ? rows({ id: "ue_1", event_name: "add_to_cart" }) : none);

    await expect(updateUserEventField("ue_1", "product", "product.item", "Item", "json")).rejects.toThrow(
      new UserFacingError('The attribute "product" cannot move inside itself.'),
    );
    expect(dataStatements().filter((s) => s.text.startsWith("UPDATE user_event_fields"))).toEqual([]);
  });
});

describe("editing an attribute's default value (CAT-FR-06)", () => {
  it("writes the default value with the other columns", async () => {
    mockRespond = (s) => (s.text.startsWith("SELECT 1 FROM user_events") ? rows({}) : none);

    await updateUserEventField("ue_1", "currency", "currency", "Currency", "string", "VND", "VND");

    const write = dataStatements().filter((s) => s.text.startsWith("UPDATE user_event_fields")).at(-1);
    expect(write?.text).toContain("default_value = $5");
    expect(write?.values).toEqual(["currency", "Currency", "string", "VND", "VND", "ue_1", "currency"]);
  });

  it("clears the default value when it is blank", async () => {
    mockRespond = (s) => (s.text.startsWith("SELECT 1 FROM user_events") ? rows({}) : none);

    await updateUserEventField("ue_1", "currency", "currency", "Currency", "string", "", "");

    const write = dataStatements().filter((s) => s.text.startsWith("UPDATE user_event_fields")).at(-1);
    expect(write?.values[4]).toBeNull();
  });
});

// The stored event row, its attribute paths, and every campaign node row, for updateUserEvent.
function respondWithStoredEvent(
  stored: Record<string, unknown> | null,
  attributePaths: string[] = [],
  nodes: Record<string, unknown>[] = [],
) {
  mockRespond = (s) => {
    if (s.text.startsWith("SELECT") && s.text.includes("FROM user_events ")) {
      return stored && s.values[0] === "ue_1" ? rows(stored) : none;
    }
    if (s.text.includes("FROM user_event_fields")) {
      return attributePaths.includes(String(s.values[1])) ? rows({}) : none;
    }
    if (s.text.includes("FROM campaign_nodes")) return rows(...nodes);
    if (s.text.startsWith("UPDATE user_events ")) return rows({});
    return none;
  };
}
const eventWrites = () => dataStatements().filter((s) => s.text.startsWith("UPDATE user_events "));
const LOCK = "SELECT pg_advisory_xact_lock(hashtext('user_metric_definitions'))";

describe("editing an event (CAT-FR-05)", () => {
  const addToCart = { event_name: "add_to_cart", kind: "person", item_key: null };

  it("changes the display name and description by id", async () => {
    respondWithStoredEvent(addToCart);

    await updateUserEvent("ue_1", " Add to cart ", " Product added ", person);

    expect(eventWrites()).toEqual([
      expect.objectContaining({ values: ["Add to cart", "Product added", "person", null, "ue_1"] }),
    ]);
    expect(eventWrites()[0].text).toContain("display_name = $1, description = $2");
    expect(mockStatements.map((s) => s.text).at(-1)).toBe("COMMIT");
  });

  it("stores a blank description as none", async () => {
    respondWithStoredEvent(addToCart);

    await updateUserEvent("ue_1", "Add to cart", "  ", person);

    expect(eventWrites()[0].values[1]).toBeNull();
  });

  it("rejects a blank display name and writes nothing", async () => {
    await expect(updateUserEvent("ue_1", " ", "", person)).rejects.toThrow(
      new UserFacingError("The display name is required."),
    );
    expect(mockStatements).toEqual([]);
  });

  it("fails when no event has that id", async () => {
    respondWithStoredEvent(null);

    await expect(updateUserEvent("add_to_cart", "Add to cart", "", person)).rejects.toThrow("Event add_to_cart not found.");
    expect(eventWrites()).toEqual([]);
  });
});

describe("an event's kind (CAT-FR-16, CAT-FR-17)", () => {
  const viewProduct = { event_name: "view_product", kind: "person", item_key: null };
  const priceDrop = { event_name: "price_drop", kind: "business", item_key: "product.id" };
  const business = (itemKey: string) => ({ kind: "business", itemKey }) as const;
  const node = (campaignName: string, status: string, nodeId: string, columns: Record<string, unknown>) => ({
    campaign_id: `c_${campaignName}`,
    campaign_name: campaignName,
    campaign_status: status,
    node_id: nodeId,
    trigger_json: null,
    conditions_json: null,
    paths_json: null,
    ...columns,
  });
  const triggerOn = (name: string) => JSON.stringify({ kind: "event", event: name });

  describe("creating an event", () => {
    const productId = { field_path: "product.id", display_name: "Product id", data_type: "string" };

    it("rejects a business item key that is not one of the attributes, names it, and writes nothing", async () => {
      await expect(
        createUserEventWithFields("price_drop", "Price drop", undefined, business("product.sku"), [productId]),
      ).rejects.toThrow(new UserFacingError('The item key "product.sku" is not one of the event\'s attributes.'));
      expect(dataStatements()).toEqual([]);
    });

    it("writes a business event's kind and item key", async () => {
      await createUserEventWithFields("price_drop", "Price drop", undefined, business("product.id"), [productId]);

      const insert = dataStatements().find((s) => s.text.startsWith("INSERT INTO user_events "));
      expect(insert?.values.slice(1)).toEqual(["price_drop", "Price drop", null, "business", "product.id"]);
    });

    it("writes a person event with no item key", async () => {
      await createUserEventWithFields("view_product", "View product", undefined, person, []);

      const insert = dataStatements().find((s) => s.text.startsWith("INSERT INTO user_events "));
      expect(insert?.values.slice(4)).toEqual(["person", null]);
    });
  });

  describe("reading the list", () => {
    it("reads each event's kind and a business event's item key", async () => {
      mockRespond = (s) =>
        s.text.includes("FROM user_events ue")
          ? rows(
              { id: "ue_1", event_name: "price_drop", field_count: 1, kind: "business", item_key: "product.id" },
              { id: "ue_2", event_name: "view_product", field_count: 0, kind: "person", item_key: null },
            )
          : none;

      const page = await getUserEventSummariesPage(null);

      expect(page.events.map((event) => event.eventKind)).toEqual([
        { kind: "business", itemKey: "product.id" },
        { kind: "person" },
      ]);
    });

    it("skips a business row with no item key, logs its id, and keeps paging past it", async () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      mockRespond = (s) =>
        s.text.includes("FROM user_events ue")
          ? rows(
              { id: "ue_1", event_name: "a", field_count: 0, kind: "person", item_key: null },
              { id: "ue_2", event_name: "b", field_count: 0, kind: "business", item_key: null },
              { id: "ue_3", event_name: "c", field_count: 0, kind: "person", item_key: null },
            )
          : none;
      try {
        const page = await getUserEventSummariesPage(null, 2);

        expect(page.events.map((event) => event.id)).toEqual(["ue_1"]);
        expect(page.nextCursor).toEqual({ eventName: "b", id: "ue_2" });
        expect(warn.mock.calls.map((call) => call.join(" "))).toEqual([expect.stringContaining("ue_2")]);
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("changing the kind of an event", () => {
    it("makes a person event business when nothing uses it, after taking the lock first", async () => {
      respondWithStoredEvent(viewProduct, ["product.id"], [
        node("Other", "active", "setup-1", { trigger_json: triggerOn("view_item") }),
      ]);

      await updateUserEvent("ue_1", "View product", "", business("product.id"));

      expect(eventWrites().map((s) => s.values)).toEqual([["View product", null, "business", "product.id", "ue_1"]]);
      const texts = dataStatements().map((s) => s.text);
      expect(texts[0]).toBe(LOCK);
      expect(mockStatements.map((s) => s.text).at(-1)).toBe("COMMIT");
    });

    it("refuses while an active or a paused campaign uses the event, and names each campaign and node", async () => {
      respondWithStoredEvent(viewProduct, ["product.id"], [
        node("Spring sale", "active", "setup-1", { trigger_json: triggerOn("view_product") }),
        node("Spring sale", "active", "watch-2", { trigger_json: triggerOn("view_product") }),
        node("Restock", "paused", "check-1", {
          conditions_json: JSON.stringify({
            groups: [{ conditions: [{ type: "behavior", event: "view_product", measure: "COUNT", op: ">=", value: 1, metric_id: "m_views" }] }],
          }),
        }),
        node("Other", "active", "setup-1", { trigger_json: triggerOn("view_item") }),
      ]);

      await expect(updateUserEvent("ue_1", "View product", "", business("product.id"))).rejects.toThrow(
        new UserFacingError(
          [
            'Can\'t change the kind of "view_product" to business: these campaigns use it. Remove these uses first.',
            "- Spring sale (active), nodes setup-1, watch-2",
            "- Restock (paused), node check-1",
          ].join("\n"),
        ),
      );
      expect(eventWrites()).toEqual([]);
      expect(mockStatements.map((s) => s.text)).toContain("ROLLBACK");
    });

    it("refuses an item key that is not one of the event's attributes", async () => {
      respondWithStoredEvent(viewProduct, ["product.id"]);

      await expect(updateUserEvent("ue_1", "View product", "", business("product.sku"))).rejects.toThrow(
        new UserFacingError('The item key "product.sku" is not one of the event\'s attributes.'),
      );
      expect(eventWrites()).toEqual([]);
    });

    it.each([
      ["back to person", person],
      ["to another item key", business("product.sku")],
    ])("refuses to change a business event %s", async (_case, kind) => {
      respondWithStoredEvent(priceDrop, ["product.id", "product.sku"]);

      await expect(updateUserEvent("ue_1", "Price drop", "", kind)).rejects.toThrow(
        new UserFacingError("The kind and the item key of a business event are fixed."),
      );
      expect(eventWrites()).toEqual([]);
    });

    it("keeps a business event's kind and item key when only its display name changes", async () => {
      respondWithStoredEvent(priceDrop, ["product.id"], [
        node("Price alerts", "active", "setup-1", { trigger_json: triggerOn("price_drop") }),
      ]);

      await updateUserEvent("ue_1", "Price dropped", "", business("product.id"));

      expect(eventWrites().map((s) => s.values)).toEqual([["Price dropped", null, "business", "product.id", "ue_1"]]);
    });
  });

  describe("renaming or deleting the item key (CAT-FR-17)", () => {
    beforeEach(() => {
      mockRespond = (s) =>
        s.text.includes("FROM user_events ") ? rows({ id: "ue_1", ...priceDrop }) : none;
    });
    const fieldChanges = () =>
      dataStatements().filter((s) => /^(UPDATE|DELETE FROM) user_event_fields/.test(s.text));

    it.each([
      ["renames the item key", () => updateUserEventField("ue_1", "product.id", "sku", "Product id", "string"),
        'The attribute "product.id" is the item key of this event, so it cannot be renamed.'],
      ["deletes the item key", () => deleteUserEventField("product.id", "ue_1"),
        'The attribute "product.id" is the item key of this event, so it cannot be deleted.'],
      ["renames its parent", () => updateUserEventField("ue_1", "product", "item", "Product", "json"),
        'The attribute "product" holds the item key "product.id", so it cannot be renamed.'],
      ["deletes its parent", () => deleteUserEventField("product", "ue_1"),
        'The attribute "product" holds the item key "product.id", so it cannot be deleted.'],
    ])("refuses when the admin %s, and changes no attribute", async (_case, change, message) => {
      await expect(change()).rejects.toThrow(new UserFacingError(message));
      expect(fieldChanges()).toEqual([]);
    });

    it("changes the item key's label and type when its path stays", async () => {
      await updateUserEventField("ue_1", "product.id", "product.id", "SKU", "number");

      expect(fieldChanges().at(-1)?.values).toEqual(["product.id", "SKU", "number", null, null, "ue_1", "product.id"]);
    });

    it("renames a sibling of the item key", async () => {
      await updateUserEventField("ue_1", "product.idx", "product.index", "Index", "number");

      expect(fieldChanges().at(-1)?.values).toEqual(["product.index", "Index", "number", null, null, "ue_1", "product.idx"]);
    });
  });
});

describe("the status badge (CAT-FR-07)", () => {
  it("reads each event's stored status", async () => {
    mockRespond = (s) =>
      s.text.includes("FROM user_events ue")
        ? rows({ id: "ue_1", event_name: "add_to_cart", display_name: "Add to cart", field_count: 0, status: "active", kind: "person" })
        : none;

    const page = await getUserEventSummariesPage(null);

    expect(page.events[0].status).toBe("active");
  });
});

describe("an event's status (CAT-FR-05)", () => {
  it("lists events of every status for the admin", async () => {
    mockRespond = (s) =>
      s.text.includes("FROM user_events ue")
        ? rows({ id: "ue_1", event_name: "add_to_cart", display_name: "Add to cart", field_count: 0, status: "inactive", kind: "person" })
        : none;

    const page = await getUserEventSummariesPage(null);

    expect(page.events.map((event) => event.status)).toEqual(["inactive"]);
    expect(mockStatements[0].text).not.toContain("ue.status = 'active'");
  });

  it("offers only active events to the builder", async () => {
    await getUserEvents();
    expect(mockStatements[0].text).toContain("WHERE ue.status = 'active'");
  });

  it("switches an event between active and inactive by its id", async () => {
    mockRespond = (s) => (s.text.startsWith("UPDATE user_events ") ? rows({}) : none);

    await setUserEventStatus("ue_1", "inactive");
    await setUserEventStatus("ue_1", " Active ");

    expect(mockStatements).toEqual([
      { text: "UPDATE user_events SET status = $1 WHERE id = $2", values: ["inactive", "ue_1"] },
      { text: "UPDATE user_events SET status = $1 WHERE id = $2", values: ["active", "ue_1"] },
    ]);
  });

  it("rejects a status that is not active or inactive and writes nothing", async () => {
    await expect(setUserEventStatus("ue_1", "archived")).rejects.toThrow(
      new UserFacingError('The status "archived" is not one of active, inactive.'),
    );
    expect(mockStatements).toEqual([]);
  });

  it("fails when no event has that id", async () => {
    await expect(setUserEventStatus("add_to_cart", "inactive")).rejects.toThrow("Event add_to_cart not found.");
  });
});

describe("editing an event's details in studio v2 (CAT-FR-05)", () => {
  it("changes only the display name and the description, by id", async () => {
    mockRespond = (s) => (s.text.startsWith("UPDATE user_events") ? rows({}) : none);

    await updateUserEventDetails("ue_1", " Add to cart ", "  ");

    expect(mockStatements).toEqual([
      { text: "UPDATE user_events SET display_name = $1, description = $2 WHERE id = $3", values: ["Add to cart", null, "ue_1"] },
    ]);
  });

  it("rejects a blank display name and writes nothing", async () => {
    await expect(updateUserEventDetails("ue_1", " ", "")).rejects.toThrow(new UserFacingError("The display name is required."));
    expect(mockStatements).toEqual([]);
  });

  it("fails when no event has that id", async () => {
    await expect(updateUserEventDetails("add_to_cart", "Add to cart", "")).rejects.toThrow("Event add_to_cart not found.");
  });
});

describe("adding attributes to an event (CAT-FR-03)", () => {
  // The event has the attributes in `stored`. The parent UPDATE returns the ones it changed.
  const known = (stored: string[] = []) => (s: MockStatement): MockResult => {
    if (s.text.startsWith("SELECT 1 FROM user_events")) return s.values[0] === "ue_1" ? rows({}) : none;
    if (s.text.startsWith("SELECT event_name, item_key FROM user_events")) {
      return s.values[0] === "ue_1" ? rows({ event_name: "add_to_cart", item_key: null }) : none;
    }
    const asked = (s.values[1] ?? []) as string[];
    const found = () => rows(...stored.filter((path) => asked.includes(path)).map((field_path) => ({ field_path })));
    if (s.text.startsWith("SELECT field_path FROM user_event_fields")) return found();
    if (s.text.startsWith("UPDATE user_event_fields")) return found();
    return none;
  };
  const inserts = () => dataStatements().filter((s) => s.text.startsWith("INSERT INTO user_event_fields"));

  it("makes each parent the event already has json, and inserts each attribute, in one transaction", async () => {
    mockRespond = known(["product", "product.color"]);

    await addUserEventFields("ue_1", [
      { field_path: " product . size ", display_name: "Size", data_type: "String", example_value: "XL" },
      { field_path: "product.color.name", display_name: "", data_type: "string" },
    ]);

    const parents = dataStatements().find((s) => s.text.startsWith("UPDATE user_event_fields"));
    expect(parents?.text).toContain("data_type = 'json'");
    expect(parents?.values).toEqual(["ue_1", ["product", "product.color"]]);
    expect(inserts().map((s) => s.values)).toEqual([
      ["ue_1", "product.color.name", "", "string", null],
      ["ue_1", "product.size", "Size", "string", "XL"],
    ]);
    expect(mockStatements[0].text).toBe("BEGIN");
    expect(mockStatements.at(-1)?.text).toBe("COMMIT");
  });

  it("creates each parent the event lacks as json, so no attribute is left without its parent", async () => {
    mockRespond = known();

    await addUserEventFields("ue_1", [{ field_path: "product.size", display_name: "Size", data_type: "string" }]);

    expect(inserts().map((s) => s.values)).toEqual([
      ["ue_1", "product", "product", "json", null],
      ["ue_1", "product.size", "Size", "string", null],
    ]);
  });

  it("adds a parent in the batch as json when the batch also holds its children", async () => {
    mockRespond = known();

    await addUserEventFields("ue_1", [
      { field_path: "product", display_name: "Product", data_type: "string", example_value: "x" },
      { field_path: "product.price", display_name: "Price", data_type: "number" },
    ]);

    expect(dataStatements().some((s) => s.text.startsWith("UPDATE user_event_fields"))).toBe(false);
    expect(inserts().map((s) => s.values)).toEqual([
      ["ue_1", "product", "Product", "json", null],
      ["ue_1", "product.price", "Price", "number", null],
    ]);
  });

  it("refuses a path the event already has, names it, and writes nothing", async () => {
    mockRespond = known(["quantity"]);

    await expect(
      addUserEventFields("ue_1", [
        { field_path: "note", display_name: "", data_type: "string" },
        { field_path: "quantity", display_name: "", data_type: "number" },
      ]),
    ).rejects.toThrow(new UserFacingError('An attribute with the path "quantity" already exists.'));
    expect(inserts()).toEqual([]);
    expect(mockStatements.at(-1)?.text).toBe("ROLLBACK");
  });

  it("refuses two attributes at one path, or none, before it reads", async () => {
    await expect(
      addUserEventFields("ue_1", [
        { field_path: "note", display_name: "", data_type: "string" },
        { field_path: " note", display_name: "", data_type: "string" },
      ]),
    ).rejects.toThrow('Two attributes have the path "note".');
    await expect(addUserEventFields("ue_1", [])).rejects.toThrow("Add at least one attribute.");
    expect(mockStatements).toEqual([]);
  });

  it("fails on an unknown event id and inserts nothing", async () => {
    mockRespond = known();

    await expect(addUserEventFields("add_to_cart", [{ field_path: "note", display_name: "", data_type: "string" }])).rejects.toThrow(
      "Event add_to_cart not found.",
    );
    expect(inserts()).toEqual([]);
  });
});

describe("findUserEventByName", () => {
  it("returns the event with the exact name and its label, or null (CAT-FR-02)", async () => {
    mockRespond = (s) =>
      s.text.includes("FROM user_events WHERE event_name") && s.values[0] === "com.acme/order_completed"
        ? rows({ id: "ue_7", label: "Order completed" })
        : none;

    await expect(findUserEventByName("com.acme/order_completed")).resolves.toEqual({ id: "ue_7", label: "Order completed" });
    await expect(findUserEventByName("com.acme/other")).resolves.toBeNull();
  });
});
