import type { DbCampaignNode } from "@/lib/db";
import { parseJourney } from "@/entities/journey/model/parseCampaign";
import { flattenCampaignTree } from "@/entities/journey/model/utils";
import { UserFacingError } from "shared/lib/userFacingError";

// CMP-FR-05: resume rebuilds the node rows from the tree an earlier publish stored. A manual edit or
// an older studio may have stored a malformed one, so it is parsed like a submitted journey, and the
// refusal names the journey.
export function storedJourneyNodes(campaignId: string, storedRoot: unknown): DbCampaignNode[] {
  let journey;
  try {
    journey = parseJourney(storedRoot);
  } catch (error) {
    if (!(error instanceof UserFacingError)) throw error;
    throw new UserFacingError(`This journey cannot resume. ${error.message}`);
  }
  return flattenCampaignTree(campaignId, journey);
}
