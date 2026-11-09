import { validateJourney } from "@/entities/journey/model/parseCampaign";
import { RUNTIME_REGISTRY } from "@/entities/journey/model/registry";
import { blankRoot, prefilledMapping, templateByKey, templateRoot, TEMPLATES } from "../templates";

type Node = Record<string, unknown>;

function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (typeof value !== "object" || value === null) return [];
  const node = value as Node;
  return [node, ...Object.values(node).flatMap(nodes)];
}

const messages = (root: unknown) => nodes(root).filter((node) => node.type === "engagement");
const VIETNAMESE = /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i;

describe("built-in templates (JBD-FR-30)", () => {
  it.each(TEMPLATES.map((template) => [template.name, template]))("%s passes publish validation with its events mapped", (_, template) => {
    const mapped = templateRoot(template, prefilledMapping(template, template.needs.map((need) => need.name)));
    const { root, problems } = validateJourney(mapped, RUNTIME_REGISTRY);

    expect(problems.filter((problem) => problem.severity === "blocking")).toEqual([]);
    expect(root).toBeDefined();
  });

  it.each(TEMPLATES.map((template) => [template.name, template]))("%s sends only SMS or push, in Vietnamese", (_, template) => {
    const steps = messages(template.root);

    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      const action = step.action as { type: string; title?: string; body?: string };
      expect(["sms", "push"]).toContain(action.type);
      expect(`${action.title ?? ""} ${action.body ?? ""}`).toMatch(VIETNAMESE);
    }
  });

  it("names every event by its catalog system name", () => {
    for (const template of TEMPLATES) {
      for (const need of template.needs) expect(need.name).toMatch(/^com\.acme\/[a-z_]+$/);
    }
  });

  it("waits 2 hours for an order in Abandoned cart, then pushes, waits a day, and sends an SMS", () => {
    const cart = templateByKey("cart")!;
    const root = cart.root as Node;
    const watch = root.next as Node;
    const paths = watch.next as Node;
    const pushStep = paths.timeout as Node;
    const wait = pushStep.next as Node;
    const smsStep = (wait.next as Node).next as Node;

    expect(root.triggerEventName).toBe("com.acme/add_to_cart");
    expect(watch).toMatchObject({ type: "watch", eventName: "com.acme/order_completed", timeLimitValue: 2, timeLimitUnit: "hours" });
    expect(paths).toMatchObject({ type: "SuccessOrTimeoutPath", success: { type: "end" } });
    expect(pushStep).toMatchObject({ type: "engagement", action: { type: "push", title: "Bạn quên giỏ hàng?" } });
    expect(wait).toMatchObject({ type: "watch", timeLimitValue: 1, timeLimitUnit: "days", next: { type: "DelayPath" } });
    expect(smsStep).toMatchObject({ type: "engagement", action: { type: "sms" }, next: { type: "end" } });
    expect(cart.needs.map((need) => need.label).join(", ")).toBe("Added to cart, Order completed");
  });
});

describe("event mapping (JBD-FR-29)", () => {
  const cart = templateByKey("cart")!;

  it("prefills only the events the catalog has", () => {
    expect(prefilledMapping(cart, ["com.acme/add_to_cart", "purchase"])).toEqual({ "com.acme/add_to_cart": "com.acme/add_to_cart" });
  });

  it("puts the picked catalog events into the tree and keeps an unmapped event's own name", () => {
    const root = templateRoot(cart, { "com.acme/add_to_cart": "shop/cart_add" });
    const events = nodes(root).flatMap((node) => [node.triggerEventName, node.eventName].filter((name) => typeof name === "string"));

    expect(events).toEqual(["shop/cart_add", "com.acme/order_completed"]);
    expect((cart.root as Node).triggerEventName).toBe("com.acme/add_to_cart");
  });

  it("maps the event of a behavior condition too", () => {
    const winback = templateByKey("winback")!;
    const root = templateRoot(winback, { "com.acme/order_completed": "purchase" });

    expect(JSON.stringify(root)).not.toContain("com.acme/order_completed");
  });
});

describe("Start blank", () => {
  it("is one setup node", () => {
    expect(blankRoot()).toMatchObject({ type: "setup", next: [] });
  });
});
