"use client";

import { useRouter } from "next/navigation";
import { CopyIcon, PauseIcon, PlayIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useJourneyLifecycle } from "./lifecycle";

export interface JourneyActionsProps {
  id: string;
  name: string;
  status: "active" | "paused";
  /** The owner or an admin (CMP-FR-07). Anyone else gets Duplicate to edit only. */
  manages: boolean;
  /** The v2 builder lets the viewer through, so Duplicate to edit can open the copy. */
  canBuild: boolean;
}

// JBD-FR-23: a published journey's header actions. A control the viewer may not use is absent.
export function JourneyActions({ id, name, status, manages, canBuild }: JourneyActionsProps) {
  const router = useRouter();
  const lifecycle = useJourneyLifecycle({
    onStatus: () => router.refresh(),
    onDeleted: () => router.push("/v2/journeys"),
  });
  const target = { kind: "published" as const, id, name };

  return (
    <>
      {manages &&
        (status === "active" ? (
          <Button onClick={() => void lifecycle.pause(target)} variant="outline">
            <PauseIcon aria-hidden />
            Pause
          </Button>
        ) : (
          <Button onClick={() => void lifecycle.resume(target)} variant="outline">
            <PlayIcon aria-hidden />
            Resume
          </Button>
        ))}
      {canBuild && (
        <Button onClick={() => void lifecycle.duplicate(target)}>
          <CopyIcon aria-hidden />
          Duplicate to edit
        </Button>
      )}
      {manages && (
        <Button onClick={() => lifecycle.askDelete(target)} variant="destructive-outline">
          <Trash2Icon aria-hidden />
          Delete
        </Button>
      )}
      {lifecycle.dialog}
    </>
  );
}
