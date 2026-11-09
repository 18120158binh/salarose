"use client";

import React, { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import Header from "@/shared/ui/Header";
import { publishCampaignAction, deleteCampaignAction, toggleCampaignStatusAction } from "../actions";
import { Campaign } from "@/entities/journey/model/types";
import CampaignList from "./components/CampaignList";
import { cloneAsDraft, loadDrafts, saveDrafts } from "./draftStore";

const subscribeToNothing = () => () => {};

interface CampaignPageClientProps {
  // The signed-in user, whose drafts the browser keeps apart from other users' drafts.
  userId: string;
  dbCampaigns: Campaign[];
  isAdminUser?: boolean;
}

export default function CampaignPageClient({ userId, dbCampaigns, isAdminUser = false }: CampaignPageClientProps) {
  const router = useRouter();
  // False while rendering on the server, where browser storage does not exist.
  const mounted = useSyncExternalStore(subscribeToNothing, () => true, () => false);
  const loaded = useMemo(() => {
    if (!mounted) return [];
    // The user's drafts in this browser that are not published yet.
    const dbIds = new Set(dbCampaigns.map((c) => c.id));
    return [...dbCampaigns, ...loadDrafts(userId).filter((d) => !dbIds.has(d.id))];
  }, [mounted, userId, dbCampaigns]);
  // The list as changed on this page. A new list from the server replaces it.
  const [edited, setEdited] = useState<{ from: Campaign[]; campaigns: Campaign[] } | null>(null);
  const campaigns = edited?.from === dbCampaigns ? edited.campaigns : loaded;

  // A draft that has since been published is dropped from the browser.
  useEffect(() => {
    if (mounted) saveDrafts(userId, loaded);
  }, [mounted, userId, loaded]);

  const saveCampaignsToStore = (updatedCampaigns: Campaign[]) => {
    setEdited({ from: dbCampaigns, campaigns: updatedCampaigns });
    saveDrafts(userId, updatedCampaigns);
  };

  const handleEditCampaign = (id: string) => {
    router.push(`/campaign/${id}`);
  };

  const handleCreateCampaign = () => {
    router.push("/campaign/new");
  };

  const handleDeleteCampaign = async (id: string) => {
    const campaignToDelete = campaigns.find((c) => c.id === id);
    if (!campaignToDelete) return;

    if (campaignToDelete.status === "active" || campaignToDelete.status === "paused") {
      try {
        const res = await deleteCampaignAction(id);
        if (res.error) {
          console.error("Failed to delete campaign from database:", res.error);
          alert(res.error);
          return;
        }
        router.refresh();
      } catch (error) {
        console.error("Failed to delete campaign from database:", error);
        alert("Failed to delete campaign from database.");
        return;
      }
    }
    const updated = campaigns.filter((c) => c.id !== id);
    saveCampaignsToStore(updated);
  };

  const handleToggleStatus = async (id: string) => {
    const campaign = campaigns.find((c) => c.id === id);
    if (!campaign) return;

    let newStatus: Campaign["status"];
    if (campaign.status === "active") {
      newStatus = "paused";
      try {
        const res = await toggleCampaignStatusAction(id, "paused");
        if (res && res.error) {
          console.error("Failed to pause campaign in DB:", res.error);
          alert(`Failed to pause campaign in database: ${res.error}`);
          return;
        }
        router.refresh();
      } catch (error) {
        console.error("Failed to pause campaign in DB:", error);
        alert("Failed to pause campaign in database.");
        return;
      }
    } else if (campaign.status === "paused") {
      newStatus = "active";
      try {
        const res = await toggleCampaignStatusAction(id, "active");
        if (res && res.error) {
          console.error("Failed to resume campaign in DB:", res.error);
          alert(`Failed to resume campaign in database: ${res.error}`);
          return;
        }
        router.refresh();
      } catch (error) {
        console.error("Failed to resume campaign in DB:", error);
        alert("Failed to resume campaign in database.");
        return;
      }
    } else {
      newStatus = "active";
      try {
        const res = await publishCampaignAction(campaign);

        if (res && res.error) {
          console.error("Failed to publish campaign to DB:", res.error);
          alert(`Failed to publish campaign to database: ${res.error}`);
          return;
        }
        router.refresh();
      } catch (error) {
        console.error("Failed to publish campaign to DB:", error);
        alert("Failed to publish campaign to database.");
        return;
      }
    }

    const updated = campaigns.map((c) => {
      if (c.id === id) {
        return { ...c, status: newStatus };
      }
      return c;
    });
    saveCampaignsToStore(updated);
  };

  const handleCloneCampaign = (idOrCampaign: string | Campaign) => {
    const orig = typeof idOrCampaign === "string"
      ? campaigns.find((c) => c.id === idOrCampaign)
      : idOrCampaign;

    if (!orig) return;

    const clone = cloneAsDraft(userId, orig);
    router.push(`/campaign/${clone.id}`);
  };

  if (!mounted) {
    return (
      <div className="flex flex-col flex-1 h-full items-center justify-center bg-background text-muted-foreground">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 overflow-hidden h-full">
      <Header
        currentView="campaign"
        isAdminUser={isAdminUser}
      />
      <div className="flex-1 overflow-hidden flex flex-col bg-background">
        <CampaignList
          campaigns={campaigns}
          onEdit={handleEditCampaign}
          onCreate={handleCreateCampaign}
          onDelete={handleDeleteCampaign}
          onToggleStatus={handleToggleStatus}
          onClone={handleCloneCampaign}
        />
      </div>
    </div>
  );
}
