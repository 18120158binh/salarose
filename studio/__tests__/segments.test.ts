/** @jest-environment node */

import { newSegmentId, parseSegmentId, parseSegmentInput, parseUsingCampaignStatus, segmentUsesOfNodeRow } from "shared/lib/segments";
import { UserFacingError } from "shared/lib/userFacingError";

const hanoiCartBuilders = {
  name: "Hanoi cart builders",
  description: "Hanoi shoppers who keep adding to cart",
  conditions: {
    groups: [
      { conditions: [{ type: "profile_property", field: "city", op: "IN", value: ["Hanoi"] }] },
      {
        conditions: [{
          type: "behavior", event: "add_to_cart", measure: "COUNT",
          window: { value: 7, unit: "DAYS" }, op: ">=", value: 3,
        }],
      },
    ],
  },
};

function refusal(input: unknown): string {
  try {
    parseSegmentInput(input);
  } catch (error) {
    if (error instanceof UserFacingError) return error.message;
    throw error;
  }
  throw new Error("the segment was accepted");
}

describe("parseSegmentInput", () => {
  it("accepts the segment of the contract's behavior, with its two groups", () => {
    const segment = parseSegmentInput(hanoiCartBuilders);

    expect(segment.name).toBe("Hanoi cart builders");
    expect(segment.conditions.groups).toHaveLength(2);
    expect(segment.conditions.groups[1].conditions[0]).toMatchObject({ type: "behavior", event: "add_to_cart", value: 3 });
  });

  it("refuses a segment_membership condition and names its group and condition", () => {
    const input = structuredClone(hanoiCartBuilders);
    input.conditions.groups[1].conditions.push({ type: "segment_membership", segment_id: "SEG-0123456789abcdef", op: "in" } as never);

    expect(refusal(input)).toBe("Group 2, condition 2: a segment cannot contain a segment_membership condition.");
  });

  it("refuses an empty group and names it", () => {
    const input = structuredClone(hanoiCartBuilders);
    input.conditions.groups.push({ conditions: [] });

    expect(refusal(input)).toBe("Group 3: a group must hold at least one condition.");
  });

  it("refuses a segment with no group", () => {
    expect(refusal({ ...hanoiCartBuilders, conditions: { groups: [] } })).toBe("A segment needs at least one group of conditions.");
  });

  it("refuses a measure that reads an attribute without one, and a window of 0", () => {
    const sum = structuredClone(hanoiCartBuilders);
    Object.assign(sum.conditions.groups[1].conditions[0], { measure: "SUM" });
    const zeroWindow = structuredClone(hanoiCartBuilders);
    Object.assign(zeroWindow.conditions.groups[1].conditions[0], { window: { value: 0, unit: "DAYS" } });

    expect(refusal(sum)).toBe("Group 2, condition 1: SUM needs an attribute.");
    expect(refusal(zeroWindow)).toMatch(/^Group 2, condition 1: the window must be a number above 0/);
  });

  it("refuses a segment with no name", () => {
    expect(refusal({ ...hanoiCartBuilders, name: "  " })).toBe("A segment needs a name.");
  });
});

describe("segment ids", () => {
  it("makes SEG- and 16 hexadecimal digits, which parse back", () => {
    const id = newSegmentId();

    expect(id).toMatch(/^SEG-[0-9a-f]{16}$/);
    expect(parseSegmentId(id)).toBe(id);
    expect(() => parseSegmentId("SEG-12")).toThrow(UserFacingError);
  });
});

describe("segmentUsesOfNodeRow", () => {
  it("finds an entry trigger, a segment audience, and a segment_membership condition, each with its kind", () => {
    const trigger = JSON.stringify({ kind: "segment_entry", segment_id: "SEG-000000000000000a", reentry: { mode: "never" } });
    const audience = JSON.stringify({
      kind: "business_event", event: "back_in_stock", audience: { type: "segment", segment_id: "SEG-000000000000000b" },
    });
    const conditions = JSON.stringify({
      groups: [{ conditions: [{ type: "segment_membership", segment_id: "SEG-000000000000000c", op: "not_in" }] }],
    });

    expect(segmentUsesOfNodeRow([trigger, audience, conditions, null, "not json"])).toEqual(new Map([
      ["SEG-000000000000000a", new Set(["entry_trigger"])],
      ["SEG-000000000000000b", new Set(["event_audience"])],
      ["SEG-000000000000000c", new Set(["condition"])],
    ]));
  });

  it("finds nothing in a node that names no segment", () => {
    expect(segmentUsesOfNodeRow([JSON.stringify({ type: "comparison", left: "event.name", op: "=", right: "purchase" })]).size).toBe(0);
  });
});

describe("parseUsingCampaignStatus", () => {
  it("accepts the statuses that use a segment and refuses every other", () => {
    expect(parseUsingCampaignStatus("active")).toBe("active");
    expect(parseUsingCampaignStatus("paused")).toBe("paused");
    expect(parseUsingCampaignStatus("draft")).toBeNull();
    expect(parseUsingCampaignStatus(undefined)).toBeNull();
  });
});
