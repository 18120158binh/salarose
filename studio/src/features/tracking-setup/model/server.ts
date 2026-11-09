import "server-only";
import { DEFAULT_CATALOG_QUERY, type CatalogQuery } from "@/features/data-health/model/catalog";
import { loadCatalogPage } from "@/features/data-health/model/catalogServer";
import { trackingPlan, sampleName, type TrackingPlan } from "./plan";

const ACTIVE: CatalogQuery = { ...DEFAULT_CATALOG_QUERY, status: "active" };

/** The tracking plan from the event catalog: its active events, and the three sample events by exact name. */
export async function loadTrackingPlan(): Promise<TrackingPlan> {
  const [plan, viewed, cart, order] = await Promise.all([
    loadCatalogPage(ACTIVE),
    loadCatalogPage({ ...ACTIVE, search: sampleName("product_viewed") }),
    loadCatalogPage({ ...ACTIVE, search: sampleName("add_to_cart") }),
    loadCatalogPage({ ...ACTIVE, search: sampleName("order_completed") }),
  ]);
  return trackingPlan(plan.matching, plan.events, {
    product_viewed: viewed.events,
    add_to_cart: cart.events,
    order_completed: order.events,
  });
}
