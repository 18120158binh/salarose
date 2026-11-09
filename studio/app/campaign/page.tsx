import * as db from "@/lib/db";
import { requireSession } from "@/shared/auth/session";
import CampaignPageClient from "./CampaignPageClient";

export const dynamic = "force-dynamic";

export default async function CampaignsPage() {
  const session = await requireSession();
  const dbCampaigns = await db.getCampaigns(db.campaignActor(session));

  return (
    <CampaignPageClient
      userId={session.userId}
      dbCampaigns={dbCampaigns}
      isAdminUser={session.role === "admin"}
    />
  );
}
