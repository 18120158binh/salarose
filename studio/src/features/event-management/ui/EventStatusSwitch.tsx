"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { callServerAction } from "@/shared/lib/serverAction";
import { setUserEventStatusAction } from "@/app/actions";
import type { EventStatus } from "shared/lib/eventCatalog";

interface EventStatusSwitchProps {
  eventId: string;
  eventLabel: string;
  status: string;
  onChange: (status: EventStatus) => void;
}

function statusLabel(status: string): string {
  return status ? status.charAt(0).toUpperCase() + status.slice(1) : "Unknown";
}

// Shows an event's stored status and switches it between active and inactive. The builder offers
// only active events.
export function EventStatusSwitch({ eventId, eventLabel, status, onChange }: EventStatusSwitchProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const isActive = status === "active";

  const handleChange = async (active: boolean) => {
    const next: EventStatus = active ? "active" : "inactive";
    setIsSaving(true);
    setError("");
    try {
      const result = await callServerAction(() => setUserEventStatusAction(eventId, next));
      if (result.error !== undefined) {
        setError(result.error);
        return;
      }
      onChange(next);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Switch
          aria-label={`${eventLabel} is active`}
          checked={isActive}
          disabled={isSaving}
          onCheckedChange={(active) => void handleChange(active)}
        />
        <Badge variant={isActive ? "success" : "secondary"}>{statusLabel(status)}</Badge>
      </div>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
