import type { CatalogAttribute, CatalogEvent } from "@/features/data-health/model/catalog";

// The three events the guide starts a website with (CAT-FR-02 names: com.acme/<name>).
export const SAMPLE_EVENTS = [
  { key: "product_viewed", label: "Product viewed" },
  { key: "add_to_cart", label: "Added to cart" },
  { key: "order_completed", label: "Order completed" },
] as const;

export type SampleKey = (typeof SAMPLE_EVENTS)[number]["key"];

export const VENDOR = "com.acme";

export function sampleName(key: SampleKey): string {
  return `${VENDOR}/${key}`;
}

export type PlanEvent = {
  readonly name: string;
  readonly label: string;
  // Strict, Accepts all, or From the server, as the tracking plan list says it.
  readonly note: string;
  readonly strict: boolean;
  readonly attributes: readonly CatalogAttribute[];
};

export type TrackingPlan = {
  // Active events in the catalog.
  readonly size: number;
  // The first few, in catalog order.
  readonly events: readonly PlanEvent[];
  // Each sample event as the catalog has it, or null when the catalog has no active event by that name.
  readonly samples: Readonly<Record<SampleKey, PlanEvent | null>>;
};

export const PLAN_LIST_LENGTH = 6;

export function toPlanEvent(event: CatalogEvent): PlanEvent {
  const note = event.kind === "business" ? "From the server" : event.gate ? `Strict · ${event.requiredCount} must be sent` : "Accepts all";
  return { name: event.name, label: event.label, note, strict: event.gate, attributes: event.attributes };
}

export function trackingPlan(
  size: number,
  firstPage: readonly CatalogEvent[],
  sampleMatches: Readonly<Record<SampleKey, readonly CatalogEvent[]>>,
): TrackingPlan {
  const sample = (key: SampleKey) => {
    const found = sampleMatches[key].find((event) => event.name === sampleName(key) && event.status === "active");
    return found === undefined ? null : toPlanEvent(found);
  };
  return {
    size,
    events: firstPage.slice(0, PLAN_LIST_LENGTH).map(toPlanEvent),
    samples: { product_viewed: sample("product_viewed"), add_to_cart: sample("add_to_cart"), order_completed: sample("order_completed") },
  };
}
