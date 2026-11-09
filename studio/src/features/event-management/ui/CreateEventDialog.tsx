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
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { normalizeEventAttributePath } from "@/features/event-management/model/eventAttributeTree";
import {
  completeEventKind,
  draftForKind,
  keepAvailableItemKey,
  type EventKindDraft,
} from "@/features/event-management/model/eventKindDraft";
import { EventAttributeTreeEditor } from "@/features/event-management/ui/EventAttributeTreeEditor";
import { useEventAttributeDraft } from "@/features/event-management/ui/useEventAttributeDraft";
import {
  EventKindRadioGroup,
  ITEM_KEY_REQUIRED,
  ItemKeySelect,
} from "@/features/event-management/ui/EventKindFields";
import { callServerAction } from "@/shared/lib/serverAction";
import { createUserEventWithFieldsAction } from "@/app/actions";
import { normalizeEventSystemName } from "shared/lib/eventCatalog";
import { AlertCircle, Plus } from "lucide-react";

interface CreateEventDialogProps {
  onCreated: (event: UserEventSummary) => void;
}

// The form keeps what the admin typed until the create succeeds, so a refused create can be
// corrected and sent again.
export function CreateEventDialog({ onCreated }: CreateEventDialogProps) {
  const draft = useEventAttributeDraft();
  const { attributes, creationMode, jsonPayload, jsonError, treeError } = draft;
  const [isOpen, setIsOpen] = useState(false);
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [kindDraft, setKindDraft] = useState<EventKindDraft>({ kind: "person" });
  const [itemKeyError, setItemKeyError] = useState("");
  const itemKeyTriggerRef = useRef<HTMLButtonElement>(null);
  const attributePaths = [
    ...new Set(attributes.map((attribute) => normalizeEventAttributePath(attribute.value)).filter(Boolean)),
  ];

  // The builder and the JSON payload can rename or remove the chosen attribute. Clear the item key
  // then, instead of sending a path the event no longer has.
  const availableKindDraft = keepAvailableItemKey(kindDraft, attributePaths);
  if (availableKindDraft !== kindDraft) setKindDraft(availableKindDraft);

  const reset = () => {
    setName("");
    setDisplayName("");
    setDescription("");
    draft.reset();
    setSubmitError("");
    setKindDraft({ kind: "person" });
    setItemKeyError("");
  };

  const handleSubmit = async (formEvent: React.FormEvent) => {
    formEvent.preventDefault();
    const fieldsToSave = draft.toSave();
    if (fieldsToSave === null) return;
    const savedPaths = fieldsToSave.map((field) => normalizeEventAttributePath(field.value));
    const eventKind = completeEventKind(keepAvailableItemKey(kindDraft, savedPaths));
    if (!eventKind) {
      setItemKeyError(ITEM_KEY_REQUIRED);
      itemKeyTriggerRef.current?.focus();
      return;
    }

    setIsSubmitting(true);
    setSubmitError("");
    try {
      const result = await callServerAction(() =>
        createUserEventWithFieldsAction(
          name,
          displayName,
          description,
          eventKind,
          fieldsToSave.map((field) => ({
            fieldPath: field.value,
            displayName: field.displayName,
            dataType: field.dataType,
            exampleValue: field.exampleValue,
          })),
        ),
      );
      if (result.error !== undefined || !("eventId" in result) || !result.eventId) {
        setSubmitError(result.error ?? "Failed to create the event.");
        return;
      }
      onCreated({
        id: result.eventId,
        name: normalizeEventSystemName(name.trim()),
        label: displayName.trim() || name,
        description: description.trim() || undefined,
        fieldCount: fieldsToSave.length,
        enforceSchema: false,
        eventKind,
        status: "active",
      });
      reset();
      setIsOpen(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog onOpenChange={setIsOpen} open={isOpen}>
      <DialogTrigger render={<Button size="sm"><Plus className="w-4 h-4 mr-1" /> Create Event</Button>} />
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Custom Event</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <form id="create-event-form" onSubmit={handleSubmit} className="space-y-6">
            {submitError && (
              <Alert variant="error">
                <AlertCircle aria-hidden="true" />
                <AlertDescription className="whitespace-pre-line">{submitError}</AlertDescription>
              </Alert>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="eventName">System Name</Label>
                <Input
                  id="eventName"
                  placeholder="e.g., add_to_cart"
                  value={name}
                  onChange={(e) => setName(normalizeEventSystemName(e.target.value))}
                  required
                />
                <p className="text-[10px] text-muted-foreground">Used for technical integration (lowercase, no spaces).</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="displayName">Display Name</Label>
                <Input
                  id="displayName"
                  placeholder="e.g., Add to Cart"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  required
                />
              </div>
              <div className="col-span-2">
                <EventKindRadioGroup
                  onValueChange={(kind) => {
                    setKindDraft(draftForKind(kind));
                    setItemKeyError("");
                  }}
                  value={kindDraft.kind}
                />
              </div>
              {kindDraft.kind === "business" && (
                <ItemKeySelect
                  error={itemKeyError || undefined}
                  onValueChange={(itemKey) => {
                    setKindDraft({ kind: "business", itemKey });
                    setItemKeyError("");
                  }}
                  paths={attributePaths}
                  triggerRef={itemKeyTriggerRef}
                  value={kindDraft.itemKey}
                />
              )}
              <div className="col-span-2 space-y-2">
                <Label htmlFor="description">Description</Label>
                <Input
                  id="description"
                  placeholder="Optional description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
            </div>

            <div className="h-px bg-border my-4"></div>

            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold tracking-tight">Event Attributes (Optional)</h3>
                <p className="text-xs text-muted-foreground">Define custom attributes to be passed along with this event.</p>
              </div>

              <Tabs value={creationMode} onValueChange={draft.changeMode} className="w-full">
                <TabsList className="grid w-full grid-cols-2 max-w-sm mb-4">
                  <TabsTrigger value="manual">Manual Builder</TabsTrigger>
                  <TabsTrigger value="json">JSON Payload</TabsTrigger>
                </TabsList>

                <TabsContent value="manual" className="space-y-4 mt-0">
                  <EventAttributeTreeEditor
                    attributes={attributes}
                    onAdd={draft.add}
                    onChange={draft.change}
                    onDelete={draft.remove}
                    onRename={draft.rename}
                  />
                  {treeError && (
                    <p className="text-xs text-destructive" role="alert">
                      {treeError}
                    </p>
                  )}
                </TabsContent>

                <TabsContent value="json" className="space-y-4 mt-0">
                  <div className="space-y-2">
                    <Label htmlFor="event-attributes-json">Event Attributes JSON</Label>
                    <Textarea
                      id="event-attributes-json"
                      placeholder={'{\n  "product": {\n    "price": 99.99,\n    "name": "Shoes"\n  },\n  "is_discounted": true\n}'}
                      className="font-mono text-xs min-h-[200px]"
                      value={jsonPayload}
                      onChange={(e) => draft.typePayload(e.target.value)}
                      aria-invalid={Boolean(jsonError)}
                    />
                    {jsonError && <p className="text-xs text-destructive mt-1">{jsonError}</p>}
                  </div>
                  <div className="rounded-lg border bg-muted/40 p-3">
                    <p className="text-xs text-muted-foreground">
                      This is the same schema shown in Manual Builder. Valid JSON changes are synchronized automatically.
                    </p>
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          </form>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" type="button">Cancel</Button>} />
          <Button
            type="submit"
            form="create-event-form"
            disabled={isSubmitting || (creationMode === "json" && Boolean(jsonError))}
          >
            {isSubmitting ? "Creating..." : "Save Event & Attributes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
