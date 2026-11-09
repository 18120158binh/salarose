"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { PlusIcon, SearchIcon, UsersIcon } from "lucide-react";
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
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { DataTable, type Column } from "@/shared/ui/v2/DataTable";
import { PreviewBadge } from "@/shared/ui/v2/PreviewBadge";
import { StatusBadge } from "@/shared/ui/v2/StatusBadge";
import { RegionEmpty } from "@/shared/ui/v2/states";
import { notify } from "@/shared/ui/v2/toast";
import { deleteSegmentV2Action } from "../model/actions";
import {
  FILTER_LABELS,
  filterCounts,
  filterSegments,
  segmentEditHref,
  USE_FILTERS,
  USE_KIND_LABELS,
  type JourneyUse,
  type SegmentRow,
  type UseFilter,
} from "../model/segmentList";

const STATUS = {
  active: { tone: "success", label: "Active" },
  paused: { tone: "warning", label: "Paused" },
} as const;

// SEG-FR-08: no Size column until the runtime registry holds size from tracked members.
export const SIZE_NOT_STORED = "Size shows once membership is stored";

const COLUMNS: readonly [Column<SegmentRow>, ...Column<SegmentRow>[]] = [
  {
    id: "name",
    header: "Segment",
    cell: (row) => (
      <span className="flex max-w-sm flex-col gap-1">
        <span className="font-medium">{row.name}</span>
        {row.description && <span className="text-muted-foreground text-xs">{row.description}</span>}
      </span>
    ),
  },
  { id: "used-by", header: "Used by", cell: (row) => <WhereUsed uses={row.usedBy} /> },
  { id: "creator", header: "Created by", cell: (row) => <span className="text-muted-foreground">{row.creator}</span> },
  {
    id: "changed",
    header: "Last change",
    cell: (row) =>
      row.lastChange ? (
        <time className="whitespace-nowrap text-muted-foreground" title={row.lastChange.exact}>
          {row.lastChange.text}
        </time>
      ) : (
        <span className="text-muted-foreground">Unknown</span>
      ),
  },
];

export function WhereUsed({ uses }: { uses: readonly JourneyUse[] }) {
  if (uses.length === 0) return <span className="text-muted-foreground">Not used by any journey</span>;
  return (
    <ul className="flex flex-col gap-2 py-1.5">
      {uses.map((use) => (
        <li className="flex flex-wrap items-center gap-x-2 gap-y-1" key={use.campaignId}>
          {use.href ? (
            <Link
              className="rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              href={use.href}
            >
              {use.campaignName}
            </Link>
          ) : (
            <span className="font-medium">{use.campaignName}</span>
          )}
          <StatusBadge tone={STATUS[use.status].tone}>{STATUS[use.status].label}</StatusBadge>
          <span className="text-muted-foreground text-xs">{use.kinds.map((kind) => USE_KIND_LABELS[kind]).join(", ")}</span>
        </li>
      ))}
    </ul>
  );
}

function journeyCount(count: number): string {
  return count === 1 ? "1 journey uses" : `${count} journeys use`;
}

// SEG-FR-04: a used segment's delete is refused and names each journey. An unused one is asked
// once, then deleted.
function DeleteDialog({ target, onClose }: { target: SegmentRow | null; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const refused = target !== null && target.usedBy.length > 0;

  const confirm = () => {
    if (!target) return;
    startTransition(async () => {
      const result = await deleteSegmentV2Action(target.id);
      if ("error" in result) {
        notify({ kind: "failed", title: "The segment was not deleted.", description: result.error });
      } else {
        notify({ kind: "done", title: `${target.name} deleted.` });
        router.refresh();
      }
      onClose();
    });
  };

  return (
    <AlertDialog onOpenChange={(open) => !open && onClose()} open={target !== null}>
      <AlertDialogPopup>
        {target && refused && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>“{target.name}” can&apos;t be deleted yet</AlertDialogTitle>
              <AlertDialogDescription>
                {journeyCount(target.usedBy.length)} it. Delete is blocked while an active or paused journey uses a
                segment. Take it out of these journeys first, then delete it.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="px-6 pb-2">
              <WhereUsed uses={target.usedBy} />
            </div>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button />}>OK</AlertDialogClose>
            </AlertDialogFooter>
          </>
        )}
        {target && !refused && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete “{target.name}”?</AlertDialogTitle>
              <AlertDialogDescription>
                No journey uses it. Studio deletes the segment and the list of shoppers stored for it. You can&apos;t
                undo this.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
              <Button disabled={pending} onClick={confirm} variant="destructive">
                Delete segment
              </Button>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogPopup>
    </AlertDialog>
  );
}

