"use client";

import { CircleAlertIcon, CircleCheckIcon, InfoIcon, LoaderCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import type { Checklist } from "../model/checklist";

/**
 * Where a publish stands once the marketer opened the review dialog. `busy` covers saving the
 * last edits and then the publish call. Each refusal of the publish action has its own state.
 */
export type PublishFlow =
  | { kind: "closed" }
  | { kind: "review" }
  | { kind: "busy"; asNewJourney: boolean }
  | { kind: "collision" }
  | { kind: "missing" }
  | { kind: "stale" }
  | { kind: "failed"; message: string };

export interface ReviewDialogProps {
  name: string;
  summary: string;
  checklist: Checklist;
  flow: PublishFlow;
  /** Why publish can't start even with no blocking problem, such as an unsaved edit. */
  unsavedReason: string | null;
  onPublish: (asNewJourney: boolean) => void;
  onShowChecklist: () => void;
  onLoadLatest: () => void;
  onClose: () => void;
}

// JBD-FR-25, JBD-FR-27, CMP-FR-12: the review dialog of the JourneyPublish board, and the outcomes
// of the publish action that the contract's Publish section names.
export function ReviewDialog({ name, summary, checklist, flow, unsavedReason, onPublish, onShowChecklist, onLoadLatest, onClose }: ReviewDialogProps) {
  const blocked = checklist.blocks > 0;
  const busy = flow.kind === "busy";
  const why = blocked ? `Fix the blocking problem${checklist.blocks === 1 ? "" : "s"} first.` : unsavedReason;

  return (
    <Dialog onOpenChange={(open) => !open && !busy && onClose()} open={flow.kind !== "closed"}>
      <DialogPopup className="max-w-xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Publish “{name}”?</DialogTitle>
          <DialogDescription>{summary}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4 text-sm">
          <Outcome flow={flow} onLoadLatest={onLoadLatest} />
          <section>
            <h3 className="mb-2 font-semibold">Checks before publishing</h3>
            <ul className="space-y-1.5">
              {checklist.missingEvents.length === 0 ? (
                <Check passed>
                  Every event the journey uses is in your events{checklist.knownEvents.length > 0 ? `: ${checklist.knownEvents.join(", ")}` : ""}.
                </Check>
              ) : (
                <Check passed={false}>Not in your events: {checklist.missingEvents.join(", ")}.</Check>
              )}
              {blocked ? (
                <Check passed={false}>
                  <span className="font-heading tabular-nums">{checklist.blocks}</span> problem{checklist.blocks === 1 ? "" : "s"} in the checklist{" "}
                  {checklist.blocks === 1 ? "blocks" : "block"} publishing.{" "}
                  <button className="font-semibold text-primary underline" onClick={onShowChecklist} type="button">
                    Show checklist
                  </button>
                </Check>
              ) : (
                <Check passed>
                  Nothing in the checklist blocks publishing.
                  {checklist.warnings > 0 &&
                    ` ${checklist.warnings} warning${checklist.warnings === 1 ? "" : "s"} won't stop it.`}
                </Check>
              )}
            </ul>
          </section>
          <section>
            <h3 className="mb-1 font-semibold">Counts that start updating when you publish</h3>
            <p className="text-muted-foreground text-xs">Studio keeps these per customer so the journey can test them. You don&apos;t set them up.</p>
            <p className="mt-2 inline-flex items-center gap-1.5 text-muted-foreground">
              <InfoIcon aria-hidden className="size-3.5" />
              This list is not available yet.
            </p>
          </section>
          <p>
            People who do the trigger event after you publish start this journey within seconds. A published journey can&apos;t be edited. To
            change it later, duplicate it.
          </p>
        </DialogPanel>
        <DialogFooter className="items-center">
          {why && !busy && (
            <span className="me-auto text-muted-foreground text-xs" id="publish-why">
              {why}
            </span>
          )}
          <Button disabled={busy} onClick={onClose} variant="outline">
            Cancel
          </Button>
          {flow.kind === "collision" ? (
            <Button onClick={() => onPublish(true)}>Publish as a new journey</Button>
          ) : (
            <Button aria-describedby={why ? "publish-why" : undefined} disabled={busy || why !== null || flow.kind === "missing" || flow.kind === "stale"} onClick={() => onPublish(false)}>
              {busy && <LoaderCircleIcon aria-hidden className="animate-spin" />}
              {busy ? "Publishing" : "Publish journey"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function Check({ passed, children }: { passed: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      {passed ? (
        <span className="inline-flex w-16 shrink-0 items-center gap-1 font-semibold text-success text-xs">
          <CircleCheckIcon aria-hidden className="size-3" />
          Passed
        </span>
      ) : (
        <span className="inline-flex w-16 shrink-0 items-center gap-1 font-semibold text-destructive text-xs">
          <CircleAlertIcon aria-hidden className="size-3" />
          Failed
        </span>
      )}
      <span>{children}</span>
    </li>
  );
}

function Outcome({ flow, onLoadLatest }: { flow: PublishFlow; onLoadLatest: () => void }) {
  const alert = (title: string, body: React.ReactNode, action?: React.ReactNode) => (
    <div className="flex flex-wrap items-start gap-2 rounded-control border border-destructive/25 bg-destructive/8 p-3" role="alert">
      <CircleAlertIcon aria-hidden className="mt-0.5 size-4 text-destructive" />
      <div className="flex-1">
        <b className="text-destructive">{title}</b>
        {body && <p className="text-muted-foreground">{body}</p>}
      </div>
      {action}
    </div>
  );
  switch (flow.kind) {
    case "collision":
      return alert("A journey with this id was published somewhere else.", "Nothing was published. You can publish this draft as a new journey with its own id.");
    case "missing":
      return alert("This draft no longer exists.", "It was deleted or published somewhere else. Nothing was published.");
    case "stale":
      return alert(
        "This draft changed somewhere else.",
        "Another tab or computer saved it after you opened it. Nothing was published. Load the latest version, review it, and publish again.",
        <Button onClick={onLoadLatest} size="sm" variant="outline">
          Load latest
        </Button>,
      );
    case "failed":
      return alert(flow.message, null);
    default:
      return null;
  }
}
