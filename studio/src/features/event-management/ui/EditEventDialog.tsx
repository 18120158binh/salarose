"use client";

import React, { useRef, useState } from "react";
import type { UserEventSummary } from "@/app/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  completeEventKind,
  draftForKind,
  eventItemKey,
  type EventKindDraft,
} from "@/features/event-management/model/eventKindDraft";
import {
  EventKindRadioGroup,
  FixedItemKey,
  ITEM_KEY_REQUIRED,
  ItemKeySelect,
} from "@/features/event-management/ui/EventKindFields";
import { callServerAction } from "@/shared/lib/serverAction";
import { updateUserEventAction } from "@/app/actions";
import type { EventKind } from "shared/lib/eventCatalog";
import { AlertCircle } from "lucide-react";

// The event's attribute paths, which a person event picks its item key from.
export type EventAttributePaths =
  | { status: "loading" }
  | { status: "failed"; error: string }
  | { status: "loaded"; paths: string[] };

interface EditEventDialogProps {
  event: UserEventSummary | null;
  attributePaths: EventAttributePaths;
  onRetryAttributePaths: () => void;
  onClose: () => void;
  onSaved: (eventId: string, changes: { label: string; description?: string; eventKind: EventKind }) => void;
}

// Edits an event's display name, description, and kind. The system name is what tracking sends, so
// it is shown but cannot change here. A person event may become business; a business event keeps
// its kind and item key.
export function EditEventDialog({ event, attributePaths, onRetryAttributePaths, onClose, onSaved }: EditEventDialogProps) {
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open={event !== null}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Event</DialogTitle>
        </DialogHeader>
        {event && (
          <EditEventForm
            attributePaths={attributePaths}
            event={event}
            onRetryAttributePaths={onRetryAttributePaths}
            onSaved={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditEventForm({
  attributePaths,
  event,
  onRetryAttributePaths,
  onSaved,
}: Omit<EditEventDialogProps, "event" | "onClose"> & { event: UserEventSummary }) {
  const [displayName, setDisplayName] = useState(event.label);
  const [description, setDescription] = useState(event.description ?? "");
  const [kindDraft, setKindDraft] = useState<EventKindDraft>(event.eventKind);
  const [itemKeyError, setItemKeyError] = useState("");
  const [error, setError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const itemKeyTriggerRef = useRef<HTMLButtonElement>(null);
  const fixedItemKey = eventItemKey(event.eventKind);

  const handleSubmit = async (formEvent: React.FormEvent) => {
    formEvent.preventDefault();
    if (isSaving) return;
    const eventKind = completeEventKind(kindDraft);
    if (!eventKind) {
      setItemKeyError(ITEM_KEY_REQUIRED);
      itemKeyTriggerRef.current?.focus();
      return;
    }
    setIsSaving(true);
    setError("");
    try {
      const result = await callServerAction(() =>
        updateUserEventAction(event.id, displayName, description, eventKind),
      );
      if (result.error !== undefined) {
        setError(result.error);
        return;
      }
      onSaved(event.id, { label: displayName.trim(), description: description.trim() || undefined, eventKind });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      <DialogPanel>
        <form className="space-y-4" id="edit-event-form" onSubmit={handleSubmit}>
          {error && (
            <Alert variant="error">
              <AlertCircle aria-hidden="true" />
              <AlertDescription className="whitespace-pre-line">{error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label htmlFor="edit-event-system-name">System name</Label>
            <Input className="font-mono" id="edit-event-system-name" readOnly value={event.name} />
            <p className="text-[10px] text-muted-foreground">Tracking sends this name, so it cannot change.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-event-display-name">Display name</Label>
            <Input
              id="edit-event-display-name"
              onChange={(e) => setDisplayName(e.target.value)}
              required
              value={displayName}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-event-description">Event description</Label>
            <Input
              id="edit-event-description"
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
              value={description}
            />
          </div>
          {fixedItemKey !== null ? (
            <>
              <EventKindRadioGroup disabled onValueChange={() => undefined} value="business" />
              <FixedItemKey itemKey={fixedItemKey} />
            </>
          ) : (
            <>
              <EventKindRadioGroup
                businessDisabled={attributePaths.status !== "loaded"}
                onValueChange={(kind) => {
                  setKindDraft(draftForKind(kind));
                  setItemKeyError("");
                }}
                value={kindDraft.kind}
              />
              <AttributePathsStatus attributePaths={attributePaths} onRetry={onRetryAttributePaths} />
              {kindDraft.kind === "business" && attributePaths.status === "loaded" && (
                <ItemKeySelect
                  error={itemKeyError || undefined}
                  onValueChange={(itemKey) => {
                    setKindDraft({ kind: "business", itemKey });
                    setItemKeyError("");
                  }}
                  paths={attributePaths.paths}
                  triggerRef={itemKeyTriggerRef}
                  value={kindDraft.itemKey}
                />
              )}
            </>
          )}
        </form>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" type="button">Cancel</Button>} />
        <Button form="edit-event-form" loading={isSaving} type="submit">
          Save event
        </Button>
      </DialogFooter>
    </>
  );
}

function AttributePathsStatus({
  attributePaths,
  onRetry,
}: {
  attributePaths: EventAttributePaths;
  onRetry: () => void;
}) {
  switch (attributePaths.status) {
    case "loading":
      return (
        <div aria-label="Loading attributes" className="space-y-2" role="status">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-8 w-full" />
        </div>
      );
    case "failed":
      return (
        <div
          className="flex items-center justify-between gap-4 rounded-lg border border-destructive/30 bg-background p-3"
          role="alert"
        >
          <p className="text-xs text-destructive">{attributePaths.error}</p>
          <Button onClick={onRetry} size="xs" type="button" variant="outline">
            Retry
          </Button>
        </div>
      );
    case "loaded":
      return null;
    default: {
      const unknownStatus: never = attributePaths;
      throw new Error(`Unknown attribute status ${JSON.stringify(unknownStatus)}`);
    }
  }
}
