import { classifyAddInside, classifyDelete, classifyFieldEdit, classifyRequired, examplePayload } from "../eventAttributeChange";
import type { EventDetailAttribute } from "../eventDetail";

const field = (path: string, type: string, example: string | null = null): EventDetailAttribute => ({
  path,
  label: path,
  type,
  required: false,
  example,
  defaultValue: null,
});

describe("field change kinds (CAT-FR-11)", () => {
  const price = field("product.price", "number");

  it("calls a label, example, or if-missing change Safe", () => {
    expect(classifyFieldEdit(price, { path: "product.price", type: "number" }, 2)).toBe("safe");
  });

  it("calls a rename or a type change Breaking, refused while in use", () => {
    expect(classifyFieldEdit(price, { path: "product.cost", type: "number" }, 0)).toBe("breaking");
    expect(classifyFieldEdit(price, { path: "product.price", type: "string" }, 0)).toBe("breaking");
    expect(classifyFieldEdit(price, { path: "product.cost", type: "number" }, 1)).toBe("refused");
  });

  it("asks first for Must be sent and saves optional at once (CAT-FR-14)", () => {
    expect(classifyRequired(true)).toBe("asks-first");
    expect(classifyRequired(false)).toBe("safe");
  });

  it("calls a delete Breaking, refused while in use (CAT-FR-12)", () => {
    expect(classifyDelete(0)).toBe("breaking");
    expect(classifyDelete(3)).toBe("refused");
  });

  it("calls adding inside a group Safe and inside a value Breaking (CAT-FR-19)", () => {
    expect(classifyAddInside(null, 0)).toBe("safe");
    expect(classifyAddInside(field("product", "json"), 5)).toBe("safe");
    expect(classifyAddInside(field("quantity", "number"), 0)).toBe("breaking");
    expect(classifyAddInside(field("quantity", "number"), 1)).toBe("refused");
  });
});

describe("examplePayload", () => {
  it("builds one event from the examples, nesting groups and typing values", () => {
    const payload = examplePayload([
      field("product", "json"),
      field("product.id", "string", '"SP-AD-0412"'),
      field("product.price", "number", "1290000"),
      field("quantity", "number", "1"),
      field("gift", "boolean", "true"),
      field("note", "string", null),
    ]);
    expect(JSON.parse(payload)).toEqual({ product: { id: "SP-AD-0412", price: 1290000 }, quantity: 1, gift: true });
  });

  it("keeps an unquoted text example as text", () => {
    expect(JSON.parse(examplePayload([field("voucher.code", "string", "ACME50K")]))).toEqual({ voucher: { code: "ACME50K" } });
  });
});
