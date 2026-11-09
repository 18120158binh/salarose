"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useOptimistic, useState, useTransition, type FormEvent } from "react";
import { PencilIcon } from "lucide-react";
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
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { callServerAction } from "@/shared/lib/serverAction";
import { SectionCard } from "@/shared/ui/v2/SectionCard";
import { notify } from "@/shared/ui/v2/toast";
import { deleteEventAction, setEventGateAction, setEventStatusAction, updateEventDetailsAction } from "../model/actions";

type Result = { done: true } | { error: string };

// A switch that shows the change at once and falls back to the stored value when the save fails,
// since the page's props only change after a save that worked (CAT-FR-13 failure handling).
function useStoredSwitch(stored: boolean, save: (next: boolean) => Promise<Result>, failed: string, done: (next: boolean) => string) {
  const [shown, show] = useOptimistic(stored);
  const [pending, startTransition] = useTransition();
  const change = (next: boolean) =>
    startTransition(async () => {
      show(next);
      const result = await callServerAction(() => save(next));
      if ("error" in result) notify({ kind: "failed", title: failed, description: result.error });
      else notify({ kind: "done", title: done(next) });
    });
  return { shown, pending, change };
}

function OnOff({ on, onWord, offWord }: { on: boolean; onWord: string; offWord: string }) {
  return <span className="font-semibold text-xs">{on ? onWord : offWord}</span>;
}

/** CAT-FR-05: Show in the journey builder. Off is status inactive, shown as Hidden from builder. */
export function BuilderCard({ id, label, active, canEdit }: { id: string; label: string; active: boolean; canEdit: boolean }) {
  const { shown, pending, change } = useStoredSwitch(
    active,
    (next) => setEventStatusAction(id, next ? "active" : "inactive"),
    "The builder setting did not change.",
    (next) => (next ? "Shown in the builder again" : "Hidden from builder. Journeys keep working."),
  );
  return (
    <SectionCard
      actions={
        <span className="flex items-center gap-2">
          {canEdit && <Switch aria-label="Show in the journey builder" checked={shown} disabled={pending} onCheckedChange={change} />}
          <OnOff offWord="Hidden" on={shown} onWord="Shown" />
        </span>
      }
      description={
        shown
          ? "On. Marketers can pick it when they build journeys and segments."
          : "Off. Hidden from builder: marketers can no longer pick it for new steps."
      }
      title="Show in the journey builder"
    >
      <div className="rounded-control bg-muted px-3 py-2 text-xs">
        <p className="font-semibold">Hiding it does not stop anything</p>
        <p className="text-muted-foreground">
          Journeys, segments and metrics that already use {label} keep working. Tracking and Strict checking stay the same. Only new picks in
          the builder and segment editor go away.
        </p>
      </div>
    </SectionCard>
  );
}

/** CAT-FR-13: Strict checking. Turning it on asks first; turning it off applies at once. */
export function StrictCard({
  id,
  label,
  on,
  required,
  canEdit,
  monitoringHref,
}: {
  id: string;
  label: string;
  on: boolean;
  required: readonly string[];
  canEdit: boolean;
  monitoringHref: string | null;
}) {
  const [confirming, setConfirming] = useState(false);
  const { shown, pending, change } = useStoredSwitch(
    on,
    (next) => setEventGateAction(id, next),
    "Strict checking did not change.",
    (next) => (next ? "Strict is on" : `Strict is off. Every ${label} is accepted.`),
  );
  return (
    <SectionCard
      actions={
        <span className="flex items-center gap-2">
          {canEdit && (
            <Switch
              aria-label="Strict checking"
              checked={shown}
              disabled={pending}
              onCheckedChange={(next) => (next ? setConfirming(true) : change(false))}
            />
          )}
          <OnOff offWord="Off" on={shown} onWord="On" />
        </span>
      }
      description={
        shown
          ? `On. ${label} events that miss a Must be sent field or send the wrong type are dropped.`
          : `Off. Every ${label} is accepted, whatever it holds.`
      }
      title="Strict checking"
    >
      <div className="flex flex-col gap-1.5 rounded-control bg-muted px-3 py-2 text-xs">
        <p className="font-semibold">With Strict on, for example</p>
        <p>
          <span className="font-semibold text-success">Accepted</span> <span className="font-mono">&quot;price&quot;: 1290000</span>
        </p>
        <p>
          <span className="font-semibold text-destructive">Dropped</span> <span className="font-mono">&quot;price&quot;: &quot;1290000&quot;</span>{" "}
          <span className="text-muted-foreground">text, not a number</span>
        </p>
        <p>
          <span className="font-semibold text-destructive">Dropped</span> <span className="text-muted-foreground">A product with no price</span>
        </p>
      </div>
      {monitoringHref !== null && (
        <Link className="mt-2 font-semibold text-primary text-xs hover:underline" href={monitoringHref}>
          See this event in Monitoring
        </Link>
      )}
      <AlertDialog onOpenChange={setConfirming} open={confirming}>
        <AlertDialogPopup className="max-w-xl">
          <AlertDialogHeader>
            <p className="font-semibold text-warning text-xs">Asks first</p>
            <AlertDialogTitle>Turn on Strict checking for {label}?</AlertDialogTitle>
            <AlertDialogDescription>From the next few seconds, Studio drops every {label}, from any sender, that:</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-2 px-6 text-sm">
            <ul className="list-disc pl-5">
              {required.length > 0 ? (
                <li>
                  is missing a Must be sent field: <span className="font-mono">{required.join(", ")}</span>, or
                </li>
              ) : (
                <li>is missing a Must be sent field (none yet), or</li>
              )}
              <li>sends a field with the wrong type, like a price written as text.</li>
            </ul>
            <p className="text-muted-foreground text-xs">
              Dropped events are not kept for your journeys. Journeys, segments and metrics never see them, and Studio does not put them back
              later. Dropped events are kept for 7 days in Monitoring › Dropped data, then deleted.
            </p>
          </div>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel, keep accepting all</AlertDialogClose>
            <AlertDialogClose onClick={() => change(true)} render={<Button />}>
              Turn on Strict
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SectionCard>
  );
}

