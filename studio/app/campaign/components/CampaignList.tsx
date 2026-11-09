import React from "react";
import type { Campaign, CampaignTreeRef, CheckNext, SegmentNext, WatchNext } from "@/entities/journey/model/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Play, Pause, Copy, Trash2 } from "lucide-react";

interface JourneySummary {
  trigger: string;
  checks: number;
  watches: number;
  segments: number;
  hasDelays: boolean;
  hasMultiBranch: boolean;
  channel: string;
}

// Walks every path of the journey, including each branch and each parallel child, so steps
// after a segment, a multi-branch check, or a delay are counted too.
function summarizeJourney(root: CampaignTreeRef): JourneySummary {
  const summary: JourneySummary = {
    trigger: "None",
    checks: 0,
    watches: 0,
    segments: 0,
    hasDelays: false,
    hasMultiBranch: false,
    channel: "None",
  };

  // A draft is saved while it is edited, so an outcome may not be filled in yet.
  const outcomes = (next: CheckNext | SegmentNext | WatchNext | undefined): CampaignTreeRef[] => {
    switch (next?.type) {
      case "YesPath":
        return [next.yes];
      case "NoPath":
        return [next.no];
      case "YesOrNoPath":
        return [next.yes, next.no];
      case "MultiBranchPath":
        summary.hasMultiBranch = true;
        return next.branches.map((branch) => branch.next);
      case "SuccessPath":
        return [next.success];
      case "TimeoutPath":
        return [next.timeout];
      case "SuccessOrTimeoutPath":
        return [next.success, next.timeout];
      case "DelayPath":
        summary.hasDelays = true;
        return [next.next];
      default:
        return [];
    }
  };

  const visit = (ref: CampaignTreeRef | undefined): void => {
    if (!ref) return;
    if (Array.isArray(ref)) {
      ref.forEach(visit);
      return;
    }
    switch (ref.type) {
      case "setup":
        summary.trigger = ref.triggerEventName || "None";
        visit(ref.next);
        break;
      case "check":
        summary.checks++;
        outcomes(ref.next).forEach(visit);
        break;
      case "segment":
        summary.segments++;
        outcomes(ref.next).forEach(visit);
        break;
      case "watch":
        summary.watches++;
        outcomes(ref.next).forEach(visit);
        break;
      case "engagement":
        if (summary.channel === "None") summary.channel = ref.action.type;
        visit(ref.next);
        break;
    }
  };

  visit(root);
  return summary;
}

interface CampaignListProps {
  campaigns: Campaign[];
  onEdit: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onToggleStatus: (id: string) => void;
  onClone: (id: string) => void;
}

