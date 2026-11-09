import { editorOperator, editorValue, getConditionSummary, savedComparison } from "@/entities/journey/model/conditionConfig";
import type { PersonConditions } from "@/entities/journey/model/types";

describe("getConditionSummary", () => {
  it("joins groups with & and the conditions of a group with |", () => {
    expect(
      getConditionSummary(
        {
          groups: [
            { conditions: [{ type: "event_property", field: "product.category", op: "=", value: "phones", isDefault: true }] },
            {
              conditions: [
                { type: "event_property", field: "product.price", op: ">", value: 500000 },
                { type: "event_property", field: "product.brand", op: "=", value: "acme" },
              ],
            },
            { conditions: [{ type: "event_property", field: "product.color", op: "IN", value: ["red", "blue"] }] },
          ],
        },
        999,
      ),
    ).toBe("(price is more than 500000 | brand equals acme) & color is one of red, blue");
  });

  it("names a behavior condition by its event, measure, and threshold", () => {
    const conditions: PersonConditions = {
      groups: [{
        conditions: [{ type: "behavior", event: "purchase", measure: "COUNT", window: { value: 30, unit: "DAYS" }, op: ">=", value: 2 }],
      }],
    };
    expect(getConditionSummary(conditions, 999)).toBe("purchase COUNT at least 2");
  });
});

describe("contains", () => {
  it("saves a contains as LIKE between two %", () => {
    expect(savedComparison("CONTAINS", "iphone")).toEqual({ op: "LIKE", text: "%iphone%" });
  });

  it("shows a LIKE between two % as contains with its text", () => {
    const row = { op: "LIKE" as const, value: "%iphone%" };
    expect([editorOperator(row), editorValue(row)]).toEqual(["CONTAINS", "iphone"]);
  });

  it("shows an older LIKE without the surrounding % as an exact match", () => {
    const row = { op: "LIKE" as const, value: "iphone" };
    expect([editorOperator(row), editorValue(row)]).toEqual(["LIKE", "iphone"]);
  });
});
