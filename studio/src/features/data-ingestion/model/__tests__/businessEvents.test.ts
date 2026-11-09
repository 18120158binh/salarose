/** @jest-environment node */
import type { EventKind } from "shared/lib/eventCatalog";
import { businessEventKey, validateBusinessEvents } from "../businessEvents";

const catalog = new Map<string, EventKind>([
  ["price_drop", { kind: "business", itemKey: "product.id" }],
  ["add_to_cart", { kind: "person" }],
]);

const priceDrop = {
  event_id: "0f8b2c1e-5d4a-4c3b-9a21-7e6f5d4c3b2a",
  event_name: "price_drop",
  event_time: "2026-10-21T09:00:00Z",
  attributes: { product: { id: "SKU-123", price: 899000 }, drop_percent: 15 },
};

function reasonFor(event: unknown): string | undefined {
  return validateBusinessEvents([event], catalog, "inventory").rejected[0]?.reason;
}

describe("validateBusinessEvents", () => {
  it("keys the price drop by its name, U+001F, and its item key", () => {
    const [record] = validateBusinessEvents([priceDrop], catalog, "inventory").accepted;

    expect(businessEventKey(record)).toBe("price_drop\u001fSKU-123");
  });

  it("checks each event on its own and names the rejected one by index and id", () => {
    const bad = { ...priceDrop, event_id: "not-a-uuid" };

    const result = validateBusinessEvents([priceDrop, bad], catalog, "inventory");

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toEqual([{ index: 1, event_id: "not-a-uuid", reason: "event_id must be a UUID" }]);
  });

  it("requires a name and a time with a zone or in epoch milliseconds", () => {
    expect(reasonFor({ ...priceDrop, event_name: " " })).toBe("event_name must be non-empty text");
    expect(reasonFor({ ...priceDrop, event_time: "2026-10-21T09:00:00" })).toBe(
      "event_time must be ISO 8601 with a zone, or epoch milliseconds",
    );
    expect(reasonFor({ ...priceDrop, event_time: 1785800000000 })).toBeUndefined();
  });

  it("rejects an anonymous_id as it rejects a user_id", () => {
    expect(reasonFor({ ...priceDrop, anonymous_id: "d1" })).toBe("a business event must not carry user_id or anonymous_id");
  });

  it("rejects attributes that are not an object", () => {
    expect(reasonFor({ ...priceDrop, attributes: [1] })).toBe("attributes must be a JSON object");
  });

  it("rejects a name the catalog does not hold", () => {
    expect(reasonFor({ ...priceDrop, event_name: "restock" })).toBe("restock is not a business event in the event catalog");
  });

  it("takes a number item key as text and refuses an empty one", () => {
    const numeric = { ...priceDrop, attributes: { product: { id: 123 } } };
    expect(validateBusinessEvents([numeric], catalog, "inventory").accepted[0].item_key).toBe("123");
    expect(reasonFor({ ...priceDrop, attributes: { product: { id: "" } } })).toBe(
      "the item key product.id is missing from attributes",
    );
  });

  it("leaves out event_id from a rejection when the event has none", () => {
    const result = validateBusinessEvents(["x"], catalog, "inventory");

    expect(result.rejected).toEqual([{ index: 0, reason: "event must be a JSON object" }]);
  });
});
