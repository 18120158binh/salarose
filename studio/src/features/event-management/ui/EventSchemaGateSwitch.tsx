"use client";

import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { setUserEventSchemaEnforcementAction } from "@/app/actions";

interface EventSchemaGateSwitchProps {
  enforced: boolean;
  eventId: string;
  eventLabel: string;
  onChange: (enforced: boolean) => void;
}

const FAILED = "The schema gate did not change. Try again.";

// Turns the event's schema gate on or off. Turning it on asks first, because ingestion then drops
// every event of this name that does not match its attributes, and dropped events are not kept.
export function EventSchemaGateSwitch({ enforced, eventId, eventLabel, onChange }: EventSchemaGateSwitchProps) {
  const [checked, setChecked] = useState(enforced);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  const handleChange = async (next: boolean) => {
    if (
      next
      && !window.confirm(
        `Enforce the schema of "${eventLabel}"? Events of this name that miss a required attribute or send a value of the wrong type will be dropped and cannot be recovered.`,
      )
    ) {
      return;
    }
    setIsSaving(true);
    setError("");
    try {
      const result = await setUserEventSchemaEnforcementAction(eventId, next);
      if (result.error) {
        setError(result.error);
        return;
      }
      setChecked(next);
      onChange(next);
    } catch {
      setError(FAILED);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <Switch
        aria-label={`Enforce schema for ${eventLabel}`}
        checked={checked}
        disabled={isSaving}
        onCheckedChange={(next) => void handleChange(next)}
      />
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
