"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { PlusIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { callServerAction } from "@/shared/lib/serverAction";
import { PreviewBadge } from "@/shared/ui/v2/PreviewBadge";
import { normalizeEventSystemName } from "shared/lib/eventCatalog";
import { createEventAction, type DuplicateName } from "../model/actions";
import { eventDetailHref } from "../model/eventDetail";
import { EventAttributeTreeEditor } from "./EventAttributeTreeEditor";
import { useEventAttributeDraft } from "./useEventAttributeDraft";

const SAMPLE_PLACEHOLDER = '{\n  "product": {\n    "id": "SP-AD-0412",\n    "price": 1290000\n  },\n  "quantity": 1\n}';

// CAT-FR-02, CAT-FR-21: the workspace's vendor prefix. The tracking name starts with it, and the
// admin may still edit it (the lead's default 4 for the prefix).
export const VENDOR_PREFIX = "com.acme/";

/**
 * CAT-FR-01 to CAT-FR-03, CAT-FR-09, CAT-FR-18, CAT-FR-21: creates a person event. It offers no kind.
 * A failed create keeps every value in the form, and closing the dialog keeps them too until a create
 * succeeds. Success opens the new event's detail page. The dialog is at stage preview (SHL-FR-22).
 */
export function AddEventDialog() {
  const router = useRouter();
  const draft = useEventAttributeDraft();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(VENDOR_PREFIX);
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [duplicate, setDuplicate] = useState<DuplicateName["existing"] | null>(null);
  const [pending, startTransition] = useTransition();
  const storedName = normalizeEventSystemName(name.trim());
  const fieldsRead =
    draft.creationMode === "json" && draft.jsonError === "" && draft.jsonPayload.trim() !== "" ? draft.attributes.length : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const attributes = draft.toSave();
    if (attributes === null) return;
    startTransition(async () => {
      const result = await callServerAction(() =>
        createEventAction({
          name,
          displayName,
          description,
          attributes: attributes.map((attribute) => ({
            path: attribute.value,
            label: attribute.displayName,
            type: attribute.dataType,
            example: attribute.exampleValue,
          })),
        }),
      );
      if ("error" in result) {
        setError(result.error);
        setDuplicate("existing" in result ? result.existing : null);
        return;
      }
      router.push(eventDetailHref(result.eventId));
    });
  };

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button />}>
        <PlusIcon aria-hidden />
        Add event
        <PreviewBadge on="primary" />
      </DialogTrigger>
      <DialogPopup className="max-w-4xl">
        <form className="contents" onSubmit={submit}>
          <DialogHeader>
            <div className="flex items-center gap-2">
              <DialogTitle>Add event</DialogTitle>
              <PreviewBadge />
            </div>
            <DialogDescription>
              Tell Studio about an action your shop sends, so marketers can build journeys on it. Every new event is about one shopper and
              arrives with their id.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-5">
            {error !== "" && (
              <Alert role="alert" variant="error">
                <AlertDescription className="whitespace-pre-line">
                  {duplicate ? (
                    <>
                      <b>
                        Not added. The catalog already has <span className="font-mono">{duplicate.name}</span>.
                      </b>{" "}
                      Change the tracking name, or{" "}
                      <Link className="font-semibold underline underline-offset-4" href={eventDetailHref(duplicate.id)}>
                        open {duplicate.label}
                      </Link>{" "}
                      to add fields to it.
                    </>
                  ) : (
                    <>
                      <b>Not added.</b> {error}
                    </>
                  )}{" "}
                  Everything you typed is kept.
                </AlertDescription>
              </Alert>
            )}
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="add-event-name">Tracking name</Label>
                <Input
                  aria-describedby="add-event-name-stored"
                  autoComplete="off"
                  className="font-mono"
                  id="add-event-name"
                  onChange={(change) => setName(change.target.value)}
                  required
                  spellCheck={false}
                  value={name}
                />
                <div className="flex flex-col gap-0.5 text-muted-foreground text-xs" id="add-event-name-stored">
                  <span>
                    Saved as <span className="font-mono text-foreground">{storedName}</span>
                  </span>
                  <span>Must match what the website or app sends. It can&apos;t change later.</span>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="add-event-label">Name marketers see</Label>
                <Input
                  id="add-event-label"
                  onChange={(change) => setDisplayName(change.target.value)}
                  placeholder="Added to cart"
                  required
                  value={displayName}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="add-event-description">What it means (optional)</Label>
                <Input id="add-event-description" onChange={(change) => setDescription(change.target.value)} value={description} />
              </div>
            </div>
            <section aria-labelledby="add-event-fields" className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <h3 className="font-heading font-semibold text-sm" id="add-event-fields">
                  Fields
                </h3>
                <p className="text-muted-foreground text-xs">
                  Optional. Paste one real event and Studio reads each field and its type. You can adjust them before saving, and add more
                  later.
                </p>
              </div>
              <Tabs onValueChange={draft.changeMode} value={draft.creationMode}>
                <TabsList aria-label="How to add fields">
                  <TabsTab value="json">Paste a sample event</TabsTab>
                  <TabsTab value="manual">Build by hand</TabsTab>
                </TabsList>
                <TabsPanel className="flex flex-col gap-2 pt-3" value="json">
                  <Label htmlFor="add-event-sample">Sample event</Label>
                  <Textarea
                    aria-invalid={draft.jsonError !== ""}
                    className="min-h-48 font-mono text-xs"
                    id="add-event-sample"
                    onChange={(change) => draft.typePayload(change.target.value)}
                    placeholder={SAMPLE_PLACEHOLDER}
                    value={draft.jsonPayload}
                  />
                  {draft.jsonError !== "" ? (
                    <p className="text-destructive text-xs" role="alert">
                      <b>This isn&apos;t valid JSON.</b> {draft.jsonError} The fields are kept from your last valid sample.
                    </p>
                  ) : (
                    fieldsRead !== null && (
                      <p className="text-success text-xs">
                        Read {fieldsRead} {fieldsRead === 1 ? "field" : "fields"}. Open Build by hand to adjust them.
                      </p>
                    )
                  )}
                </TabsPanel>
                <TabsPanel className="flex flex-col gap-2 pt-3" value="manual">
                  <EventAttributeTreeEditor
                    attributes={draft.attributes}
                    onAdd={draft.add}
                    onChange={draft.change}
                    onDelete={draft.remove}
                    onRename={draft.rename}
                  />
                  {draft.treeError !== "" && (
                    <p className="text-destructive text-xs" role="alert">
                      {draft.treeError}
                    </p>
                  )}
                </TabsPanel>
              </Tabs>
              <p className="text-muted-foreground text-xs">
                Every field starts optional, and Strict checking starts off. You can change both on the event&apos;s page.
              </p>
            </section>
          </DialogPanel>
          <DialogFooter className="items-center">
            <span className="mr-auto text-muted-foreground text-xs">After saving, the event&apos;s page opens.</span>
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button disabled={pending || (draft.creationMode === "json" && draft.jsonError !== "")} type="submit">
              {pending ? "Adding…" : "Add event"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
