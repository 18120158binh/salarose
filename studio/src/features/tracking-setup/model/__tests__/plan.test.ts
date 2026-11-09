/** @jest-environment node */
import type { CatalogEvent } from "@/features/data-health/model/catalog";
import { trackingPlan } from "../plan";

function event(name: string, extra: Partial<CatalogEvent> = {}): CatalogEvent {
  return {
    id: name,
    name,
    label: name,
    description: null,
    kind: "person",
    status: "active",
    gate: false,
    attributeCount: 0,
    requiredCount: 0,
    createdAt: null,
    attributes: [],
    ...extra,
  };
}

const NONE = { product_viewed: [], add_to_cart: [], order_completed: [] };

describe("trackingPlan", () => {
  it("says how each event is checked: strict with its required count, accepts all, or from the server", () => {
    const plan = trackingPlan(
      3,
      [event("com.acme/add_to_cart", { gate: true, requiredCount: 3 }), event("com.acme/product_viewed"), event("purchase", { kind: "business" })],
      NONE,
    );

    expect(plan.size).toBe(3);
    expect(plan.events.map((entry) => entry.note)).toEqual(["Strict · 3 must be sent", "Accepts all", "From the server"]);
  });

  it("lists at most six events", () => {
    const many = Array.from({ length: 9 }, (_, index) => event(`com.acme/e${index}`));

    expect(trackingPlan(9, many, NONE).events).toHaveLength(6);
  });

  it("matches a sample only by its exact active name, so a search hit on a longer name does not count", () => {
    const plan = trackingPlan(0, [], {
      ...NONE,
      add_to_cart: [event("com.acme/add_to_cart_v2"), event("com.acme/add_to_cart", { gate: true, requiredCount: 2 })],
      order_completed: [event("com.acme/order_completed", { status: "inactive" })],
    });

    expect(plan.samples.add_to_cart?.note).toBe("Strict · 2 must be sent");
    expect(plan.samples.order_completed).toBeNull();
    expect(plan.samples.product_viewed).toBeNull();
  });
});
