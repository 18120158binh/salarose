"use client";

import React, { useMemo, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import Header from "@/shared/ui/Header";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { publishCampaignAction, getCampaignNodeStatsAction } from "../../actions";
import { Campaign } from "@/entities/journey/model/types";
import CampaignBuilder from "../components/CampaignBuilder";
import type { BuilderPickers } from "../components/NodeEditor";
import { cloneAsDraft, loadDrafts, saveDrafts } from "../draftStore";
import { useNodeStats } from "./useNodeStats";

interface CampaignBuilderPageClientProps {
  id: string;
  // The signed-in user, whose drafts the browser keeps apart from other users' drafts.
  userId: string;
  /** The published campaign with this id, when the user owns it or is an admin. */
  dbCampaign: Campaign | null;
  isAdminUser?: boolean;
  pickers: BuilderPickers;
}

type Opened = { kind: "campaign"; campaign: Campaign } | { kind: "new" } | { kind: "not-found" };

// A draft lives only in this browser, so an id the server did not find may still be a draft.
function openCampaign(id: string, userId: string, dbCampaign: Campaign | null): Opened {
  if (dbCampaign) return { kind: "campaign", campaign: dbCampaign };
  const draft = loadDrafts(userId).find((c) => c.id === id);
  if (draft) return { kind: "campaign", campaign: draft };
  return id === "new" ? { kind: "new" } : { kind: "not-found" };
}

const subscribeToNothing = () => () => {};

export default function CampaignBuilderPageClient({
  id,
  userId,
  dbCampaign,
  isAdminUser = false,
  pickers,
}: CampaignBuilderPageClientProps) {
  const router = useRouter();
  // False while rendering on the server, where browser storage does not exist.
  const mounted = useSyncExternalStore(subscribeToNothing, () => true, () => false);
  const opened = useMemo(() => (mounted ? openCampaign(id, userId, dbCampaign) : null), [mounted, id, userId, dbCampaign]);
  const { stats, failed: statsFailed } = useNodeStats(opened?.kind === "campaign" ? id : null, getCampaignNodeStatsAction);

  const handleSaveCampaign = async (savedCampaign: Campaign, publish?: boolean) => {
    let drafts = loadDrafts(userId);

    if (publish) {
      savedCampaign.status = "active";
      try {
        const res = await publishCampaignAction(savedCampaign);
        
        if (res && res.error) {
          console.error("Failed to publish campaign to database:", res.error);
          alert(`Failed to publish campaign to database: ${res.error}`);
          return;
        }
        
        // Remove from drafts if it was a draft
        saveDrafts(userId, drafts.filter((c) => c.id !== savedCampaign.id));
      } catch (error) {
        console.error("Failed to publish campaign to database:", error);
        alert(`Failed to publish campaign to database: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    } else {
      savedCampaign.status = "draft";
      // Update/add to drafts
      const exists = drafts.some((c) => c.id === savedCampaign.id);
      if (exists) {
        drafts = drafts.map((c) => (c.id === savedCampaign.id ? savedCampaign : c));
      } else {
        drafts = [...drafts, savedCampaign];
      }
      saveDrafts(userId, drafts);
    }

    router.push("/campaign");
    router.refresh();
  };

  const handleCloneCampaign = (orig: Campaign) => {
    const clone = cloneAsDraft(userId, orig);
    router.push(`/campaign/${clone.id}`);
  };

  if (!opened) {
    return (
      <div className="flex flex-col flex-1 h-full items-center justify-center bg-background text-muted-foreground">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 overflow-hidden h-full">
      <Header currentView="campaign" isAdminUser={isAdminUser} />
      <div className="flex-1 overflow-hidden flex flex-col bg-background">
        {opened.kind === "not-found" ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Campaign not found</EmptyTitle>
              <EmptyDescription>
                Campaign {id} does not exist, or another user owns it.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" onClick={() => router.push("/campaign")}>
                Back to campaigns
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <CampaignBuilder
            key={opened.kind === "campaign" ? opened.campaign.id : "new"}
            campaign={opened.kind === "campaign" ? opened.campaign : null}
            stats={stats}
            statsFailed={statsFailed}
            pickers={pickers}
            onSave={handleSaveCampaign}
            onBack={() => router.push("/campaign")}
            onClone={handleCloneCampaign}
          />
        )}
      </div>
    </div>
  );
}
