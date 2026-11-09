/** @jest-environment node */
import type { SystemUser } from "@/lib/db";
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

const mockSessionUser: { current: unknown } = { current: undefined };
jest.mock("@/lib/db", () => ({
  getAdminUserById: async () => mockSessionUser.current,
  createUserEventWithFields: jest.fn(async () => "ue_new"),
  findUserEventByName: jest.fn(async () => null),
  updateUserEventDetails: jest.fn(async () => undefined),
  setUserEventStatus: jest.fn(async () => undefined),
  setUserEventSchemaEnforcement: jest.fn(async () => undefined),
  setUserEventFieldRequired: jest.fn(async () => undefined),
  addUserEventFields: jest.fn(async () => undefined),
  updateUserEventField: jest.fn(async () => undefined),
  deleteUserEventField: jest.fn(async () => undefined),
  deleteUserEvent: jest.fn(async () => undefined),
}));

import * as db from "@/lib/db";
import { SESSION_COOKIE } from "@/shared/auth/constants";
import { DuplicateEventNameError } from "shared/lib/eventCatalog";
import { UserFacingError } from "shared/lib/userFacingError";
import {
  addAttributesAction,
  createEventAction,
  deleteAttributeAction,
  deleteEventAction,
  setAttributeRequiredAction,
  setEventGateAction,
  setEventStatusAction,
  updateAttributeAction,
  updateEventDetailsAction,
} from "../actions";

const SECRET = "test-session-secret-0123456789-abcdef";

async function signIn(role: "admin" | "editor"): Promise<void> {
  const user = { id: `user-${role}`, email: `${role}@example.com`, role, session_epoch: 0 } as SystemUser & { session_epoch: number };
  mockSessionUser.current = user;
  const token = await signSessionToken(
    { userId: user.id, email: user.email, epoch: 0, providerId: "default" },
    new TextEncoder().encode(SECRET),
    3600,
  );
  mockCookieValues.set(SESSION_COOKIE, token);
}

const WRITES = [
  db.createUserEventWithFields,
  db.updateUserEventDetails,
  db.setUserEventStatus,
  db.setUserEventSchemaEnforcement,
  db.setUserEventFieldRequired,
  db.addUserEventFields,
  db.updateUserEventField,
  db.deleteUserEventField,
  db.deleteUserEvent,
].map((write) => jest.mocked(write));

const ATTRIBUTE = { path: "note", label: "Note", type: "string", example: "" };

const CALLS: [string, () => Promise<unknown>][] = [
  ["createEventAction", () => createEventAction({ name: "add_to_cart", displayName: "Add to cart", attributes: [] })],
  ["updateEventDetailsAction", () => updateEventDetailsAction("ue_1", "Add to cart", "")],
  ["setEventStatusAction", () => setEventStatusAction("ue_1", "inactive")],
  ["setEventGateAction", () => setEventGateAction("ue_1", true)],
  ["setAttributeRequiredAction", () => setAttributeRequiredAction("ue_1", "note", true)],
  ["addAttributesAction", () => addAttributesAction("ue_1", [ATTRIBUTE])],
  ["updateAttributeAction", () => updateAttributeAction("ue_1", "note", { ...ATTRIBUTE, path: "memo", defaultValue: "" })],
  ["deleteAttributeAction", () => deleteAttributeAction("ue_1", "note")],
  ["deleteEventAction", () => deleteEventAction("ue_1")],
];

beforeAll(() => {
  process.env.SESSION_SECRET = SECRET;
});

beforeEach(() => {
  mockCookieValues.clear();
  mockSessionUser.current = undefined;
  for (const write of WRITES) write.mockClear();
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

// CAT-FR-10, DHL-FR-12: a direct call to a catalog change writes nothing unless an admin makes it.
describe.each([
  ["no session", { result: "Unauthorized", arrange: async () => {} }],
  ["an editor's session", { result: "Only admin users can do this.", arrange: () => signIn("editor") }],
])("with %s", (_case, { result, arrange }) => {
  beforeEach(arrange);

  it.each(CALLS)("%s fails and writes nothing", async (_name, call) => {
    await expect(call()).resolves.toEqual({ error: result });
    for (const write of WRITES) expect(write).not.toHaveBeenCalled();
  });
});

describe("for an admin", () => {
  beforeEach(() => signIn("admin"));

  it("creates every event with the kind person, whatever the browser sends (CAT-FR-18)", async () => {
    const result = await createEventAction({
      name: "Price Drop",
      displayName: "Price drop",
      description: "",
      kind: { kind: "business", itemKey: "product.id" },
      attributes: [{ path: "product.id", label: "Product id", type: "string", example: "SKU-1" }],
    });

    expect(result).toEqual({ eventId: "ue_new" });
    expect(db.createUserEventWithFields).toHaveBeenCalledWith("Price Drop", "Price drop", "", { kind: "person" }, [
      { field_path: "product.id", display_name: "Product id", data_type: "string", example_value: "SKU-1" },
    ]);
  });

  it("names the event that already holds the tracking name, so the form can link to it (CAT-FR-02)", async () => {
    jest.mocked(db.createUserEventWithFields).mockRejectedValueOnce(new DuplicateEventNameError("com.acme/order_completed"));
    jest.mocked(db.findUserEventByName).mockResolvedValueOnce({ id: "ue_7", label: "Order completed" });

    const result = await createEventAction({ name: "com.acme/order_completed", displayName: "Order completed", attributes: [] });

    expect(result).toEqual({
      error: 'An event with the system name "com.acme/order_completed" already exists.',
      existing: { id: "ue_7", label: "Order completed", name: "com.acme/order_completed" },
    });
    expect(db.findUserEventByName).toHaveBeenCalledWith("com.acme/order_completed");
  });

  it("returns the catalog's refusal unchanged, so it names each use (CAT-FR-11)", async () => {
    const refusal = 'The attribute "product.price" is in use, so it cannot be renamed. Remove these uses first.\n\nMetric definitions:\n- Cart value (m1)';
    jest.mocked(db.updateUserEventField).mockRejectedValueOnce(new UserFacingError(refusal));

    const result = await updateAttributeAction("ue_1", "product.price", { path: "product.cost", label: "", type: "number" });

    expect(result).toEqual({ error: refusal });
  });

  it("hides a failure that is not the catalog's own message", async () => {
    jest.mocked(db.deleteUserEvent).mockRejectedValueOnce(new Error("connection reset"));

    await expect(deleteEventAction("ue_1")).resolves.toEqual({ error: "Failed to delete the event." });
  });

  it("refuses a gate or Required value that is not a boolean, before it writes", async () => {
    await expect(setEventGateAction("ue_1", "true")).resolves.toEqual({ error: "The schema gate must be on or off." });
    await expect(setAttributeRequiredAction("ue_1", "note", 1)).resolves.toEqual({ error: "The Required box must be on or off." });
    expect(db.setUserEventSchemaEnforcement).not.toHaveBeenCalled();
    expect(db.setUserEventFieldRequired).not.toHaveBeenCalled();
  });

  it("passes each change to the catalog by the event's id", async () => {
    await setEventStatusAction("ue_1", "inactive");
    await setEventGateAction("ue_1", false);
    await deleteAttributeAction("ue_1", "product");

    expect(db.setUserEventStatus).toHaveBeenCalledWith("ue_1", "inactive");
    expect(db.setUserEventSchemaEnforcement).toHaveBeenCalledWith("ue_1", false);
    expect(db.deleteUserEventField).toHaveBeenCalledWith("product", "ue_1");
  });
});
