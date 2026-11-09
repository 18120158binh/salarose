import { CHANNELS } from "@/entities/journey/model/types";
import { parseGeneratedJourney, SYSTEM_PROMPT } from "../generatedJourney";

// The model can only use what the system prompt shows it, so the prompt must describe every node
// type, path type, channel, and unit that the generated journey check accepts.
describe("the system prompt", () => {
  it.each(["setup", "check", "watch", "segment", "engagement", "end"])("describes the %s node", (type) => {
    expect(SYSTEM_PROMPT).toContain(`type: "${type}"`);
  });

  it.each([
    "YesPath",
    "NoPath",
    "YesOrNoPath",
    "MultiBranchPath",
    "SuccessPath",
    "TimeoutPath",
    "SuccessOrTimeoutPath",
    "DelayPath",
  ])("describes the %s path", (type) => {
    expect(SYSTEM_PROMPT).toContain(`"${type}"`);
  });

  it.each(CHANNELS)("offers the %s channel", (channel) => {
    expect(SYSTEM_PROMPT).toContain(`"${channel}"`);
  });

  it.each(["SECONDS", "MINUTES", "HOURS", "DAYS", "WEEKS", "MONTHS"])("offers the %s metric window unit", (unit) => {
    expect(SYSTEM_PROMPT).toContain(`"${unit}"`);
  });

  it("writes IN as a JSON array", () => {
    expect(SYSTEM_PROMPT).toContain('"IN": value là mảng JSON');
  });

  it("offers product.name as an event field", () => {
    expect(SYSTEM_PROMPT).toContain('"product.name"');
  });

  it("gives a segment only a Yes path, since a segment never takes No", () => {
    const segment = /interface SegmentNode \{[\s\S]*?\n\}/.exec(SYSTEM_PROMPT)?.[0];
    expect(segment).toContain('"YesPath"');
    expect(segment).not.toMatch(/NoPath|YesOrNoPath|no:/);
  });

  it("writes contains as a LIKE pattern wrapped in %", () => {
    expect(SYSTEM_PROMPT).toMatch(/LIKE[^\n]*%[^\n%]+%/);
  });
});

// "Of the viewers who bought at least twice in 30 days, send iPhone viewers a Zalo message and
// tell the CRM about the rest a day later", written the way the prompt describes.
const promptShapedJourney = {
  type: "setup",
  id: "setup-ai",
  label: "Start",
  description: "Viewers",
  triggerEventName: "view_item",
  next: {
    type: "segment",
    id: "segment-1",
    label: "Bought twice",
    conditions: {
      groups: [{
        conditions: [{ type: "behavior", event: "purchase", measure: "COUNT", window: { value: 30, unit: "DAYS" }, op: ">=", value: 2 }],
      }],
    },
    next: {
      type: "YesPath",
      yes: {
        type: "check",
        id: "check-1",
        label: "Which product?",
        eventName: "view_item",
        next: {
          type: "MultiBranchPath",
          branches: [
            {
              branchKey: "branch_0",
              priority: 0,
              filters: { groups: [{ conditions: [{ type: "event_property", field: "product.name", op: "LIKE", value: "%iphone%" }] }] },
              next: {
                type: "engagement",
                id: "zalo-1",
                label: "Zalo",
                action: { type: "zalo", templateId: "ZNS_PROMO", body: "New iPhone deals" },
                next: { type: "end" },
              },
            },
            {
              branchKey: "branch_1",
              priority: 1,
              next: {
                type: "watch",
                id: "delay-1",
                label: "Wait 1 day",
                timeLimitValue: 1,
                timeLimitUnit: "days",
                next: {
                  type: "DelayPath",
                  next: {
                    type: "engagement",
                    id: "webhook-1",
                    label: "Notify CRM",
                    action: { type: "webhook", url: "https://crm.example.com/hook", payload: "{\"event\":\"viewed\"}" },
                    next: { type: "end" },
                  },
                },
              },
            },
          ],
        },
      },
    },
  },
};

it("accepts a journey written the way the prompt describes", () => {
  expect(parseGeneratedJourney(JSON.stringify(promptShapedJourney))).toMatchObject({ type: "setup", id: "setup-ai" });
});