export default function CampaignList({
  campaigns,
  onEdit,
  onCreate,
  onDelete,
  onToggleStatus,
  onClone,
}: CampaignListProps) {
  const getStatusBadge = (status: Campaign["status"]) => {
    switch (status) {
      case "active":
        return (
          <Badge className="bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 border-emerald-500/30 flex items-center gap-1.5 px-2.5 py-1">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            Active
          </Badge>
        );
      case "paused":
        return (
          <Badge className="bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 border-amber-500/30 flex items-center gap-1.5 px-2.5 py-1">
            <span className="h-2 w-2 rounded-full bg-amber-500"></span>
            Paused
          </Badge>
        );
      case "draft":
      default:
        return (
          <Badge className="bg-neutral-500/10 text-neutral-500 hover:bg-neutral-500/20 border-neutral-500/30 flex items-center gap-1.5 px-2.5 py-1">
            <span className="h-2 w-2 rounded-full bg-neutral-500"></span>
            Draft
          </Badge>
        );
    }
  };

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin p-6 max-w-6xl mx-auto w-full">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-foreground sm:text-4xl">
            Campaign Setup
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Manage real-time marketing journeys, segment triggers, and targeted engagements.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={onCreate} variant="default" size="lg" className="flex items-center gap-2">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
              className="w-5 h-5"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Create Campaign
          </Button>
        </div>
      </div>

      {campaigns.length === 0 ? (
        <Card className="border-dashed border-2 py-12 flex flex-col items-center justify-center text-center">
          <CardContent className="flex flex-col items-center">
            <div className="rounded-full bg-muted p-4 mb-4">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="w-10 h-10 text-muted-foreground"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M10.34 15.84c-.688-.06-1.386-.09-2.09-.09H7.5a4.5 4.5 0 1 1 0-9h.75c.704 0 1.402-.03 2.09-.09m0 9.18c.253.962.584 1.892.985 2.783.247.55.06 1.21-.463 1.511l-.357.205a.75.75 0 0 1-1.06-.415 10.202 10.202 0 0 1-.9-2.531m9.06-7.03.145-.168a1.5 1.5 0 0 1 2.164 0l.398.462a1.5 1.5 0 0 1 0 2.164l-.145.168m-2.562-2.624M20.4 12c-.06.688-.09 1.386-.09 2.09v.75a4.5 4.5 0 0 1-9 0v-.75c0-.704-.03-1.402-.09-2.09m9.18 0c.962-.253 1.892-.584 2.783-.985.55-.247 1.21-.06 1.511.463l.205.357a.75.75 0 0 1-.415 1.06 10.202 10.202 0 0 1-2.531.9"
                />
              </svg>
            </div>
            <CardTitle className="text-xl font-bold mb-2">No campaigns found</CardTitle>
            <CardDescription className="max-w-xs mb-6">
              Create your first behavioral flow to automatically trigger message templates.
            </CardDescription>
            <Button onClick={onCreate} variant="outline">
              Get Started
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-1">
          {campaigns.map((camp) => {
            const summary = summarizeJourney(camp.root);

            return (
              <Card
                key={camp.id}
                className="group border border-border hover:border-primary/20 hover:shadow-lg transition-all duration-300"
              >
                <div className="p-4 sm:py-4 sm:px-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-mono font-bold bg-muted px-2 py-0.5 rounded text-muted-foreground border">
                        {camp.id}
                      </span>
                      <h2
                        onClick={() => onEdit(camp.id)}
                        className="text-lg font-bold text-foreground group-hover:text-primary transition-colors cursor-pointer hover:underline"
                      >
                        {camp.name}
                      </h2>
                      {getStatusBadge(camp.status)}
                      {camp.ownerless && <Badge variant="outline">No owner</Badge>}
                    </div>
                    <p className="text-sm text-muted-foreground line-clamp-1">
                      {camp.description}
                    </p>
                    <ul
                      aria-label={`Journey summary of ${camp.name}`}
                      className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-xs text-muted-foreground"
                    >
                      <li>
                        Trigger: <strong className="text-foreground">{summary.trigger}</strong>
                      </li>
                      <li>
                        Checks: <strong className="text-foreground">{summary.checks}</strong>
                      </li>
                      <li>
                        Watches: <strong className="text-foreground">{summary.watches}</strong>
                      </li>
                      <li>
                        Segments: <strong className="text-foreground">{summary.segments}</strong>
                      </li>
                      {summary.hasDelays && <li>Has delays</li>}
                      {summary.hasMultiBranch && <li>Has multi-branch paths</li>}
                      <li>
                        Channel: <strong className="text-foreground">{summary.channel}</strong>
                      </li>
                    </ul>
                  </div>

                  <div className="flex flex-row sm:flex-col items-center sm:items-stretch justify-end gap-1.5 w-full sm:w-28 shrink-0 border-t sm:border-t-0 pt-3 sm:pt-0">
                    <Button
                      onClick={() => onToggleStatus(camp.id)}
                      variant="outline"
                      size="sm"
                      className="flex-1 sm:flex-initial w-full flex items-center justify-center gap-2 h-8 text-xs"
                    >
                      {camp.status === "active" ? (
                        <>
                          <Pause className="w-3.5 h-3.5" />
                          Pause
                        </>
                      ) : camp.status === "paused" ? (
                        <>
                          <Play className="w-3.5 h-3.5" />
                          Resume
                        </>
                      ) : (
                        <>
                          <Play className="w-3.5 h-3.5" />
                          Activate
                        </>
                      )}
                    </Button>
                    <Button
                      onClick={() => onClone(camp.id)}
                      variant="outline"
                      size="sm"
                      className="flex-1 sm:flex-initial w-full flex items-center justify-center gap-2 h-8 text-xs"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      Clone
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger
                        render={
                          <Button
                            variant="destructive-outline"
                            size="sm"
                            className="flex-1 sm:flex-initial w-full text-xs flex items-center justify-center gap-2 h-8"
                          />
                        }
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Delete
                      </AlertDialogTrigger>
                      <AlertDialogPopup>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete {camp.name}?</AlertDialogTitle>
                          <AlertDialogDescription>
                            {camp.status === "draft"
                              ? "The draft is removed from this browser."
                              : "The journey stops and the campaign is removed."}{" "}
                            You cannot undo this.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
                          <AlertDialogClose render={<Button variant="destructive" />} onClick={() => onDelete(camp.id)}>
                            Delete
                          </AlertDialogClose>
                        </AlertDialogFooter>
                      </AlertDialogPopup>
                    </AlertDialog>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
