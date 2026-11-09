"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Segment, SegmentUse } from "shared/lib/segments";
import type { UserEventDef } from "shared/types";
import { emptySegmentDraft, segmentDraft, segmentInput, type SegmentDraft } from "../model/segmentDraft";
import { SegmentEditorDialog } from "./SegmentEditorDialog";

type SaveResult = { success: true; id: string } | { confirm: SegmentUse[] } | { error: string };
type DeleteResult = { success: true } | { error: string };

export interface SegmentsViewProps {
  segments: Segment[];
  events: UserEventDef[];
  saveSegment: (input: unknown, confirmedCampaignIds: string[]) => Promise<SaveResult>;
  deleteSegment: (id: string) => Promise<DeleteResult>;
}

function campaignLines(uses: SegmentUse[]): string {
  return uses.map((use) => `${use.campaignName} (${use.status})`).join(", ");
}

export function SegmentsView({ segments, events, saveSegment, deleteSegment }: SegmentsViewProps) {
  const router = useRouter();
  const [editing, setEditing] = useState<{ draft: SegmentDraft; usedBy: SegmentUse[] } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toConfirm, setToConfirm] = useState<SegmentUse[] | null>(null);
  const [toDelete, setToDelete] = useState<Segment | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const openEditor = (draft: SegmentDraft, usedBy: SegmentUse[]) => {
    setSaveError(null);
    setEditing({ draft, usedBy });
  };

  // Saving keeps the dialog and what was typed until the server accepts the segment.
  const save = async (confirmed: SegmentUse[]) => {
    if (!editing) return;
    setSaving(true);
    try {
      const result = await saveSegment(segmentInput(editing.draft), confirmed.map((use) => use.campaignId));
      if ("confirm" in result) {
        setEditing({ ...editing, usedBy: result.confirm });
        setToConfirm(result.confirm);
      } else if ("error" in result) {
        setSaveError(result.error);
      } else {
        setEditing(null);
        router.refresh();
      }
    } catch {
      setSaveError("Failed to save the segment.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (segment: Segment) => {
    setDeleteError(null);
    try {
      const result = await deleteSegment(segment.id);
      if ("error" in result) setDeleteError(result.error);
      else router.refresh();
    } catch {
      setDeleteError("Failed to delete the segment.");
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-8 py-10">
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-3xl font-semibold tracking-tight">Segments</h1>
          <p className="text-muted-foreground">
            Saved groups of people that campaigns start on and test against.
          </p>
        </div>
        <Button onClick={() => openEditor(emptySegmentDraft(), [])}>
          <Plus /> New segment
        </Button>
      </div>

      {deleteError && (
        <Alert variant="error">
          <AlertDescription>{deleteError}</AlertDescription>
        </Alert>
      )}

      {segments.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No segments yet</EmptyTitle>
            <EmptyDescription>Create one to use it as a campaign trigger or condition.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Used by</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {segments.map((segment) => (
              <TableRow key={segment.id}>
                <TableCell className="font-medium">{segment.name}</TableCell>
                <TableCell className="max-w-sm truncate text-muted-foreground">{segment.description}</TableCell>
                <TableCell>
                  {segment.usedBy.length === 0 ? (
                    <span className="text-muted-foreground">No campaigns</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {segment.usedBy.map((use) => (
                        <Badge key={use.campaignId} variant="outline">{use.campaignName} · {use.status}</Badge>
                      ))}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => openEditor(segmentDraft(segment), segment.usedBy)}>
                      Edit
                    </Button>
                    <Button variant="destructive-outline" size="sm" onClick={() => setToDelete(segment)}>
                      Delete
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {editing && (
        <SegmentEditorDialog
          open
          draft={editing.draft}
          usedBy={editing.usedBy}
          events={events}
          error={saveError}
          saving={saving}
          onDraftChange={(draft) => setEditing({ ...editing, draft })}
          onSave={() => save([])}
          onOpenChange={(open) => !open && setEditing(null)}
        />
      )}

      <AlertDialog open={toConfirm !== null} onOpenChange={(open) => !open && setToConfirm(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Change a segment that active campaigns use?</AlertDialogTitle>
            <AlertDialogDescription>
              The change applies to the next evaluation in {campaignLines(toConfirm ?? [])}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <AlertDialogClose render={<Button />} onClick={() => toConfirm && save(toConfirm)}>
              Save change
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <AlertDialog open={toDelete !== null} onOpenChange={(open) => !open && setToDelete(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {toDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>You cannot undo this.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <AlertDialogClose render={<Button variant="destructive" />} onClick={() => toDelete && remove(toDelete)}>
              Delete
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
