/** @jest-environment node */

// When Postgres fails, a server action must not hand the driver's message to the browser: it can
// name constraints and columns and quote values from the failed row. These tests make each
// action's statements fail with a driver-shaped error and read what the action returns.
import type { AdminSession } from "@/shared/auth/types";

let mockFailure: Error = new Error("not set");

const admin: AdminSession = { userId: "user_admin", email: "admin@example.com", role: "admin" };

jest.mock("server-only", () => ({}));
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }));
jest.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
jest.mock("@/shared/auth/session", () => ({
  assertSession: async () => admin,
  assertAdmin: async () => admin,
}));

jest.mock("../../shared/node_modules/pg", () => {
  // The start-up check and the transaction statements succeed, so the failure comes from the
  // action's own reads and writes.
  const query = async (text: string) => {
    if (
      text === "BEGIN" ||
      text === "ROLLBACK" ||
      /to_regclass|ALTER TABLE system_users/.test(text) ||
      text.startsWith("CREATE UNIQUE INDEX") ||
      text.includes("information_schema.columns")
    ) {
      return { rows: [], rowCount: 0 };
    }
    throw mockFailure;
  };
  return {
    Pool: jest.fn().mockImplementation(() => ({
      query,
      connect: async () => ({ query, release: () => undefined }),
    })),
  };
});

import * as actions from "@/app/actions";

const pgError = (message: string, fields: Record<string, string>) => Object.assign(new Error(message), fields);

const constraintFailure = pgError(
  'null value in column "user_event_id" of relation "user_metric_definitions" violates not-null constraint',
  { code: "23502", detail: "Failing row contains (m_vip, vip@example.com, ...)." },
);
const connectionFailure = pgError("connect ECONNREFUSED 10.0.4.17:5432", { code: "ECONNREFUSED" });

const journey = {
  type: "setup",
  id: "setup-1",
  label: "Trigger",
  description: "Define journey settings",
  triggerType: "user",
  triggerEventName: "purchase",
  next: { type: "end", goalId: "goal_default" },
};

const cases: Array<[string, () => Promise<unknown>, string]> = [
  ["publishCampaignAction", () => actions.publishCampaignAction({ id: "c_1", name: "Promo", description: "", root: journey }), "Failed to publish campaign."],
  ["deleteCampaignAction", () => actions.deleteCampaignAction("c_1"), "Failed to delete campaign."],
  ["toggleCampaignStatusAction", () => actions.toggleCampaignStatusAction("c_1", "paused"), "Failed to update campaign status."],
  ["createUserEventAction", () => actions.createUserEventAction("purchase", "Purchase"), "Failed to create user event."],
  ["createUserEventWithFieldsAction", () => actions.createUserEventWithFieldsAction("purchase", "Purchase", undefined, { kind: "person" }, []), "Failed to create user event with fields."],
  ["updateUserEventAction", () => actions.updateUserEventAction("ue_purchase", "Purchase", "", { kind: "person" }), "Failed to update the event."],
  ["getUserEventUsageAction", () => actions.getUserEventUsageAction("ue_purchase"), "Failed to load what uses this event."],
  ["deleteUserEventAction", () => actions.deleteUserEventAction("ue_purchase"), "Failed to delete user event."],
  ["createUserEventFieldAction", () => actions.createUserEventFieldAction("ue_purchase", "price", "Price", "number"), "Failed to create user event field."],
  ["deleteUserEventFieldAction", () => actions.deleteUserEventFieldAction("price", "ue_purchase"), "Failed to delete user event field."],
  ["updateUserEventFieldAction", () => actions.updateUserEventFieldAction("ue_purchase", "price", { fieldPath: "price", displayName: "Price", dataType: "number", exampleValue: "", defaultValue: "" }), "Failed to update user event field."],
];

let consoleError: jest.SpyInstance;

beforeAll(() => {
  process.env.DATABASE_URL = "postgres://test";
});

beforeEach(() => {
  consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleError.mockRestore();
});

describe.each([
  ["a constraint violation", constraintFailure],
  ["a refused connection", connectionFailure],
])("on %s", (_, failure) => {
  it.each(cases)("%s returns a fixed message and logs the detail", async (_name, call, message) => {
    mockFailure = failure;

    await expect(call()).resolves.toEqual({ error: message });
    expect(consoleError).toHaveBeenCalledWith(expect.any(String), failure);
  });
});

it("still names an event whose system name exists", async () => {
  mockFailure = pgError('duplicate key value violates unique constraint "user_events_event_name_key"', {
    code: "23505",
    constraint: "user_events_event_name_key",
  });

  await expect(actions.createUserEventAction("purchase", "Purchase")).resolves.toEqual({
    error: 'An event with the system name "purchase" already exists.',
  });
});

it.each([
  ["createUserEventWithFieldsAction", () => actions.createUserEventWithFieldsAction("purchase", "Purchase", undefined, { kind: "item" }, [])],
  ["updateUserEventAction", () => actions.updateUserEventAction("ue_purchase", "Purchase", "", { kind: "item" })],
])("%s names the allowed kinds when the kind is not one of them", async (_name, call) => {
  await expect(call()).resolves.toEqual({ error: 'The kind "item" is not one of person, business.' });
});

it.each([
  ["no item key", { kind: "business" }],
  ["a blank item key", { kind: "business", itemKey: "  " }],
])("rejects a business event with %s and names the item key before any statement runs", async (_case, kind) => {
  mockFailure = constraintFailure;
  const fields = [{ fieldPath: "product.id", displayName: "Product id", dataType: "string" }];

  await expect(actions.createUserEventWithFieldsAction("price_drop", "Price drop", undefined, kind, fields)).resolves.toEqual({
    error: "A business event needs an item key, one of its attributes such as product.id.",
  });
});
