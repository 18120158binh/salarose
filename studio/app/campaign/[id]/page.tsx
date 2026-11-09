import * as db from "@/lib/db";
import { requireSession } from "@/shared/auth/session";
import CampaignBuilderPageClient from "./CampaignBuilderPageClient";

export const dynamic = "force-dynamic";

interface CampaignDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function CampaignDetailPage({ params }: CampaignDetailPageProps) {
  const session = await requireSession();
  const resolvedParams = await params;
  const id = resolvedParams.id;
  // A draft lives in the browser, so the client decides between a draft and "not found".
  const [dbCampaign, userEvents] = await Promise.all([
    db.getCampaign(id, db.campaignActor(session)),
    pickerOptions("user events", db.getUserEvents),
  ]);

  return (
    <CampaignBuilderPageClient
      id={id}
      userId={session.userId}
      dbCampaign={dbCampaign}
      isAdminUser={session.role === "admin"}
      pickers={{ userEvents }}
    />
  );
}

// The pickers load once per page. Without them the builder still opens, and the trigger list
// shows only the business events.
async function pickerOptions<T>(name: string, load: () => Promise<T[]>): Promise<T[]> {
  try {
    return await load();
  } catch (error) {
    console.error(`Failed to load ${name}:`, error);
    return [];
  }
}
