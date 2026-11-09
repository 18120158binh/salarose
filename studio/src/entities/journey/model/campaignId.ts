// A new campaign id: CAMP- and 64 random bits in hex. Publishing rejects an id that another
// user's campaign already has, so a collision fails instead of overwriting that campaign.
// getRandomValues also works on a page served over plain HTTP, where randomUUID does not.
export function newCampaignId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `CAMP-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}
