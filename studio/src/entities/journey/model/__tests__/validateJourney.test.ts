import { parseJourney, readOnlyNodeIds, validateJourney } from "@/entities/journey/model/parseCampaign";
import { RUNTIME_REGISTRY } from "@/entities/journey/model/registry";

const end = { type: "end" };
const setup = (next: unknown) => ({
  type: "setup", id: "setup", label: "Start", description: "", triggerEventName: "view_product", next,
});

// A watch with no event, above a check with an empty filter group, above a push with no channel.
// The watch's outcome is read before its event, so the walk reaches the problems below it first.
const threeProblems = setup({
  type: "watch", id: "wait_1", label: "Wait", timeLimitValue: 1, timeLimitUnit: "days",
  next: {
    type: "SuccessPath",
    success: {
      type: "check", id: "check_1", label: "Bought?", eventName: "purchase",
      filters: { groups: [{ conditions: [] }] },
      next: {
        type: "YesPath",
        yes: { type: "engagement", id: "push_1", label: "Push", action: { type: "" }, next: end },
      },
    },
  },
});

describe("validateJourney", () => {
  // JBD-FR-25
  it("lists every problem in tree order, each with its node and field", () => {
    expect(validateJourney(threeProblems)).toEqual({
      root: undefined,
      problems: [
        {
          severity: "blocking", rule: "shape", nodeId: "wait_1", field: "eventName",
          path: "root.next.eventName", message: "must name the trigger event of wait_1",
        },
        {
          severity: "blocking", rule: "shape", nodeId: "check_1", field: "filters.groups[0]",
          path: "root.next.next.success.filters.groups[0]", message: "must hold at least one condition",
        },
        {
          severity: "blocking", rule: "shape", nodeId: "push_1", field: "action.type",
          path: "root.next.next.success.next.yes.action.type", message: "must not be empty",
        },
      ],
    });
  });

  it("leaves the classic parse throwing the problem it reaches first", () => {
    expect(() => parseJourney(threeProblems)).toThrow(
      "Invalid journey: root.next.next.success.filters.groups[0] must hold at least one condition.",
    );
  });

  it("lists independent problems of one node in field order", () => {
    const check = {
      type: "check", id: "setup", eventName: " ",
      conditions: { groups: [{ conditions: [{ type: "profile_property", field: "", op: "~", value: "Hanoi" }] }] },
      next: { type: "YesPath", yes: end },
    };

    expect(validateJourney(setup(check)).problems.map(({ field, message }) => [field, message])).toEqual([
      ["id", "must be unique, but setup is already used"],
      ["label", "must be a string"],
      ["eventName", "must name the trigger event of setup"],
      ["conditions.groups[0].conditions[0].op", "must be one of >, >=, <, <=, =, !=, LIKE, IN"],
      ["conditions.groups[0].conditions[0].field", "must not be empty"],
    ]);
  });

  it("gives a part it cannot read to the node above it, and walks on", () => {
    const { problems } = validateJourney(setup([42, { type: "check", id: "check_1", label: "Bought?", next: { type: "YesPath", yes: end } }]));

    expect(problems.map(({ nodeId, field, message }) => [nodeId, field, message])).toEqual([
      ["setup", "next[0]", "must be an object"],
      ["check_1", "eventName", "must name the trigger event of check_1"],
    ]);
  });

  it("reports a tree that is too deep once, for the whole tree", () => {
    // Under the setup node, 200 pushes and an End node reach level 202.
    const chain = (branch: string) => {
      let next: unknown = end;
      for (let index = 200; index >= 1; index -= 1) {
        next = { type: "engagement", id: `${branch}_${index}`, label: "Push", action: { type: "push" }, next };
      }
      return next;
    };
    const twoDeepBranches = setup([chain("a"), chain("b")]);

    expect(validateJourney(twoDeepBranches).problems).toEqual([
      { severity: "blocking", rule: "shape", nodeId: undefined, field: "", path: "root", message: "nests nodes more than 200 levels deep" },
    ]);
  });

  it("gives back the tree when it has no problem", () => {
    const journey = setup({ type: "check", id: "check_1", label: "Bought?", eventName: "purchase", next: { type: "YesPath", yes: end } });

    expect(validateJourney(journey)).toEqual({ root: parseJourney(journey), problems: [] });
  });
});

