import { defaultFiltersFor, isDefaultGroup, savedGroups, typedValue, valueText } from "@/entities/journey/model/eventCondition";

describe("defaultFiltersFor", () => {
  it("locks each catalog default value in a group of its own", () => {
    const filters = defaultFiltersFor({
      name: "view_product",
      fields: [
        { value: "product.category", defaultValue: "phones" },
        { value: "product.price" },
      ],
    });

    expect(filters).toEqual({
      groups: [
        { conditions: [{ type: "event_property", field: "product.category", op: "=", value: "phones", isDefault: true }] },
      ],
    });
    expect(isDefaultGroup(filters.groups[0])).toBe(true);
  });
});

describe("savedGroups", () => {
  it("drops the default flag and leaves out an empty list", () => {
    expect(savedGroups({
      groups: [{ conditions: [{ type: "event_property", field: "product.category", op: "=", value: "phones", isDefault: true }] }],
    })).toEqual({
      groups: [{ conditions: [{ type: "event_property", field: "product.category", op: "=", value: "phones" }] }],
    });
    expect(savedGroups({ groups: [] })).toBeUndefined();
    expect(savedGroups(undefined)).toBeUndefined();
  });
});

describe("typedValue", () => {
  it("saves IN as a JSON array, not a comma string", () => {
    expect(typedValue("IN", "Hanoi, Ho Chi Minh City, ", "string")).toEqual(["Hanoi", "Ho Chi Minh City"]);
  });

  it("saves a number field as a JSON number", () => {
    expect(typedValue(">", "500000", "number")).toBe(500000);
    expect(typedValue("IN", "1, 2", "number")).toEqual([1, 2]);
  });

  it("keeps a date and a text value as text", () => {
    expect(typedValue("<=", "2026-10-01", "datetime")).toBe("2026-10-01");
    expect(typedValue("=", "42", "string")).toBe("42");
  });

  it("shows a list as comma-separated text", () => {
    expect(valueText(["Hanoi", "Ho Chi Minh City"])).toBe("Hanoi, Ho Chi Minh City");
  });
});
