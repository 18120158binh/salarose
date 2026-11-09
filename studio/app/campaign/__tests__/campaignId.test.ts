import { newCampaignId } from "@/entities/journey/model/campaignId";

describe("newCampaignId", () => {
  it("does not repeat over ten thousand ids", () => {
    const ids = Array.from({ length: 10000 }, () => newCampaignId());

    expect(new Set(ids).size).toBe(10000);
    expect(ids[0]).toMatch(/^CAMP-[0-9A-F]{16}$/);
  });
});