/** CAT-FR-11: the three kinds of field change. */
export function FieldChangeRulesCard() {
  const rules = [
    { word: "Safe", className: "text-success", text: "Label, example, if-missing value, a new optional field, Must be sent → optional. Saves at once." },
    { word: "Asks first", className: "text-warning", text: "Optional → Must be sent, and turning Strict on. Says which events would be dropped." },
    {
      word: "Breaking",
      className: "text-destructive",
      text: "Rename, delete, change type, make a group, move. Refused while a journey, metric or segment uses it; otherwise asks first.",
    },
  ];
  return (
    <SectionCard description="Every change to a field is one of three kinds. The edit form shows the kind before you save." title="Field change rules">
      <dl className="flex flex-col gap-2 text-xs">
        {rules.map((rule) => (
          <div className="grid grid-cols-[5.5rem_1fr] gap-2" key={rule.word}>
            <dt className={`font-semibold ${rule.className}`}>{rule.word}</dt>
            <dd className="text-muted-foreground">{rule.text}</dd>
          </div>
        ))}
      </dl>
    </SectionCard>
  );
}

/** CAT-FR-05: the display name and the description. The tracking name stays. A failed save keeps what the admin typed. */
export function EditEventDetailsDialog({
  id,
  label,
  description,
  trackingName,
}: {
  id: string;
  label: string;
  description: string | null;
  trackingName: string;
}) {
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState(label);
  const [text, setText] = useState(description ?? "");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const changeOpen = (next: boolean) => {
    if (next) {
      setDisplayName(label);
      setText(description ?? "");
      setError("");
    }
    setOpen(next);
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await callServerAction(() => updateEventDetailsAction(id, displayName, text));
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
      notify({ kind: "done", title: "Saved" });
    });
  };

  return (
    <Dialog onOpenChange={changeOpen} open={open}>
      <DialogTrigger render={<Button variant="outline" />}>
        <PencilIcon aria-hidden />
        Edit name and description
      </DialogTrigger>
      <DialogPopup>
        <form className="contents" onSubmit={save}>
          <DialogHeader>
            <DialogTitle>Edit name and description</DialogTitle>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            {error !== "" && (
              <Alert role="alert" variant="error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="event-display-name">Name marketers see</Label>
              <Input id="event-display-name" onChange={(change) => setDisplayName(change.target.value)} required value={displayName} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="event-description">What it means and who sends it</Label>
              <Textarea id="event-description" onChange={(change) => setText(change.target.value)} value={text} />
            </div>
            <p className="text-muted-foreground text-xs">
              The tracking name <span className="font-mono text-foreground">{trackingName}</span> can&apos;t change, because the website and app send
              it.
            </p>
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
  );
}

// How a journey uses the event: a step's trigger names it, or a step checks a metric on it.
export type EventCampaignUseKind = "trigger" | "metric";

export type EventUseSummary = {
  readonly metrics: readonly { readonly id: string; readonly displayName: string; readonly measure: string }[];
  readonly campaigns: readonly {
    readonly id: string;
    readonly name: string;
    readonly status: string;
    readonly kinds: readonly EventCampaignUseKind[];
  }[];
  readonly segments: readonly { readonly id: string; readonly name: string; readonly description: string }[];
};

/**
 * CAT-FR-08: retire (hide) is recommended. Delete is refused while the event has a metric
 * definition or any use; the server refuses it again in the same transaction as the delete.
 */
export function RetireOrDeleteCard({ id, label, active, uses }: { id: string; label: string; active: boolean; uses: EventUseSummary }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<"none" | "confirm" | "refused">("none");
  const [refusal, setRefusal] = useState("");
  const [pending, startTransition] = useTransition();
  const blocked = uses.metrics.length > 0 || uses.campaigns.length > 0 || uses.segments.length > 0;

  const retire = () =>
    startTransition(async () => {
      const result = await callServerAction(() => setEventStatusAction(id, "inactive"));
      if ("error" in result) notify({ kind: "failed", title: `${label} was not hidden.`, description: result.error });
      else notify({ kind: "done", title: "Retired: hidden from builder. Metrics and history kept." });
      setDialog("none");
    });

  const remove = () =>
    startTransition(async () => {
      const result = await callServerAction(() => deleteEventAction(id));
      if ("error" in result) {
        setRefusal(result.error);
        setDialog("refused");
        return;
      }
      notify({ kind: "done", title: `Deleted ${label}` });
      router.push("/v2/data/events");
    });

  return (
    <SectionCard className="border-destructive/25" title="Retire or delete">
      <div className="flex flex-col gap-4 text-xs">
        <div className="flex flex-col items-start gap-1.5">
          <p className="font-semibold text-sm">
            Retire this event <span className="ml-1 rounded-full bg-primary/10 px-2 font-semibold text-[0.6875rem] text-primary">Recommended</span>
          </p>
          <p className="text-muted-foreground">Hide it from the builder and keep its metrics and history. Journeys that use it keep running.</p>
          <Button disabled={pending || !active} onClick={retire} size="sm" variant="outline">
            {active ? "Hide from builder" : "Hidden from builder"}
          </Button>
        </div>
        <div className="flex flex-col items-start gap-1.5">
          <p className="font-semibold text-sm">Delete this event</p>
          <p className="text-muted-foreground">
            Only possible for an event with no metrics and no uses.
            {uses.metrics.length > 0 &&
              ` ${label} has ${uses.metrics.length === 1 ? "1 metric" : `${uses.metrics.length} metrics`}, which are kept for history and never deleted, so it can only be hidden.`}
          </p>
          <Button disabled={pending} onClick={() => setDialog(blocked ? "refused" : "confirm")} size="sm" variant="destructive-outline">
            Delete event…
          </Button>
        </div>
      </div>
      <AlertDialog onOpenChange={(open) => !open && setDialog("none")} open={dialog === "confirm"}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {label}?</AlertDialogTitle>
            <AlertDialogDescription>Nothing uses it and it has no metrics. The event and its fields are deleted.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <Button disabled={pending} onClick={remove} variant="destructive">
              Delete event
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog onOpenChange={(open) => !open && setDialog("none")} open={dialog === "refused"}>
        <AlertDialogPopup className="max-w-xl">
          <AlertDialogHeader>
            <p className="font-semibold text-destructive text-xs">Can&apos;t delete</p>
            <AlertDialogTitle>{label} can&apos;t be deleted</AlertDialogTitle>
            <AlertDialogDescription>Nothing changed.</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-3 px-6 text-sm">
            {refusal !== "" ? (
              <p className="whitespace-pre-line text-muted-foreground text-xs">{refusal}</p>
            ) : (
              <>
                {uses.metrics.length > 0 && (
                  <div>
                    <p>This event has metrics:</p>
                    <ul className="list-disc pl-5">
                      {uses.metrics.map((metric) => (
                        <li key={metric.id}>{metric.displayName}</li>
                      ))}
                    </ul>
                    <p className="text-muted-foreground text-xs">Metrics are kept for history and are never deleted. Hide this event from the builder to retire it.</p>
                  </div>
                )}
                {(uses.campaigns.length > 0 || uses.segments.length > 0) && (
                  <div>
                    <p className="font-semibold text-muted-foreground text-xs tracking-wide">IT IS ALSO USED BY</p>
                    <ul className="list-disc pl-5">
                      {uses.campaigns.map((campaign) => (
                        <li key={campaign.id}>
                          {campaign.name} ({campaign.status})
                        </li>
                      ))}
                      {uses.segments.map((segment) => (
                        <li key={segment.id}>{segment.name} (segment)</li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
            <p className="text-muted-foreground text-xs">
              Hiding keeps every journey running and every metric&apos;s history. Only an event with no metrics and no uses can be deleted.
            </p>
          </div>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Close</AlertDialogClose>
            {active && (
              <Button disabled={pending} onClick={retire}>
                Hide from builder
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SectionCard>
  );
}
