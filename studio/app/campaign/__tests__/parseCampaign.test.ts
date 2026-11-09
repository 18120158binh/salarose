import { graphToTree } from "@/entities/journey/model/utils";
import { parseCampaignForPublish, parseJourney } from "@/entities/journey/model/parseCampaign";
import { CampaignConnection, CampaignNode, EngagementNode, SetupNode } from "@/entities/journey/model/types";

const node = (id: string, type: CampaignNode["type"], config: Record<string, unknown> = {}, subType?: string): CampaignNode => ({
  id,
  type,
  subType: subType ?? (type === "end" ? "custom-list" : type),
  label: id,
  config,
  position: { x: 0, y: 0 },
} as CampaignNode);

const edge = (from: string, to: string, type = "required"): CampaignConnection => ({ from, to, type });
const groups = (...conditions: unknown[]) => ({ groups: conditions.map((condition) => ({ conditions: [condition] })) });
const addedTwice = { type: "behavior", event: "add_to_cart", measure: "COUNT", window: { value: 7, unit: "DAYS" }, op: ">=", value: 2 };

// One of each node type and outcome, saved the way the builder saves a journey.
const journey = graphToTree(
  [
    node("setup-node", "setup", {
      triggerEventName: "add_to_cart",
      filters: groups({ type: "event_property", field: "product.category", op: "=", value: "phones", isDefault: true }),
    }),
    node("check-1", "check", {
      checkType: "MultiBranchPath",
      eventName: "view_item",
      conditions: groups({ type: "profile_property", field: "city", op: "IN", value: ["Hanoi"] }, addedTwice),
      branches: [
        { branchKey: "branch_0", priority: 0, label: "Viewed", filters: groups({ type: "event_property", field: "product.price", op: ">", value: 10 }) },
        { branchKey: "else", priority: 1, label: "Else" },
      ],
    }),
    node("segment-1", "segment", { conditions: groups({ ...addedTwice, value: 3 }), checkType: "YesPath" }),
    node("watch-1", "watch", { watchType: "SuccessOrTimeoutPath", eventName: "purchase", timeLimitValue: 2, timeLimitUnit: "hours" }),
    node("delay-1", "watch", { watchType: "DelayPath", timeLimitValue: 30, timeLimitUnit: "minutes" }),
    node("email-1", "engagement", { subject: "Still there?", body: "Your cart", payload: { coupon: "SAVE10" } }, "email"),
    node("sms-1", "engagement", { body: "Come back" }, "sms"),
  ],
  [
    edge("setup-node", "check-1"),
    edge("check-1", "segment-1", "branch_0"),
    edge("check-1", "delay-1", "else"),
    edge("segment-1", "watch-1"),
    edge("watch-1", "email-1", "required"),
    edge("watch-1", "sms-1", "undefined"),
  ],
);

describe("parseCampaignForPublish", () => {
  it("keeps every part of a journey the builder saves", () => {
    const campaign = { id: "CAMP-1234", name: "Cart recovery", description: "", status: "draft", root: journey };

    // A round trip through JSON, as the server action receives it.
    const sent = JSON.parse(JSON.stringify(campaign));

    expect(JSON.parse(JSON.stringify(parseCampaignForPublish(sent)))).toEqual({
      id: "CAMP-1234",
      name: "Cart recovery",
      description: "",
      root: sent.root,
    });
  });

  it("names the place of a node with an unknown type", () => {
    const root = { ...journey, next: { type: "jump", id: "x" } };

    expect(() => parseCampaignForPublish({ id: "CAMP-1234", name: "Cart recovery", root })).toThrow(
      "Invalid journey: root.next.type must be setup, check, watch, segment, engagement, or end.",
    );
  });

  it("rejects a campaign without an id", () => {
    expect(() => parseCampaignForPublish({ id: " ", name: "Cart recovery", root: journey })).toThrow(
      "Invalid journey: campaign.id must not be empty.",
    );
  });
});

