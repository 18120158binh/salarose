import { type JourneyProblem, validateJourney } from "@/entities/journey/model/parseCampaign";
import { RUNTIME_REGISTRY } from "@/entities/journey/model/registry";
import { CART_ROOT, EVENTS } from "../__fixtures__/cart";
import { graphFromRoot } from "../builder";
import { buildChecklist } from "../checklist";

const graph = graphFromRoot(CART_ROOT)!;
const catalog = new Set(EVENTS.map((event) => event.name));
const eventName = (name: string | undefined) => (name ? (EVENTS.find((event) => event.name === name)?.label ?? name) : null);

const problem = (nodeId: string, severity: JourneyProblem["severity"], field: string, message: string): JourneyProblem => ({
  nodeId,
  severity,
  field,
  message,
  rule: "runtime",
  path: `root.${field}`,
});

describe("buildChecklist", () => {
  it("groups problems by step in canvas order, blocking first, and counts a never-matching condition as a warning", () => {
    const checklist = buildChecklist(
      [
        problem("start", "warning", "personFilters.groups[0]", "is INACTION, which the runtime never matches"),
        problem("start", "blocking", "filters.groups[0]", "must hold at least one condition"),
        problem("sms", "blocking", "action", "must not be empty"),
      ],
      graph,
      catalog,
      eventName,
    );
    expect(checklist.blocks).toBe(2);
    expect(checklist.warnings).toBe(1);
    expect(checklist.groups.map((group) => group.title)).toEqual(["Start: Added to cart", "SMS"]);
    expect(checklist.groups[0].items).toEqual([
      { severity: "blocking", field: "Filters", message: "Must hold at least one condition." },
      { severity: "warning", field: "Who can enter", message: "Is INACTION, which the runtime never matches." },
    ]);
  });

  it("blocks each step that names an event the catalog lacks", () => {
    const checklist = buildChecklist([], graph, new Set(["com.acme/add_to_cart"]), eventName);
    expect(checklist.blocks).toBe(1);
    expect(checklist.missingEvents).toEqual(["com.acme/order_completed"]);
    expect(checklist.knownEvents).toEqual(["Added to cart"]);
    expect(checklist.groups[0].nodeId).toBe("waitev");
  });
  it("warns, without blocking, on a Check step that tests an event 0 times (JBD-FR-44)", () => {
    const check = {
      type: "check", id: "bought", label: "Bought before?", eventName: "com.acme/order_completed",
      conditions: { groups: [{ conditions: [{
        type: "behavior", event: "com.acme/order_completed", measure: "COUNT", window: { value: 30, unit: "DAYS" }, op: "=", value: 0,
      }] }] },
      next: { type: "YesPath", yes: { type: "end" } },
    };
    const root = { ...CART_ROOT, next: { ...(CART_ROOT.next as object), next: { type: "SuccessOrTimeoutPath", success: check, timeout: { type: "end" } } } };
    const { problems } = validateJourney(root, RUNTIME_REGISTRY);
    const checklist = buildChecklist(problems, graphFromRoot(root)!, catalog, eventName);
    expect(checklist.blocks).toBe(0);
    expect(checklist.warnings).toBe(1);
    const group = checklist.groups.find((found) => found.nodeId === "bought")!;
    expect(group.items).toHaveLength(1);
    expect(group.items[0]).toMatchObject({ severity: "warning", field: "Conditions" });
    expect(group.items[0].message).toMatch(/Replace or remove it\.$/);
  });
});
