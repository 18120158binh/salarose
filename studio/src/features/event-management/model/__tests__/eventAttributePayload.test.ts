import { eventAttributesToJson, jsonToEventAttributes, type EditableEventAttribute } from "../eventAttributePayload";

function idSequence() {
  let next = 0;
  return () => `id-${++next}`;
}

const summary = (attributes: EditableEventAttribute[]) =>
  attributes.map(({ value, dataType, exampleValue }) => [value, dataType, exampleValue]);

describe("inferring attributes from a sample payload (CAT-FR-03)", () => {
  it("infers product (json), product.id (string), and product.price (number)", () => {
    const attributes = jsonToEventAttributes('{"product": {"id": "SKU-1", "price": 1}}', [], idSequence());

    expect(summary(attributes)).toEqual([
      ["product", "json", ""],
      ["product.id", "string", "SKU-1"],
      ["product.price", "number", "1"],
    ]);
  });

  it("types booleans and arrays, labels each key, and keeps a known attribute's id and label", () => {
    const existing: EditableEventAttribute[] = [
      { id: "kept", value: "is_gift", displayName: "Gift?", dataType: "boolean", exampleValue: "" },
    ];
    const attributes = jsonToEventAttributes('{"is_gift": true, "tags": ["a"], "sent_at": null}', existing, idSequence());

    expect(attributes.map(({ id, value, displayName, dataType }) => [id, value, displayName, dataType])).toEqual([
      ["kept", "is_gift", "Gift?", "boolean"],
      ["id-1", "tags", "Tags", "json"],
      ["id-2", "sent_at", "Sent At", "string"],
    ]);
  });

  it("keeps a datetime type while the sample value is a string", () => {
    const existing: EditableEventAttribute[] = [
      { id: "a", value: "sent_at", displayName: "Sent at", dataType: "datetime", exampleValue: "" },
    ];
    expect(jsonToEventAttributes('{"sent_at": "2026-10-18T09:30:00+07:00"}', existing, idSequence())[0].dataType).toBe(
      "datetime",
    );
  });

  it("rejects a payload that is not an object", () => {
    expect(() => jsonToEventAttributes("[1]", [], idSequence())).toThrow("The payload must be a JSON object.");
    expect(() => jsonToEventAttributes("{", [], idSequence())).toThrow(SyntaxError);
  });

  it.each([
    ['{"a.b": 1}', 'The key "a.b" contains a dot. Nest it as an object instead.'],
    ['{"product": {"": 1}}', "The payload has an empty key inside product."],
    ['{" ": 1}', "The payload has an empty key."],
  ])("rejects the key in %s instead of renaming it", (payload, message) => {
    expect(() => jsonToEventAttributes(payload, [], idSequence())).toThrow(message);
  });

  it("rejects two keys that trim to one path", () => {
    expect(() => jsonToEventAttributes('{"price": 1, " price": 2}', [], idSequence())).toThrow(
      'Two keys give the path "price".',
    );
  });
});

describe("writing attributes as a sample payload", () => {
  it("round-trips the attribute tree through JSON", () => {
    const attributes = jsonToEventAttributes(
      '{"product": {"id": "SKU-1", "price": 12.5, "in_stock": true}, "quantity": 2}',
      [],
      idSequence(),
    );

    expect(JSON.parse(eventAttributesToJson(attributes))).toEqual({
      product: { id: "SKU-1", in_stock: true, price: 12.5 },
      quantity: 2,
    });
  });
});
