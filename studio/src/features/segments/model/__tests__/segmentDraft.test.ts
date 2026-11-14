import {
  emptySegmentDraft,
  firstProblem,
  newBehaviorCondition,
  newFilter,
  newProfileCondition,
  segmentDraft,
  segmentInput,
  type SegmentDraft,
} from "../segmentDraft";
import type { Segment } from "shared/lib/segments";

function draftWith(groups: SegmentDraft["groups"]): SegmentDraft {
  return { ...emptySegmentDraft(), name: "Hà Nội cart builders", groups };
}

describe("firstProblem (SEG-FR-43)", () => {
  it("names the group, the condition, and the missing number of times, and marks the threshold", () => {
    const city = { ...newProfileCondition(), value: "Hà Nội" };
    const cart = { ...newBehaviorCondition("com.acme/add_to_cart"), value: "" };

    expect(firstProblem(draftWith([[city], [cart]]))).toEqual({
      group: 1,
      condition: 0,
      field: "threshold",
      message: "Group 2, condition 1 needs a number of times. Fill it in, or remove the condition. Nothing you typed was lost.",
    });
  });

  it("asks for a field to measure when the measure reads one", () => {
    const total = { ...newBehaviorCondition("com.acme/order_completed"), measure: "SUM" as const };

    expect(firstProblem(draftWith([[total]]))).toMatchObject({ group: 0, condition: 0, field: "attribute" });
  });

  it("asks for a name first", () => {
    expect(firstProblem({ ...draftWith([[newProfileCondition()]]), name: " " })).toMatchObject({ field: "name", group: null });
  });

  it("passes a complete segment", () => {
    expect(firstProblem(draftWith([[{ ...newProfileCondition(), value: "Hà Nội" }], [newBehaviorCondition("com.acme/add_to_cart")]]))).toBeNull();
  });
});

describe("event filters (SEG-FR-11)", () => {
  const cart = newBehaviorCondition("com.acme/add_to_cart");

  it("names the group, the condition, and the filter that needs a value", () => {
    const filtered = { ...cart, filters: [{ field: "product.price", op: ">" as const, value: " " }] };

    expect(firstProblem(draftWith([[filtered]]))).toEqual({
      group: 0,
      condition: 0,
      field: "filter-value",
      filter: 0,
      message: "Group 1, condition 1, filter 1 needs a value. Fill it in, or remove the filter. Nothing you typed was lost.",
    });
  });

  it("asks for a field before a value", () => {
    expect(firstProblem(draftWith([[{ ...cart, filters: [newFilter()] }]]))).toMatchObject({ field: "filter-field", filter: 0 });
  });

  it("saves each filter as its own group, so every filter must pass", () => {
    const filtered = {
      ...cart,
      filters: [
        { field: "product.price", op: ">" as const, value: "500000" },
        { field: "product.category", op: "IN" as const, value: "Shoes, Bags" },
      ],
    };

    const saved = segmentInput(draftWith([[filtered]])).conditions.groups[0].conditions[0];

    expect(saved).toMatchObject({
      filters: {
        groups: [
          { conditions: [{ type: "event_property", field: "product.price", op: ">", value: 500000 }] },
          { conditions: [{ type: "event_property", field: "product.category", op: "IN", value: ["Shoes", "Bags"] }] },
        ],
      },
    });
  });

  it("saves no filters key for a condition without filters", () => {
    expect(segmentInput(draftWith([[cart]])).conditions.groups[0].conditions[0]).not.toHaveProperty("filters");
  });

  function stored(filters: NonNullable<Extract<Segment["conditions"]["groups"][number]["conditions"][number], { type: "behavior" }>["filters"]>): Segment {
    return {
      id: "SEG-4f1c9a0b2d3e5f67",
      name: "Big carts",
      description: "",
      conditions: { groups: [{ conditions: [{
        type: "behavior", event: "com.acme/add_to_cart", measure: "COUNT", filters,
        window: { value: 7, unit: "DAYS" }, op: ">=", value: 1,
      }] }] },
    } as Segment;
  }

  it("round-trips stored filters it can show", () => {
    const filters = { groups: [{ conditions: [{ type: "event_property" as const, field: "product.price", op: ">" as const, value: 500000 }] }] };

    const draft = segmentDraft(stored(filters));

    expect(draft.groups[0][0]).toMatchObject({ filters: [{ field: "product.price", op: ">", value: "500000" }] });
    expect(segmentInput(draft).conditions.groups[0].conditions[0]).toMatchObject({ filters });
  });

  it("keeps stored filters with an OR inside a group as they are", () => {
    const filters = { groups: [{ conditions: [
      { type: "event_property" as const, field: "product.category", op: "=" as const, value: "Shoes" },
      { type: "event_property" as const, field: "product.category", op: "=" as const, value: "Bags" },
    ] }] };

    const draft = segmentDraft(stored(filters));

    expect(draft.groups[0][0]).toMatchObject({ filters: [], keptFilters: filters });
    expect(segmentInput(draft).conditions.groups[0].conditions[0]).toMatchObject({ filters });
  });
});
