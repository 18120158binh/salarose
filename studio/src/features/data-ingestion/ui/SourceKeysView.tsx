"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import type { SourceKeySummary } from "@/lib/db";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { createSourceKeyAction, revokeSourceKeyAction } from "@/app/actions";
import { callServerAction } from "@/shared/lib/serverAction";

interface SourceKeysViewProps {
  keys: SourceKeySummary[];
}

export default function SourceKeysView({ keys }: SourceKeysViewProps) {
  const router = useRouter();
  const [appId, setAppId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<{ appId: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await callServerAction(() => createSourceKeyAction(appId));
    setBusy(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setNewKey({ appId: appId.trim(), key: result.key });
    setAppId("");
    router.refresh();
  }

  async function revoke(id: string) {
    setError(null);
    const result = await callServerAction(() => revokeSourceKeyAction(id));
    if ("error" in result) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Source keys</h1>
        <p className="text-sm text-muted-foreground">
          Each system that posts events to the data ingestion API sends its own key. A revoked key is refused at once.
        </p>
      </div>

      <form onSubmit={create} className="flex items-end gap-3">
        <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground flex-1">
          App id
          <Input
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            placeholder="inventory-service"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <Button type="submit" disabled={busy || !appId.trim()}>
          {busy ? "Creating…" : "Create key"}
        </Button>
      </form>

      {error && (
        <Alert variant="error" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {newKey && (
        <Alert variant="success" aria-live="polite">
          <AlertTitle>Key for {newKey.appId}</AlertTitle>
          <AlertDescription>
            <span>Copy it now. It is not shown again.</span>
            <code className="block break-all rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground">
              {newKey.key}
            </code>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="ps-4">App id</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right pe-4">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                    No source keys yet.
                  </TableCell>
                </TableRow>
              ) : (
                keys.map((key) => (
                  <TableRow key={key.id}>
                    <TableCell className="ps-4 font-semibold text-foreground">{key.appId}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{key.keyHint}…</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      <time dateTime={key.createdAt}>{new Date(key.createdAt).toLocaleString()}</time>
                    </TableCell>
                    <TableCell>
                      {key.revokedAt ? (
                        <Badge variant="secondary">Revoked</Badge>
                      ) : (
                        <Badge variant="success">Active</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right pe-4">
                      {!key.revokedAt && (
                        <AlertDialog>
                          <AlertDialogTrigger render={<Button variant="destructive-outline" size="sm" />}>
                            Revoke
                          </AlertDialogTrigger>
                          <AlertDialogPopup>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Revoke the key for {key.appId}?</AlertDialogTitle>
                              <AlertDialogDescription>
                                Requests with this key are refused from now on. To rotate it, create a new key for the same app id after this.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
                              <AlertDialogClose render={<Button variant="destructive" />} onClick={() => revoke(key.id)}>
                                Revoke
                              </AlertDialogClose>
                            </AlertDialogFooter>
                          </AlertDialogPopup>
                        </AlertDialog>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
