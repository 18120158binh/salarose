"use client";

import { Fragment, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { EllipsisIcon, PencilIcon, PlusIcon, ShieldAlertIcon, ShieldCheckIcon, ShieldXIcon, Trash2Icon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { callServerAction } from "@/shared/lib/serverAction";
import { SectionCard } from "@/shared/ui/v2/SectionCard";
import { notify } from "@/shared/ui/v2/toast";
import { EVENT_ATTRIBUTE_TYPES } from "shared/lib/eventCatalog";
import { addAttributesAction, deleteAttributeAction, setAttributeRequiredAction, updateAttributeAction } from "../model/actions";
import { classifyAddInside, classifyDelete, classifyFieldEdit, type FieldChangeKind } from "../model/eventAttributeChange";
import { jsonToEventAttributes } from "../model/eventAttributePayload";
import {
  attributeDepth,
  fieldTypeLabel,
  leafKey,
  renamedPath,
  usesCount,
  type EventDetailAttribute,
  type FieldUses,
} from "../model/eventDetail";

type Props = {
  readonly eventId: string;
  readonly eventLabel: string;
  readonly attributes: readonly EventDetailAttribute[];
  readonly fieldUses: Readonly<Record<string, FieldUses>>;
  readonly canEdit: boolean;
  readonly strict: boolean;
};

type BreakingChange = "rename" | "type" | "delete" | "group";

type Opened =
  | { readonly kind: "add"; readonly parent: string }
  | { readonly kind: "edit"; readonly attribute: EventDetailAttribute }
  | { readonly kind: "delete"; readonly attribute: EventDetailAttribute }
  | { readonly kind: "must"; readonly attribute: EventDetailAttribute }
  | { readonly kind: "refused"; readonly attribute: EventDetailAttribute; readonly change: BreakingChange }
  | null;

const TOP = "__top__";

function parentPath(path: string): string | null {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? null : path.slice(0, dot);
}

function TypeSelect({ id, value, onChange }: { id: string; value: string; onChange: (type: string) => void }) {
  return (
    <Select onValueChange={(next) => next && onChange(next)} value={value}>
      <SelectTrigger id={id}>
        <SelectValue>{fieldTypeLabel(value)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {EVENT_ATTRIBUTE_TYPES.map((type) => (
          <SelectItem key={type.value} value={type.value}>
            {fieldTypeLabel(type.value)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const KIND_LOOK: Record<FieldChangeKind, { word: string; icon: typeof ShieldCheckIcon; className: string }> = {
  safe: { word: "Safe change", icon: ShieldCheckIcon, className: "border-success/30 bg-success/5 text-success" },
  "asks-first": { word: "Asks first", icon: ShieldAlertIcon, className: "border-warning/30 bg-warning/5 text-warning" },
  breaking: { word: "Breaking change", icon: ShieldAlertIcon, className: "border-destructive/30 bg-destructive/5 text-destructive" },
  refused: { word: "Breaking, refused", icon: ShieldXIcon, className: "border-destructive/30 bg-destructive/5 text-destructive" },
};

/** CAT-FR-11: the kind of a change, shown before the save. */
export function FieldChangeBanner({ kind, children }: { kind: FieldChangeKind; children: ReactNode }) {
  const look = KIND_LOOK[kind];
  const Icon = look.icon;
  return (
    <div className={cn("flex items-start gap-2 rounded-control border px-3 py-2 text-xs", look.className)} data-kind={kind}>
      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <p className="text-foreground">
        <span className="font-semibold">{look.word}</span> · {children}
      </p>
    </div>
  );
}

function usesText(uses: FieldUses | undefined): string {
  const parts: string[] = [];
  const add = (count: number, one: string, many: string) => count > 0 && parts.push(`${count} ${count === 1 ? one : many}`);
  add(uses?.campaigns.length ?? 0, "journey", "journeys");
  add(uses?.metrics.length ?? 0, "metric", "metrics");
  add(uses?.segments.length ?? 0, "segment", "segments");
  return parts.join(" and ");
}

const REFUSED_TITLE: Record<BreakingChange, string> = {
  type: "can't change type while it's in use",
  rename: "can't be renamed while it's in use",
  delete: "can't be deleted while it's in use",
  group: "can't become a group while it's in use",
};

const REFUSED_WHY: Record<BreakingChange, string> = {
  type: "A new type would make every comparison on it fail.",
  rename: "Events with the old name would stop matching these conditions.",
  delete: "These would have nothing to read.",
  group: "A group has no single value, so these comparisons would fail.",
};

/** CAT-FR-11: a breaking change to a field in use changes nothing and offers the three steps of the safe way. */
function RefusedDialog({
  attribute,
  change,
  uses,
  message,
  onAddNew,
  onClose,
}: {
  attribute: EventDetailAttribute;
  change: BreakingChange;
  uses: FieldUses | undefined;
  message?: string;
  onAddNew: () => void;
  onClose: () => void;
}) {
  return (
    <AlertDialog onOpenChange={(open) => !open && onClose()} open>
      <AlertDialogPopup className="max-w-xl">
        <AlertDialogHeader>
          <p className="font-semibold text-destructive text-xs">Breaking change, refused while in use</p>
          <AlertDialogTitle>
            {attribute.label} {REFUSED_TITLE[change]}
          </AlertDialogTitle>
          <AlertDialogDescription>
            Nothing changed. {REFUSED_WHY[change]} These read <span className="font-mono">{attribute.path}</span> and would break:
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-3 px-6 text-sm">
          {message !== undefined && message !== "" ? (
            <p className="whitespace-pre-line text-muted-foreground text-xs">{message}</p>
          ) : (
            <ul aria-label="Uses" className="flex flex-col divide-y divide-border rounded-control border border-border">
              {uses?.campaigns.map((campaign) => (
                <li className="px-3 py-2" key={`c-${campaign.name}`}>
                  <span className="font-semibold text-muted-foreground text-xs">JOURNEY · {campaign.status.toUpperCase()}</span>{" "}
                  {campaign.name} <span className="text-muted-foreground">({campaign.nodeIds.length === 1 ? "step" : "steps"} {campaign.nodeIds.join(", ")})</span>
                </li>
              ))}
              {uses?.metrics.map((metric) => (
                <li className="px-3 py-2" key={`m-${metric.id}`}>
                  <span className="font-semibold text-muted-foreground text-xs">METRIC</span> {metric.displayName}
                </li>
              ))}
              {uses?.segments.map((segment) => (
                <li className="px-3 py-2" key={`s-${segment.id}`}>
                  <span className="font-semibold text-muted-foreground text-xs">SEGMENT</span> {segment.name}
                </li>
              ))}
            </ul>
          )}
          <div>
            <h3 className="mb-2 font-semibold text-muted-foreground text-xs tracking-wide">THE SAFE WAY</h3>
            <ol className="flex flex-col gap-2">
              <li className="flex gap-2">
                <span className="font-heading font-semibold">1</span>
                <span>
                  Add the new field next to the old one.{" "}
                  <Button onClick={onAddNew} size="sm" variant="link">
                    Add a new field
                  </Button>
                </span>
              </li>
              <li className="flex gap-2">
                <span className="font-heading font-semibold">2</span>
                <span>
                  Update the journeys, metrics, and segments that use the old one. A live journey can&apos;t be edited in place, so duplicate it,
                  point it at the new field, and swap them.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="font-heading font-semibold">3</span>
                <span>Remove the old field once nothing uses it. Its In use badge goes away when the last use is gone.</span>
              </li>
            </ol>
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button />}>Close</AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** A server refusal that names uses is a breaking change the page could not see coming. */
function isInUseRefusal(message: string): boolean {
  return message.includes("is in use, so it cannot be");
}

/** CAT-FR-04, CAT-FR-06, CAT-FR-11: the kind shows before the save; a breaking change asks first. */
function EditFieldDialog({
  eventId,
  attribute,
  uses,
  onRefused,
  onClose,
}: {
  eventId: string;
  attribute: EventDetailAttribute;
  uses: FieldUses | undefined;
  onRefused: (change: BreakingChange, message?: string) => void;
  onClose: () => void;
}) {
  const [key, setKey] = useState(leafKey(attribute.path));
  const [label, setLabel] = useState(attribute.label);
  const [type, setType] = useState(attribute.type);
  const [example, setExample] = useState(attribute.example ?? "");
  const [defaultValue, setDefaultValue] = useState(attribute.defaultValue ?? "");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const path = renamedPath(attribute.path, key);
  const count = usesCount(uses);
  const kind = classifyFieldEdit(attribute, { path, type }, count);
  const change: BreakingChange = type !== attribute.type ? "type" : "rename";

  const commit = () =>
    startTransition(async () => {
      const result = await callServerAction(() => updateAttributeAction(eventId, attribute.path, { path, label, type, example, defaultValue }));
      if ("error" in result) {
        if (isInUseRefusal(result.error)) onRefused(change, result.error);
        else setError(result.error);
        return;
      }
      notify({ kind: "done", title: "Saved" });
      onClose();
    });

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (kind === "refused") onRefused(change);
    else if (kind === "breaking") setConfirming(true);
    else commit();
  };

  const kindText: Record<FieldChangeKind, string> = {
    safe: "Label, example and if-missing value save at once.",
    "asks-first": "",
    refused: `${attribute.label} is in use by ${usesText(uses)}, so a new name or type will be refused. Save shows you the safe way.`,
    breaking: "Nothing uses it, so it can go ahead after you confirm. Events that still send the old form will no longer fit.",
  };

  return (
    <>
      <Dialog onOpenChange={(open) => !open && onClose()} open={!confirming}>
        <DialogPopup>
          <form className="contents" onSubmit={save}>
            <DialogHeader>
              <DialogTitle>Edit the field {attribute.label}</DialogTitle>
            </DialogHeader>
            <DialogPanel className="flex flex-col gap-4">
              {error !== "" && (
                <Alert role="alert" variant="error">
                  <AlertDescription className="whitespace-pre-line">{error}</AlertDescription>
                </Alert>
              )}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="field-key">Field name in the event</Label>
                <Input autoComplete="off" id="field-key" onChange={(next) => setKey(next.target.value)} required spellCheck={false} value={key} />
                <p className="text-muted-foreground text-xs">
                  Saved as <span className="font-mono text-foreground">{path}</span>. Renaming also moves every field inside it.
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="field-label">Label marketers see</Label>
                  <Input id="field-label" onChange={(next) => setLabel(next.target.value)} value={label} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="field-type">Type</Label>
                  <TypeSelect id="field-type" onChange={setType} value={type} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="field-example">Example</Label>
                  <Input id="field-example" onChange={(next) => setExample(next.target.value)} value={example} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="field-default">If missing, use</Label>
                  <Input id="field-default" onChange={(next) => setDefaultValue(next.target.value)} value={defaultValue} />
                </div>
              </div>
              <FieldChangeBanner kind={kind}>{kindText[kind]}</FieldChangeBanner>
            </DialogPanel>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="ghost" />}>Cancel</DialogClose>
              <Button disabled={pending} type="submit">
                {pending ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
      <AlertDialog onOpenChange={(open) => !open && setConfirming(false)} open={confirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <p className="font-semibold text-destructive text-xs">Breaking change · nothing uses it</p>
            <AlertDialogTitle>{change === "type" ? `Change the type of ${attribute.path}?` : `Rename ${attribute.path}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {change === "type"
                ? "Nothing uses it. Events that send the old type will no longer fit this event's fields. If Strict is on, they will be dropped."
                : "Nothing uses it. Events that still send the old name are accepted unchecked; the new name is checked from now on."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <AlertDialogClose onClick={commit} render={<Button variant="destructive" />}>
              {change === "type" ? "Change type" : "Rename field"}
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

type NewField = { readonly path: string; readonly label: string; readonly type: string; readonly example: string };

function sampleFields(sample: string, parent: string): NewField[] {
  let sequence = 0;
  const prefix = parent === "" ? "" : `${parent}.`;
  return jsonToEventAttributes(sample, [], () => `sample-${++sequence}`).map((field) => ({
    path: `${prefix}${field.value}`,
    label: field.displayName,
    type: field.dataType,
    example: field.exampleValue,
  }));
}

function labelFor(key: string): string {
  const text = key.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** CAT-FR-03, CAT-FR-19: a new field, inline in the tree, at the top level or inside any field. */
function AddFieldRow({
  eventId,
  attributes,
  fieldUses,
  initialParent,
  columns,
  onSafeWay,
  onClose,
}: {
  eventId: string;
  attributes: readonly EventDetailAttribute[];
  fieldUses: Readonly<Record<string, FieldUses>>;
  initialParent: string;
  columns: number;
  onSafeWay: (parent: EventDetailAttribute) => void;
  onClose: () => void;
}) {
  const [parent, setParent] = useState(initialParent);
  const [mode, setMode] = useState<"one" | "sample">("one");
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [type, setType] = useState("string");
  const [sample, setSample] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const parentField = attributes.find((attribute) => attribute.path === parent) ?? null;
  const kind = classifyAddInside(parentField, usesCount(fieldUses[parent]));
  const prefix = parent === "" ? "" : `${parent}.`;

  let fields: NewField[] = [];
  let sampleError = "";
  if (mode === "one") {
    fields = key.trim() === "" ? [] : [{ path: `${prefix}${key.trim()}`, label: label.trim() || labelFor(key.trim()), type, example: "" }];
  } else if (sample.trim() !== "") {
    try {
      fields = sampleFields(sample, parent);
    } catch (failure) {
      sampleError = failure instanceof Error ? failure.message : "The sample is not valid JSON.";
    }
  }

  const add = (event: FormEvent) => {
    event.preventDefault();
    if (kind === "refused" && parentField !== null) {
      onSafeWay(parentField);
      return;
    }
    startTransition(async () => {
      const result = await callServerAction(() => addAttributesAction(eventId, fields));
      if ("error" in result) {
        setError(result.error);
        return;
      }
      notify({ kind: "done", title: kind === "breaking" ? `${parent} is now a group. Field added.` : "Field added" });
      onClose();
    });
  };

  const parentLabel = parent === "" ? "the event" : parent;
  const saveLabel =
    kind === "breaking" ? "Make it a group and add field" : mode === "sample" && fields.length !== 1 ? `Add ${fields.length} fields` : "Add field";

  return (
    <tr className="bg-primary/5">
      <td className="px-4 py-3" colSpan={columns}>
        <form aria-label="New field" className="flex flex-col gap-3" onSubmit={add}>
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-semibold text-sm">New field</span>
            <span className="text-muted-foreground text-xs">{parent === "" ? "At the top level" : `Inside: ${parent}`}</span>
            <div aria-label="How to add" className="ml-auto flex gap-1 rounded-control bg-muted p-0.5" role="group">
              <Button aria-pressed={mode === "one"} onClick={() => setMode("one")} size="xs" type="button" variant={mode === "one" ? "outline" : "ghost"}>
                One field
              </Button>
              <Button aria-pressed={mode === "sample"} onClick={() => setMode("sample")} size="xs" type="button" variant={mode === "sample" ? "outline" : "ghost"}>
                Paste a sample
              </Button>
            </div>
          </div>
          {error !== "" && (
            <Alert role="alert" variant="error">
              <AlertDescription className="whitespace-pre-line">{error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-3 md:grid-cols-[170px_minmax(0,1.2fr)_minmax(0,1fr)_150px]">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-field-parent">Inside</Label>
              <Select onValueChange={(next) => setParent(next === TOP || next === null ? "" : next)} value={parent === "" ? TOP : parent}>
                <SelectTrigger id="new-field-parent">
                  <SelectValue>{parent === "" ? "Top level" : parent}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={TOP}>Top level</SelectItem>
                  {attributes.map((attribute) => (
                    <SelectItem key={attribute.path} value={attribute.path}>
                      {attribute.path}
                      {attribute.type === "json" ? "" : " (becomes a group)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {mode === "one" ? (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="new-field-key">Field name in the event</Label>
                  <Input autoComplete="off" id="new-field-key" onChange={(next) => setKey(next.target.value)} spellCheck={false} value={key} />
                  <p className="text-muted-foreground text-xs">
                    Saved as <span className="font-mono text-foreground">{prefix + (key.trim() || " ")}</span>
                  </p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="new-field-label">Label marketers see</Label>
                  <Input id="new-field-label" onChange={(next) => setLabel(next.target.value)} placeholder={labelFor(key.trim())} value={label} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="new-field-type">Type</Label>
                  <TypeSelect id="new-field-type" onChange={setType} value={type} />
                </div>
              </>
            ) : (
              <div className="flex flex-col gap-1.5 md:col-span-3">
                <Label htmlFor="new-field-sample">Paste what one event sends inside {parentLabel}</Label>
                <Textarea
                  aria-invalid={sampleError !== ""}
                  className="min-h-24 font-mono text-xs"
                  id="new-field-sample"
                  onChange={(next) => setSample(next.target.value)}
                  placeholder={'{ "size": "M", "color": "Đỏ" }'}
                  value={sample}
                />
                {sampleError !== "" ? (
                  <p className="text-destructive text-xs" role="alert">
                    {sampleError}
                  </p>
                ) : (
                  fields.length > 0 && (
                    <p className="text-muted-foreground text-xs">
                      Adds {fields.map((field) => `${field.path} (${fieldTypeLabel(field.type)})`).join(", ")}.
                    </p>
                  )
                )}
              </div>
            )}
          </div>
          {kind === "breaking" && (
            <FieldChangeBanner kind="breaking">
              nothing uses {parent}, so it can go ahead. {parent} will become a group of fields. Its current value type (
              {fieldTypeLabel(parentField?.type ?? "")}) goes away, and events that send {parent} as{" "}
              {fieldTypeLabel(parentField?.type ?? "").toLowerCase()} will no longer fit this event&apos;s fields. If Strict is on, they will be
              dropped.
            </FieldChangeBanner>
          )}
          {kind === "refused" && (
            <FieldChangeBanner kind="refused">
              {parent} is in use by {usesText(fieldUses[parent])}, so it can&apos;t become a group.{" "}
              <Button onClick={() => parentField && onSafeWay(parentField)} size="xs" type="button" variant="link">
                See the safe way
              </Button>
            </FieldChangeBanner>
          )}
          {kind === "safe" && (
            <FieldChangeBanner kind="safe">
              New fields start optional.{parentField !== null && !parentField.required ? ` Only checked when ${parent} is sent.` : ""}
            </FieldChangeBanner>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose} size="sm" type="button" variant="ghost">
              Cancel
            </Button>
            <Button disabled={pending || kind === "refused" || fields.length === 0 || sampleError !== ""} size="sm" type="submit">
              {pending ? "Adding…" : saveLabel}
            </Button>
          </div>
        </form>
      </td>
    </tr>
  );
}

/** CAT-FR-12: a field nothing uses is deleted with its subtree after a confirmation. */
function DeleteFieldDialog({
  eventId,
  attribute,
  onRefused,
  onClose,
}: {
  eventId: string;
  attribute: EventDetailAttribute;
  onRefused: (message: string) => void;
  onClose: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const remove = () =>
    startTransition(async () => {
      const result = await callServerAction(() => deleteAttributeAction(eventId, attribute.path));
      if ("error" in result) {
        if (isInUseRefusal(result.error)) onRefused(result.error);
        else notify({ kind: "failed", title: `${attribute.path} was not deleted.`, description: result.error });
        return;
      }
      notify({ kind: "done", title: `Deleted ${attribute.path}` });
      onClose();
    });
  return (
    <AlertDialog onOpenChange={(open) => !open && onClose()} open>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <p className="font-semibold text-destructive text-xs">Breaking change · nothing uses it</p>
          <AlertDialogTitle>Delete {attribute.path}?</AlertDialogTitle>
          <AlertDialogDescription>
            Nothing uses it. It leaves the field list and the journey builder, with every field inside it. Events that still send it are
            accepted; Studio just stops listing and checking it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          <Button disabled={pending} onClick={remove} variant="destructive">
            Delete field
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** CAT-FR-14: Must be sent asks first and names the senders it affects. */
function MustBeSentDialog({
  eventId,
  eventLabel,
  attribute,
  parent,
  strict,
  onClose,
}: {
  eventId: string;
  eventLabel: string;
  attribute: EventDetailAttribute;
  parent: EventDetailAttribute | null;
  strict: boolean;
  onClose: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const confirm = () =>
    startTransition(async () => {
      const result = await callServerAction(() => setAttributeRequiredAction(eventId, attribute.path, true));
      if ("error" in result) {
        notify({ kind: "failed", title: `${attribute.path} did not change.`, description: result.error });
        return;
      }
      notify({ kind: "done", title: `${attribute.path} is Must be sent now` });
      onClose();
    });
  const what = parent !== null ? `sends a ${parent.path} without ${leafKey(attribute.path)}` : `leaves out ${attribute.path}`;
  return (
    <AlertDialog onOpenChange={(open) => !open && onClose()} open>
      <AlertDialogPopup className="max-w-xl">
        <AlertDialogHeader>
          <p className="font-semibold text-warning text-xs">Asks first</p>
          <AlertDialogTitle>Make {attribute.path} Must be sent?</AlertDialogTitle>
          <AlertDialogDescription>
            {strict
              ? `Strict is on for ${eventLabel}. From the next few seconds, Studio drops every ${eventLabel} that ${what}, whoever sends it:`
              : `Strict is off for ${eventLabel}, so nothing is dropped yet. Once Strict is on, Studio drops every ${eventLabel} that ${what}, whoever sends it:`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-2 px-6 text-sm">
          <ul className="list-disc pl-5">
            <li>the website tracker</li>
            <li>the app</li>
            <li>any API source with a key</li>
          </ul>
          <p className="text-muted-foreground text-xs">
            {parent !== null && !parent.required
              ? `Only checked when ${parent.path} is sent: events with no ${parent.path} at all are not affected.`
              : `Every ${eventLabel} is checked.`}{" "}
            Studio can&apos;t count yet how many of today&apos;s events lack it. Ask your developer before you confirm.
          </p>
        </div>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel, keep it optional</AlertDialogClose>
          <Button disabled={pending} onClick={confirm}>
            Make it Must be sent
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** The Fields card of the detail page (CAT-FR-10, CAT-FR-11, CAT-FR-19, CAT-FR-20). */
export function EventAttributeTable({ eventId, eventLabel, attributes, fieldUses, canEdit, strict }: Props) {
  const [opened, setOpened] = useState<Opened>(null);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const [pending, startTransition] = useTransition();
  const close = () => {
    setOpened(null);
    setRefusal(undefined);
  };
  const byPath = new Map(attributes.map((attribute) => [attribute.path, attribute]));
  const columns = canEdit ? 6 : 5;

  const makeOptional = (attribute: EventDetailAttribute) =>
    startTransition(async () => {
      const result = await callServerAction(() => setAttributeRequiredAction(eventId, attribute.path, false));
      if ("error" in result) notify({ kind: "failed", title: `${attribute.path} did not change.`, description: result.error });
      else notify({ kind: "done", title: `Saved · ${attribute.path} is optional now` });
    });

  const remove = (attribute: EventDetailAttribute) =>
    setOpened(
      classifyDelete(usesCount(fieldUses[attribute.path])) === "refused"
        ? { kind: "refused", attribute, change: "delete" }
        : { kind: "delete", attribute },
    );

  const addRow =
    opened?.kind === "add" ? (
      <AddFieldRow
        attributes={attributes}
        columns={columns}
        eventId={eventId}
        fieldUses={fieldUses}
        initialParent={opened.parent}
        key={opened.parent}
        onClose={close}
        onSafeWay={(parent) => setOpened({ kind: "refused", attribute: parent, change: "group" })}
      />
    ) : null;
  const addAfter = opened?.kind === "add" && opened.parent !== "" ? opened.parent : null;
  const lastOfSubtree = (path: string) =>
    [...attributes].reverse().find((attribute) => attribute.path === path || attribute.path.startsWith(`${path}.`))?.path ?? path;
  const addRowAfterPath = addAfter === null ? null : lastOfSubtree(addAfter);

  return (
    <SectionCard
      actions={
        canEdit ? (
          <Button onClick={() => setOpened({ kind: "add", parent: "" })} size="sm">
            <PlusIcon aria-hidden />
            Add field
          </Button>
        ) : undefined
      }
      description={
        <>
          The details each {eventLabel} carries. Marketers pick these in journey conditions, like{" "}
          <span className="font-mono">product.price</span> over 1,000,000 ₫.
        </>
      }
      flush
      title="Fields"
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Fields</caption>
          <thead>
            <tr className="border-border border-b text-left text-muted-foreground text-xs">
              <th className="px-4 py-2 font-semibold" scope="col">
                Field
              </th>
              <th className="px-3 py-2 font-semibold" scope="col">
                Type
              </th>
              <th className="px-3 py-2 font-semibold" scope="col">
                Must be sent <span className="block font-normal">Checked while Strict is on</span>
              </th>
              <th className="px-3 py-2 font-semibold" scope="col">
                Example
              </th>
              <th className="px-3 py-2 font-semibold" scope="col">
                If missing
              </th>
              {canEdit && (
                <th className="px-3 py-2 text-right font-semibold" scope="col">
                  Change
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {attributes.length === 0 && opened?.kind !== "add" && (
              <tr>
                <td className="px-4 py-6 text-center text-muted-foreground" colSpan={columns}>
                  This event has no fields yet.
                </td>
              </tr>
            )}
            {attributes.map((attribute) => {
              const group = attribute.type === "json";
              const children = attributes.filter((other) => parentPath(other.path) === attribute.path).length;
              const count = usesCount(fieldUses[attribute.path]);
              const parent = byPath.get(parentPath(attribute.path) ?? "") ?? null;
              return (
                <Fragment key={attribute.path}>
                  <tr className="group/row border-border border-b last:border-b-0" data-path={attribute.path}>
                    <td className="py-2.5 pr-3" style={{ paddingInlineStart: `${1 + attributeDepth(attribute.path) * 1.5}rem` }}>
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{attribute.label}</span>
                        {group && (
                          <span className="rounded-full bg-muted px-2 text-[0.6875rem] text-muted-foreground">
                            {children === 1 ? "1 field" : `${children} fields`}
                          </span>
                        )}
                        {count > 0 && (
                          <span className="rounded-full bg-muted px-2 font-semibold text-[0.6875rem] text-muted-foreground">
                            In use · <span className="font-heading tabular-nums">{count}</span>
                          </span>
                        )}
                        {canEdit && (
                          <Button
                            aria-label={`Add field inside ${attribute.path}`}
                            className="opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100"
                            onClick={() => setOpened({ kind: "add", parent: attribute.path })}
                            size="icon-xs"
                            variant="ghost"
                          >
                            <PlusIcon aria-hidden />
                          </Button>
                        )}
                      </span>
                      <span className="block font-mono text-muted-foreground text-xs">{attribute.path}</span>
                    </td>
                    <td className="px-3 py-2.5">{fieldTypeLabel(attribute.type)}</td>
                    <td className="px-3 py-2.5">
                      {group ? null : (
                        <span className="flex flex-col">
                          <span className={attribute.required ? "font-semibold" : "text-muted-foreground"}>
                            {attribute.required ? "Must be sent" : "Optional"}
                          </span>
                          {attribute.required && parent !== null && !parent.required && (
                            <span className="text-muted-foreground text-xs">Only checked when {parent.path} is sent</span>
                          )}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {group ? (
                        <span className="text-muted-foreground text-xs">{children === 1 ? "Holds the field below" : "Holds the fields below"}</span>
                      ) : (
                        <span className="font-mono text-xs">{attribute.example || "—"}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">{attribute.defaultValue ? <span className="font-mono text-xs">{attribute.defaultValue}</span> : "None"}</td>
                    {canEdit && (
                      <td className="px-3 py-2.5 text-right">
                        <span className="inline-flex items-center gap-1">
                          <Button onClick={() => setOpened({ kind: "edit", attribute })} size="xs" variant="ghost">
                            <PencilIcon aria-hidden />
                            Edit
                          </Button>
                          <Menu>
                            <MenuTrigger render={<Button aria-label={`More changes to ${attribute.path}`} size="icon-xs" variant="ghost" />}>
                              <EllipsisIcon aria-hidden />
                            </MenuTrigger>
                            <MenuPopup align="end">
                              <MenuItem onClick={() => setOpened({ kind: "edit", attribute })}>Edit label, type, example…</MenuItem>
                              <MenuItem onClick={() => setOpened({ kind: "add", parent: attribute.path })}>Add field inside</MenuItem>
                              {!group && (
                                <MenuItem
                                  disabled={pending}
                                  onClick={() => (attribute.required ? makeOptional(attribute) : setOpened({ kind: "must", attribute }))}
                                >
                                  {attribute.required ? "Make it optional" : "Make it Must be sent"}
                                </MenuItem>
                              )}
                              <MenuItem onClick={() => remove(attribute)} variant="destructive">
                                <Trash2Icon aria-hidden />
                                Delete field
                                {count > 0 && <span className="ml-auto text-muted-foreground text-xs">In use</span>}
                              </MenuItem>
                            </MenuPopup>
                          </Menu>
                        </span>
                      </td>
                    )}
                  </tr>
                  {addRowAfterPath === attribute.path && addRow}
                </Fragment>
              );
            })}
            {addAfter === null && addRow}
          </tbody>
        </table>
      </div>
      <p className="px-4 pt-2.5 pb-3.5 text-muted-foreground text-xs">
        {canEdit && (
          <>
            Hover a row and press <b>+</b> to add a field inside it.{" "}
          </>
        )}
        Studio still accepts extra fields that aren&apos;t listed here; it just doesn&apos;t check them.
      </p>
      {opened?.kind === "edit" && (
        <EditFieldDialog
          attribute={opened.attribute}
          eventId={eventId}
          key={opened.attribute.path}
          onClose={close}
          onRefused={(change, message) => {
            setRefusal(message);
            setOpened({ kind: "refused", attribute: opened.attribute, change });
          }}
          uses={fieldUses[opened.attribute.path]}
        />
      )}
      {opened?.kind === "delete" && (
        <DeleteFieldDialog
          attribute={opened.attribute}
          eventId={eventId}
          onClose={close}
          onRefused={(message) => {
            setRefusal(message);
            setOpened({ kind: "refused", attribute: opened.attribute, change: "delete" });
          }}
        />
      )}
      {opened?.kind === "must" && (
        <MustBeSentDialog
          attribute={opened.attribute}
          eventId={eventId}
          eventLabel={eventLabel}
          onClose={close}
          parent={byPath.get(parentPath(opened.attribute.path) ?? "") ?? null}
          strict={strict}
        />
      )}
      {opened?.kind === "refused" && (
        <RefusedDialog
          attribute={opened.attribute}
          change={opened.change}
          message={refusal}
          onAddNew={() => {
            setRefusal(undefined);
            setOpened({ kind: "add", parent: parentPath(opened.attribute.path) ?? "" });
          }}
          onClose={close}
          uses={fieldUses[opened.attribute.path]}
        />
      )}
    </SectionCard>
  );
}