export interface SegmentListProps {
  rows: readonly SegmentRow[];
  // A segment to mark, such as the one picked in the command palette (SHL-FR-07).
  selected?: string;
  // The viewer may reach the editor, which is at stage preview (SEG-FR-01, SHL-FR-22).
  canEdit: boolean;
  // The classic page that manages segments for the viewer's role, until cutover.
  classicHref: string;
}

// SEG-FR-01, SEG-FR-09: every segment with where it is used, searchable and filterable, with Edit
// and Delete for viewers who may reach the editor.
export function SegmentList({ rows, selected, canEdit, classicHref }: SegmentListProps) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<UseFilter>("all");
  const [deleting, setDeleting] = useState<SegmentRow | null>(null);
  const shown = filterSegments(rows, search, filter);
  const counts = filterCounts(rows);

  if (rows.length === 0) {
    return (
      <div className="rounded-card border border-border bg-card">
        <RegionEmpty
          action={
            canEdit ? (
              <Button render={<Link href="/v2/segments/new" />}>
                <PlusIcon aria-hidden />
                New segment
                <PreviewBadge on="primary" />
              </Button>
            ) : (
              <Button render={<Link href={classicHref} />} variant="outline">
                Create one in the classic studio
              </Button>
            )
          }
          icon={UsersIcon}
          message="No segments yet. A segment saves a group of shoppers under a name, like “Shoppers in Hà Nội who added to cart twice this week”, so any journey can start from it or check it."
        />
      </div>
    );
  }

  return (
    <>
      <DataTable
        columns={COLUMNS}
        empty={
          <RegionEmpty icon={UsersIcon} message="No segment matches the search and filter. Clear the search or pick All." />
        }
        footer={
          <p className="px-4 py-3 text-muted-foreground text-xs">
            Showing <span className="font-heading tabular-nums">{shown.length}</span> of{" "}
            <span className="font-heading tabular-nums">{rows.length}</span> segments, sorted by name
          </p>
        }
        label="Segments"
        rowActions={
          canEdit
            ? (row) => (
                <span className="flex items-center justify-end gap-1">
                  <Button render={<Link href={segmentEditHref(row.id)} />} size="sm" variant="ghost">
                    Edit
                  </Button>
                  <Button aria-label={`Delete ${row.name}`} onClick={() => setDeleting(row)} size="sm" variant="ghost">
                    Delete
                  </Button>
                </span>
              )
            : undefined
        }
        rowKey={(row) => row.id}
        rows={shown}
        selectedKey={selected}
        toolbar={
          <>
            <InputGroup className="w-72 max-w-full">
              <InputGroupAddon>
                <SearchIcon aria-hidden />
              </InputGroupAddon>
              <InputGroupInput
                aria-label="Search segments"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search segments"
                type="search"
                value={search}
              />
            </InputGroup>
            <ToggleGroup
              aria-label="Show segments"
              onValueChange={(value) => {
                const next = USE_FILTERS.find((option) => option === value[0]);
                if (next) setFilter(next);
              }}
              size="sm"
              value={[filter]}
              variant="outline"
            >
              {USE_FILTERS.map((option) => (
                <ToggleGroupItem aria-label={FILTER_LABELS[option]} key={option} value={option}>
                  {FILTER_LABELS[option]}
                  <span className="font-heading text-muted-foreground tabular-nums">{counts[option]}</span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <span className="ml-auto text-muted-foreground text-xs">{SIZE_NOT_STORED}</span>
          </>
        }
      />
      <DeleteDialog onClose={() => setDeleting(null)} target={deleting} />
    </>
  );
}
