"use client";

import { useState, useTransition, type FormEvent } from "react";
import { CopyIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";
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
import { callServerAction } from "@/shared/lib/serverAction";
import { notify } from "@/shared/ui/v2/toast";
import { createSourceKeyAction } from "../model/actions";

type Created = { readonly appId: string; readonly key: string };

// DHL-FR-04, DIA-FR-16: the new key lives only in this dialog's state. Closing the dialog drops it,
// so the page holds no copy afterwards and nothing can show it again.
export function CreateSourceKeyDialog() {
  const [open, setOpen] = useState(false);
  const [appId, setAppId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [pending, startTransition] = useTransition();

  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (next) return;
    setCreated(null);
    setAppId("");
    setError(null);
  };

  const create = (event: FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await callServerAction(() => createSourceKeyAction(appId));
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setError(null);
      setCreated(result);
    });
  };

  const copy = async (key: string) => {
    try {
      await navigator.clipboard.writeText(key);
      notify({ kind: "done", title: "Copied" });
    } catch {
      notify({ kind: "failed", title: "The key could not be copied.", description: "Select it and copy it by hand." });
    }
  };

  return (
    <Dialog onOpenChange={changeOpen} open={open}>
      <DialogTrigger render={<Button />}>
        <PlusIcon aria-hidden />
        Create key
      </DialogTrigger>
      <DialogPopup>
        {created === null ? (
          <form className="contents" onSubmit={create}>
            <DialogHeader>
              <DialogTitle>Create a source key</DialogTitle>
              <DialogDescription>Each system that posts events sends its own key. A source has one active key at a time.</DialogDescription>
            </DialogHeader>
            <DialogPanel className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="source-key-app-id">Source name (app id)</Label>
                <Input
                  aria-describedby="source-key-app-id-hint"
                  autoComplete="off"
                  id="source-key-app-id"
                  onChange={(event) => setAppId(event.target.value)}
                  placeholder="inventory-service"
                  spellCheck={false}
                  value={appId}
                />
                <p className="text-muted-foreground text-xs" id="source-key-app-id-hint">
                  A short name for the sending system, like <span className="font-mono">order-service</span>. Every event sent with the key
                  carries it, so you can trace where data came from.
                </p>
              </div>
              {error !== null && (
                <Alert role="alert" variant="error">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </DialogPanel>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="ghost" />}>Cancel</DialogClose>
              <Button disabled={pending || appId.trim() === ""} type="submit">
                {pending ? "Creating…" : "Create key"}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Key for {created.appId}</DialogTitle>
            </DialogHeader>
            <DialogPanel className="flex flex-col gap-3">
              <Alert variant="warning">
                <TriangleAlertIcon aria-hidden />
                <AlertDescription>
                  <span>
                    <b>You will not see this key again.</b> Copy it now and store it in the sending system. If it&apos;s lost, revoke it and
                    create a new one.
                  </span>
                </AlertDescription>
              </Alert>
              <code aria-label="New source key" className="block break-all rounded-md bg-muted px-3 py-2 font-mono text-sm">
                {created.key}
              </code>
            </DialogPanel>
            <DialogFooter>
              <Button onClick={() => void copy(created.key)} type="button" variant="outline">
                <CopyIcon aria-hidden />
                Copy
              </Button>
              <DialogClose render={<Button type="button" />}>Done</DialogClose>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}
