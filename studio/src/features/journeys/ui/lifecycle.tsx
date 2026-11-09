"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
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
import { formatCount } from "@/shared/lib/format";
import { notify } from "@/shared/ui/v2/toast";
import { journeyDraftHref } from "@/widgets/v2-shell/model/routes";
import {
  deleteDraftAction,
  deleteJourneyAction,
  duplicateJourneyAction,
  pauseJourneyAction,
  peopleInJourneyAction,
  resumeJourneyAction,
} from "../model/actions";

/** The journey or draft an action works on. */
export interface LifecycleTarget {
  readonly kind: "published" | "draft";
  readonly id: string;
  readonly name: string;
}

export interface LifecycleEvents {
  /** Pause and resume update the row or the header in place (CMP-FR-08). */
  onStatus: (id: string, status: "active" | "paused") => void;
  onDeleted: (target: LifecycleTarget) => void;
}

const failed = (title: string, error: string) => notify({ kind: "failed", title, description: error });

// CMP-FR-04 to CMP-FR-09: the lifecycle actions of the journey list and a journey's page. Each ends
// in a toast. Pause is one click, and its toast offers Undo, which resumes.
export function useJourneyLifecycle({ onStatus, onDeleted }: LifecycleEvents) {
  const router = useRouter();
  const [toDelete, setToDelete] = useState<LifecycleTarget | null>(null);

  async function resume(target: LifecycleTarget): Promise<void> {
    const result = await resumeJourneyAction(target.id);
    if ("error" in result) return void failed(`“${target.name}” could not resume.`, result.error);
    onStatus(target.id, "active");
    notify({ kind: "done", title: `Resumed “${target.name}”.` });
  }

  async function pause(target: LifecycleTarget): Promise<void> {
    const result = await pauseJourneyAction(target.id);
    if ("error" in result) return void failed(`“${target.name}” could not pause.`, result.error);
    onStatus(target.id, "paused");
    notify({
      kind: "action",
      title: `Paused “${target.name}”. Nobody new enters it.`,
      action: { label: "Undo", onClick: () => void resume(target) },
    });
  }

  async function duplicate(target: LifecycleTarget): Promise<void> {
    const result = await duplicateJourneyAction(target.id);
    if ("error" in result) return void failed(`“${target.name}” could not be duplicated.`, result.error);
    if ("status" in result) return void failed(`“${target.name}” could not be duplicated.`, "It is no longer published.");
    router.push(journeyDraftHref(result.id));
  }

  async function remove(target: LifecycleTarget): Promise<void> {
    const result = target.kind === "draft" ? await deleteDraftAction(target.id) : await deleteJourneyAction(target.id);
    if ("error" in result) return void failed(`“${target.name}” could not be deleted.`, result.error);
    onDeleted(target);
    notify({ kind: "done", title: `Deleted “${target.name}”.` });
  }

  const dialog = (
    <DeleteDialog
      onClose={() => setToDelete(null)}
      onConfirm={(target) => {
        setToDelete(null);
        void remove(target);
      }}
      target={toDelete}
    />
  );

  return { pause, resume, duplicate, askDelete: setToDelete, dialog };
}

type People = { state: "loading" } | { state: "known"; people: number } | { state: "failed" };

// CMP-FR-19: the people waiting in the journey, counted when the dialog opens.
function usePeople(target: LifecycleTarget | null): People {
  const [found, setFound] = useState<{ id: string; people: People } | null>(null);
  const id = target?.kind === "published" ? target.id : null;
  useEffect(() => {
    if (id === null) return;
    let current = true;
    void peopleInJourneyAction(id).then((result) => {
      if (current) setFound({ id, people: "error" in result ? { state: "failed" } : { state: "known", people: result.people } });
    });
    return () => {
      current = false;
    };
  }, [id]);
  return found !== null && found.id === id ? found.people : { state: "loading" };
}

function PeopleLine({ people }: { people: People }): ReactNode {
  switch (people.state) {
    case "loading":
      return "Counting the people in this journey…";
    case "failed":
      return "The number of people in this journey could not load.";
    case "known":
      return (
        <>
          <b className="font-heading tabular-nums">{formatCount(people.people)}</b> {people.people === 1 ? "person is" : "people are"} in
          this journey. They will leave it.
        </>
      );
  }
}

function DeleteDialog({
  target,
  onClose,
  onConfirm,
}: {
  target: LifecycleTarget | null;
  onClose: () => void;
  onConfirm: (target: LifecycleTarget) => void;
}) {
  const people = usePeople(target);
  const draft = target?.kind === "draft";
  return (
    <AlertDialog onOpenChange={(open) => !open && onClose()} open={target !== null}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{target?.name}”?</AlertDialogTitle>
          {draft ? (
            <AlertDialogDescription>This draft was never published, so nobody is in it. Deleting it is final.</AlertDialogDescription>
          ) : (
            <AlertDialogDescription render={<div />}>
              <p>
                <PeopleLine people={people} />
              </p>
              <p className="mt-2">
                The journey and its steps are removed and no more messages go out. Its analytics history is kept. This can&apos;t be
                undone. To stop it for a while, pause it instead.
              </p>
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          <Button onClick={() => target && onConfirm(target)} variant="destructive">
            {draft ? "Delete draft" : "Delete journey"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
