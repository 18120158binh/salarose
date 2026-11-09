"use client";

import { useState, useTransition } from "react";
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
import { callServerAction } from "@/shared/lib/serverAction";
import { notify } from "@/shared/ui/v2/toast";
import { requestPersonDeletionAction } from "../../model/privacyActions";

const FIELD = "h-8 min-w-0 flex-1 rounded-control border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** DIM-FR-23: the key goes to the server once, after the admin confirms. Studio keeps only its tombstone. */
export function DeletePersonForm() {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();

  const submit = () =>
    startTransition(async () => {
      const result = await callServerAction(() => requestPersonDeletionAction(key));
      if ("error" in result) {
        notify({ kind: "failed", title: "The deletion was not requested.", description: result.error });
        return;
      }
      if (result.status === "not_configured") {
        notify({ kind: "failed", title: "The deletion was not requested.", description: "The tombstone key is not configured." });
        return;
      }
      notify({ kind: "done", title: `Deletion requested · code ${result.code}` });
      setKey("");
      router.refresh();
    });

  return (
    <>
      <form
        className="flex flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (key.trim() !== "") setConfirming(true);
        }}
      >
        <label className="mb-1 font-semibold text-xs" htmlFor="customer-key">
          Customer key
        </label>
        <div className="flex gap-2.5">
          <input autoComplete="off" className={FIELD} id="customer-key" onChange={(event) => setKey(event.target.value)} value={key} />
          <Button disabled={pending || key.trim() === ""} type="submit" variant="destructive-outline">
            Delete imported data
          </Button>
        </div>
        <p className="mt-1.5 text-muted-foreground text-xs">
          The shop&apos;s customer id, exactly as your datasets send it, like <span className="font-mono">KH100482</span> or a phone number.
        </p>
      </form>
      <AlertDialog onOpenChange={setConfirming} open={confirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete imported data for {key}?</AlertDialogTitle>
            <AlertDialogDescription render={<div />}>
              <ul className="flex list-disc flex-col gap-1 pl-4.5">
                <li>Their rows in every dataset are deleted.</li>
                <li>Segments and journeys stop seeing their imported values after the next nightly pass.</li>
                <li>Any later file with this customer key is rejected for this person.</li>
                <li>This can&apos;t be undone. Website tracking and journeys are not deleted.</li>
              </ul>
              <p className="mt-2.5 text-xs">If Studio holds no imported data for this key, the request is still kept, so later files are rejected.</p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <AlertDialogClose onClick={submit} render={<Button variant="destructive" />}>
              Delete imported data
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
