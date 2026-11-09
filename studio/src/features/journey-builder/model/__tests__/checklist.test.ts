import type { JourneyProblem } from "@/entities/journey/model/parseCampaign";
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
});