// JBD-FR-31: a saved kind that the runtime does not run yet loads read-only and blocks publish.
describe("validateJourney with the runtime registry", () => {
  const businessSetup = { ...setup(end), triggerType: "business" };

  it("loads a setup that starts on a business event, read-only, with a blocking problem", () => {
    const { root, problems } = validateJourney(businessSetup, RUNTIME_REGISTRY);

    expect(root).toEqual(parseJourney(businessSetup));
    expect(problems).toEqual([
      {
        severity: "blocking", rule: "runtime", nodeId: "setup", field: "triggerType",
        path: "root.triggerType", message: "uses the trigger kind business_event, which the runtime does not run yet",
      },
    ]);
    expect(readOnlyNodeIds(problems)).toEqual(new Set(["setup"]));
  });

  it("flags a check on a business event the same way", () => {
    const check = { type: "check", id: "check_1", label: "Dropped?", eventType: "business", eventName: "price_drop", next: { type: "YesPath", yes: end } };

    const { root, problems } = validateJourney(setup(check), RUNTIME_REGISTRY);

    expect(root).toBeDefined();
    expect(problems.map(({ severity, rule, nodeId, field }) => [severity, rule, nodeId, field])).toEqual([
      ["blocking", "runtime", "check_1", "eventType"],
    ]);
    expect(readOnlyNodeIds(problems)).toEqual(new Set(["check_1"]));
  });

  it("leaves the classic parse, which reads no registry, accepting a business trigger", () => {
    expect(validateJourney(businessSetup)).toEqual({ root: parseJourney(businessSetup), problems: [] });
  });

  it("loads a saved INACTION condition with one warning, and keeps it editable", () => {
    const inaction = { type: "behavior", event: "purchase", measure: "INACTION", window: { value: 7, unit: "DAYS" }, op: "=", value: 0 };
    const check = {
      type: "check", id: "check_1", label: "Bought?", eventName: "view_product",
      conditions: { groups: [{ conditions: [inaction] }] }, next: { type: "YesPath", yes: end },
    };

    const { root, problems } = validateJourney(setup(check), RUNTIME_REGISTRY);

    expect(root).toBeDefined();
    expect(problems).toEqual([
      {
        severity: "warning", rule: "runtime", nodeId: "check_1", field: "conditions.groups[0].conditions[0].measure",
        path: "root.next.conditions.groups[0].conditions[0].measure", message: "is INACTION, which the runtime never matches",
      },
    ]);
    expect(readOnlyNodeIds(problems)).toEqual(new Set());
  });
  describe("a COUNT condition that must be 0 (JBD-FR-44)", () => {
    const checkWith = (op: string, value: number, measure = "COUNT") => setup({
      type: "check", id: "check_1", label: "Bought?", eventName: "view_product",
      conditions: { groups: [{ conditions: [
        { type: "behavior", event: "com.acme/order_completed", measure, window: { value: 30, unit: "DAYS" }, op, value },
      ] }] },
      next: { type: "YesPath", yes: end },
    });

    it.each([["=", 0], ["<=", 0], ["<", 1], ["<", 0]])("warns on %s %d and keeps the tree", (op, value) => {
      const { root, problems } = validateJourney(checkWith(op, value), RUNTIME_REGISTRY);
      expect(root).toBeDefined();
      expect(problems).toEqual([
        {
          severity: "warning", rule: "runtime", nodeId: "check_1", field: "conditions.groups[0].conditions[0]",
          path: "root.next.conditions.groups[0].conditions[0]",
          message: "\"did com.acme/order_completed 0 times in the last 30 days\" never matches, because a count is only kept for events that happen. Replace or remove it",
        },
      ]);
    });

    it.each([[">=", 1], ["=", 3], ["<", 2], ["!=", 0]])("does not warn on %s %d", (op, value) => {
      expect(validateJourney(checkWith(op, value), RUNTIME_REGISTRY).problems).toEqual([]);
    });

    it("does not warn for other measures, or without a registry", () => {
      expect(validateJourney(checkWith("<", 0, "SUM"), RUNTIME_REGISTRY).problems).toEqual([]);
      expect(validateJourney(checkWith("=", 0)).problems).toEqual([]);
    });
  });
});
