import { eventDeletionWarning } from "../eventDeletion";

const metrics = [{ id: "m_cart_count", displayName: "Carts in last 7 days", measure: "Times performed" }];
const recovery = { id: "c_recovery", name: "Cart recovery", status: "active" };

describe("eventDeletionWarning (CAT-FR-08)", () => {
  it("asks plainly when nothing uses the event", () => {
    expect(eventDeletionWarning("Added to cart", { metrics: [], metricCampaigns: [], conditionCampaigns: [] })).toBe(
      'Delete the event "Added to cart" and its attributes?',
    );
  });

  it("says the delete is refused and metrics are kept while a metric uses the event", () => {
    const warning = eventDeletionWarning("Added to cart", { metrics, metricCampaigns: [], conditionCampaigns: [] });
    expect(warning).toContain("the delete will be refused");
    expect(warning).toContain("never deleted");
    expect(warning).toContain("- Carts in last 7 days (m_cart_count)");
  });

  it("names each campaign once", () => {
    const warning = eventDeletionWarning("Added to cart", { metrics: [], metricCampaigns: [recovery], conditionCampaigns: [recovery] });
    expect(warning.match(/Cart recovery/g)).toHaveLength(1);
  });
});
