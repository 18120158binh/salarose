import { emptySegmentDraft, firstProblem, newBehaviorCondition, newProfileCondition, type SegmentDraft } from "../segmentDraft";

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
