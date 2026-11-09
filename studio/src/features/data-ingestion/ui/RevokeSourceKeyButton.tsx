"use client";

import { useTransition } from "react";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { callServerAction } from "@/shared/lib/serverAction";
import { notify } from "@/shared/ui/v2/toast";
import { revokeSourceKeyAction } from "../model/actions";

/** DHL-FR-04, DIA-FR-17: revoking asks first, in a dialog that names the app id. */
export function RevokeSourceKeyButton({ id, appId }: { id: string; appId: string }) {
  const [pending, startTransition] = useTransition();

  const revoke = () =>
    startTransition(async () => {
      const result = await callServerAction(() => revokeSourceKeyAction(id));
      if ("error" in result) notify({ kind: "failed", title: `The key for ${appId} was not revoked.`, description: result.error });
      else notify({ kind: "done", title: `Revoked the key for ${appId}` });
    });

  return (
    <AlertDialog>
      <AlertDialogTrigger
        aria-label={`Revoke the key for ${appId}`}
        render={<Button disabled={pending} size="sm" variant="destructive-outline" />}
      >
        Revoke
      </AlertDialogTrigger>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke the key for {appId}?</AlertDialogTitle>
          <AlertDialogDescription>
            <b>Requests with this key will be refused</b>, from the next request on. Events it sends after that are lost unless the system
            retries with a new key.
          </AlertDialogDescription>
          <p className="text-muted-foreground text-sm">
            To rotate it, create a new key for <span className="font-mono">{appId}</span> after this and put it in the sending system.
          </p>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          <AlertDialogClose onClick={revoke} render={<Button variant="destructive" />}>
            Revoke key
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