describe("parseCampaignForPublish structure", () => {
  const publish = (root: unknown) => () => parseCampaignForPublish({ id: "CAMP-1234", name: "Cart recovery", root });
  const end = { type: "end" };
  const email = (id: string, next: unknown = end) => ({
    type: "engagement",
    id,
    label: "Email",
    action: { type: "email", subject: "Hello" },
    next,
  });
  const setup = (next: unknown, id = "setup-1") => ({
    type: "setup",
    id,
    label: "Trigger",
    description: "",
    triggerEventName: "add_to_cart",
    next,
  });
  const multiBranchCheck = (branches: unknown[]) => ({
    type: "check",
    id: "check-1",
    label: "Which cart?",
    eventName: "purchase",
    next: { type: "MultiBranchPath", branches },
  });
  const branch = (branchKey: string, priority: number) => ({ branchKey, priority, next: end });

  it.each([
    ["an End node", end],
    ["a check node", { type: "check", id: "check-1", label: "Bought?", eventName: "purchase", next: { type: "YesPath", yes: end } }],
  ])("rejects a root that is %s", (_, root) => {
    expect(publish(root)).toThrow("Invalid journey: root.type must be setup.");
  });

  it("rejects a setup node below the root", () => {
    expect(publish(setup(setup(end, "setup-2")))).toThrow("Invalid journey: root.next must not be a setup node.");
  });

  it("rejects two nodes with the same id", () => {
    expect(publish(setup([email("email-1"), email("email-1")]))).toThrow(
      "Invalid journey: root.next[1].id must be unique, but email-1 is already used.",
    );
  });

  it("rejects two branches of one check with the same key", () => {
    expect(publish(setup(multiBranchCheck([branch("vip", 0), branch("vip", 1)])))).toThrow(
      "Invalid journey: root.next.next.branches[1].branchKey must be unique in its check, but vip is already used.",
    );
  });

  it.each([
    ["yes", "must not be next, yes, no, success, or timeout"],
    ["timeout", "must not be next, yes, no, success, or timeout"],
    ["vip-0", "must contain only letters, digits, and underscores"],
  ])("rejects the branch key %s", (key, problem) => {
    expect(publish(setup(multiBranchCheck([branch(key, 0), branch("regular", 1)])))).toThrow(
      `Invalid journey: root.next.next.branches[0].branchKey ${problem}.`,
    );
  });

  // A condition split has no trigger and fires yes when its conditions hold.
  const segment = (fields: Record<string, unknown>) => ({
    type: "segment",
    id: "segment-1",
    label: "Buyers",
    conditions: groups({ type: "behavior", event: "purchase", measure: "COUNT", window: { value: 30, unit: "DAYS" }, op: ">=", value: 2 }),
    next: { type: "YesPath", yes: end },
    ...fields,
  });

  // JBD-FR-03
  it.each([
    ["no conditions", undefined],
    ["only a profile condition", groups({ type: "profile_property", field: "city", op: "=", value: "Hanoi" })],
  ])("rejects a condition split with %s, naming its place", (_, conditions) => {
    expect(publish(setup(segment({ conditions })))).toThrow(
      "Invalid journey: root.next.conditions must hold a behavior condition for the condition split segment-1.",
    );
  });

  // JBD-FR-05
  it.each([
    ["a check", { type: "check", id: "check-1", label: "Bought?", next: { type: "YesPath", yes: end } }, "eventName"],
    ["a watch", {
      type: "watch", id: "check-1", label: "Wait", timeLimitValue: 1, timeLimitUnit: "days",
      next: { type: "SuccessPath", success: end },
    }, "eventName"],
  ])("rejects %s without a trigger event, naming the node", (_, child, key) => {
    expect(publish(setup(child))).toThrow(`Invalid journey: root.next.${key} must name the trigger event of check-1.`);
  });

  it("rejects a setup node without a trigger event", () => {
    expect(publish({ ...setup(end), triggerEventName: "" })).toThrow(
      "Invalid journey: root.triggerEventName must name the trigger event of setup-1.",
    );
  });

  // JBD-FR-13
  it("rejects an empty condition group, naming the node's place", () => {
    const check = {
      type: "check", id: "check-1", label: "Bought?", eventName: "purchase",
      conditions: { groups: [{ conditions: [] }] },
      next: { type: "YesPath", yes: end },
    };

    expect(publish(setup(check))).toThrow("Invalid journey: root.next.conditions.groups[0] must hold at least one condition.");
  });

  it("rejects an IN value that is not a list", () => {
    const check = {
      type: "check", id: "check-1", label: "City?", eventName: "purchase",
      conditions: groups({ type: "profile_property", field: "city", op: "IN", value: "Hanoi,Da Nang" }),
      next: { type: "YesPath", yes: end },
    };

    expect(publish(setup(check))).toThrow(
      "Invalid journey: root.next.conditions.groups[0].conditions[0].value must be a list of at least one string or number for IN.",
    );
  });

  it("rejects a segment with a multi-branch path", () => {
    expect(publish(setup(segment({ next: { type: "MultiBranchPath", branches: [branch("vip", 0)] } })))).toThrow(
      "Invalid journey: root.next.next.type must be YesPath, NoPath, or YesOrNoPath.",
    );
  });

  it("rejects a multi-branch check with no branches", () => {
    expect(publish(setup(multiBranchCheck([])))).toThrow("Invalid journey: root.next.next.branches must not be empty.");
  });

  it.each([0, -5])("rejects a watch with a time limit of %d", (timeLimitValue) => {
    const watch = {
      type: "watch",
      id: "delay-1",
      label: "Wait",
      timeLimitValue,
      timeLimitUnit: "minutes",
      next: { type: "DelayPath", next: end },
    };

    expect(publish(setup(watch))).toThrow("Invalid journey: root.next.timeLimitValue must be greater than 0.");
  });

  // A check whose behavior condition is "add to cart at least 3 times in 7 days", with one part replaced.
  const behaviorCheck = (change: Record<string, unknown>) => ({
    type: "check",
    id: "check-1",
    label: "Carted?",
    eventName: "purchase",
    conditions: groups({
      type: "behavior", event: "add_to_cart", measure: "COUNT", window: { value: 7, unit: "DAYS" }, op: ">=", value: 3,
      ...change,
    }),
    next: { type: "YesPath", yes: end },
  });
  const behaviorRule = "Invalid journey: root.next.conditions.groups[0].conditions[0]";

  it.each(["3", "three", null, Infinity])("rejects the behavior value %p", (value) => {
    expect(publish(setup(behaviorCheck({ value })))).toThrow(`${behaviorRule}.value must be a number.`);
  });

  it.each(["LIKE", "IN", "==", "==="])("rejects the behavior operator %s", (op) => {
    expect(publish(setup(behaviorCheck({ op })))).toThrow(`${behaviorRule}.op must be one of >, >=, <, <=, =, !=.`);
  });

  it.each([0, -7])("rejects a behavior window of %d", (value) => {
    expect(publish(setup(behaviorCheck({ window: { value, unit: "DAYS" } })))).toThrow(
      `${behaviorRule}.window.value must be greater than 0.`,
    );
  });

  it.each(["FORTNIGHTS", "D", "weeks", undefined])("rejects the behavior window unit %p", (unit) => {
    expect(publish(setup(behaviorCheck({ window: { value: 2, unit } })))).toThrow(
      `${behaviorRule}.window.unit must be one of SECONDS, MINUTES, HOURS, DAYS, WEEKS, MONTHS.`,
    );
  });

  // JBD-FR-14: a behavior condition states its window.
  it("rejects a behavior condition with no window", () => {
    expect(publish(setup(behaviorCheck({ window: undefined })))).toThrow(`${behaviorRule}.window must be an object.`);
  });

  it.each(["SECONDS", "MINUTES", "HOURS", "DAYS", "WEEKS", "MONTHS"])("accepts the behavior window unit %s", (unit) => {
    expect(publish(setup(behaviorCheck({ window: { value: 2, unit } })))).not.toThrow();
  });

  it.each([
    ["a decimal value", { value: 2.5 }],
    ["a negative value", { op: "<", value: -1 }],
    ["an attribute and a metric id", { measure: "SUM", attribute: "product.price", metric_id: "m_add_to_cart_sum_price" }],
  ])("accepts a behavior condition with %s", (_, change) => {
    expect(publish(setup(behaviorCheck(change)))).not.toThrow();
  });

  it.each([
    ["the event filters", "filters", { type: "event_property", field: "page.url", op: "CONTAINS", value: "sale" }],
    ["the conditions", "conditions", { type: "profile_property", field: "city", op: "~", value: "Ha" }],
  ])("rejects an operator the decision job does not know in %s", (_, key, condition) => {
    const check = { type: "check", id: "check-1", label: "Sale?", eventName: "purchase", [key]: groups(condition), next: { type: "YesPath", yes: end } };

    expect(publish(setup(check))).toThrow(
      `Invalid journey: root.next.${key}.groups[0].conditions[0].op must be one of >, >=, <, <=, =, !=, LIKE, IN.`,
    );
  });

  // A "contains" with no text saves LIKE %%, which matches every value. A pattern of only %
  // matches every value however it was written: by the editor, by an older build, or by the AI route.
  // JBD-FR-03
  it.each(["%%", "%", "%%%"])("rejects the LIKE pattern %p, which matches every value", (value) => {
    const check = {
      type: "check", id: "check-1", label: "Sale?", eventName: "purchase",
      filters: groups({ type: "event_property", field: "product.name", op: "LIKE", value }),
      next: { type: "YesPath", yes: end },
    };

    expect(publish(setup(check))).toThrow(
      "Invalid journey: root.next.filters.groups[0].conditions[0].value must have text to match, not only %.",
    );
  });

  it("rejects a condition of an unknown type", () => {
    const check = {
      type: "check", id: "check-1", label: "Sale?", eventName: "purchase",
      conditions: groups({ type: "comparison", left: "city", op: "=", right: "Hanoi" }),
      next: { type: "YesPath", yes: end },
    };

    expect(publish(setup(check))).toThrow(
      'Invalid journey: root.next.conditions.groups[0].conditions[0].type must be "profile_property" or "behavior".',
    );
  });

  // setup -> email-1 -> ... -> email-(n-2) -> end is n levels deep.
  const chain = (levels: number) => {
    let next: unknown = end;
    for (let index = levels - 2; index >= 1; index -= 1) next = email(`email-${index}`, next);
    return setup(next);
  };

  it("accepts a journey 200 levels deep", () => {
    expect(publish(chain(200))).not.toThrow();
  });

  it.each([201, 20000])("rejects a journey %d levels deep with a clear error", (levels) => {
    expect(publish(chain(levels))).toThrow("Invalid journey: root nests nodes more than 200 levels deep.");
  });

  // Older builds saved a fixed phone on SMS and WhatsApp steps. The builder no longer has the
  // field, so a stored journey that carries one must still load, without it.
  it.each(["0912345678", 912345678, null])("loads an engagement with the old phone %p and drops it", (phone) => {
    const sms = { type: "engagement", id: "sms-1", label: "SMS", action: { type: "sms", body: "Come back", phone }, next: end };

    const parsed = parseCampaignForPublish({ id: "CAMP-1234", name: "Cart recovery", root: setup(sms) });

    expect(((parsed.root as SetupNode).next as EngagementNode).action).toEqual({ type: "sms", body: "Come back" });
  });
});

// Older trees can carry setup, check, and watch fields that no editor shows and the runtime never
// reads. They still parse, and the journey keeps only what the builder saves.
describe("parseJourney fields no editor shows", () => {
  const stored = (branch: Record<string, unknown>) => ({
    type: "setup", id: "setup", label: "Start", description: "", triggerEventName: "view_product",
    catalogName: "products", field: "price", operator: ">", value: "10", targetSegmentId: "seg_1", fanOutInteractionTypes: "view",
    next: {
      type: "check", id: "multi", label: "Multi", eventName: "purchase", catalogName: "products",
      next: { type: "MultiBranchPath", branches: [{ branchKey: "vip", priority: 0, next: { type: "end" }, ...branch }] },
    },
  });

  it("drops them from a stored tree", () => {
    const json = JSON.stringify(parseJourney(stored({})));

    for (const field of ["catalogName", "targetSegmentId", "fanOutInteractionTypes", "\"operator\"", "\"field\""]) {
      expect(json).not.toContain(field);
    }
  });
});
