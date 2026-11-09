"use client";

import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";
import { EllipsisIcon, PlusIcon, RouteIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { loadDrafts } from "@/app/campaign/draftStore";
import { useJourneyLifecycle, type LifecycleTarget } from "@/features/journeys/ui/lifecycle";
import { formatCount, formatTimestamp } from "@/shared/lib/format";
import { zoneLabel, type TimeZone } from "@/shared/lib/time-range";
import { DataTable, type Column } from "@/shared/ui/v2/DataTable";
import { StatusBadge, type StatusTone } from "@/shared/ui/v2/StatusBadge";
import { RegionEmpty } from "@/shared/ui/v2/states";
import { journeyDraftHref, journeyHref, type Viewer } from "@/widgets/v2-shell/model/routes";
import {
  DEFAULT_QUERY,
  draftRows,
  OWNER_FILTERS,
  rowActions,
  SORTS,
  STATUS_FILTERS,
  statusCounts,
  statusOf,
  visibleJourneys,
  type DraftJourney,
  type JourneyRow,
  type JourneySort,
  type JourneyStatus,
  type ListQuery,
  type OwnerFilter,
  type PublishedJourney,
  type PublishedStatus,
  type StatusFilter,
} from "../model/journeyList";

const STATUS: Record<JourneyStatus, { tone: StatusTone; label: string }> = {
  draft: { tone: "neutral", label: "Draft" },
  active: { tone: "success", label: "Active" },
  paused: { tone: "warning", label: "Paused" },
};

const OWNER_LABELS = { mine: "Mine", all: "All" } as const satisfies Record<OwnerFilter, string>;
const STATUS_LABELS = { any: "Any status", draft: "Draft", active: "Active", paused: "Paused" } as const satisfies Record<StatusFilter, string>;
const SORT_LABELS = { updated: "Last change", name: "Name", entries: "Entries" } as const satisfies Record<JourneySort, string>;

/** Create journey for a viewer whom the v2 create page does not let through yet. */
export const CLASSIC_CREATE_HREF = "/campaign/new";

// Browser storage exists only after hydration. Before it, the list shows the server's rows.
const subscribeNever = () => () => {};
function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
}

// A server draft opens in the v2 builder, and a browser draft in the classic builder that keeps it
// (JBD-FR-18). A published journey opens its page.
function rowHref(row: JourneyRow, viewer: Viewer): string | null {
  if (row.kind === "published") return journeyHref(row, viewer);
  return row.source === "server" ? journeyDraftHref(row.id) : `/campaign/${encodeURIComponent(row.id)}`;
}

const rowKey = (row: JourneyRow) => `${row.kind}:${row.id}`;

function Muted({ children }: { children: string }) {
  return <span className="text-muted-foreground">{children}</span>;
}

function columns(viewerEmail: string, now: number, zone: TimeZone): readonly [Column<JourneyRow>, ...Column<JourneyRow>[]] {
  return [
    {
      id: "name",
      header: "Name",
      cell: (row) => (
        <span className="flex flex-col gap-0.5">
          <span className="font-medium">{row.name}</span>
          {row.kind === "draft" && row.note && <span className="text-muted-foreground text-xs">{row.note}</span>}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: (row) => {
        const status = STATUS[statusOf(row)];
        return <StatusBadge tone={status.tone}>{status.label}</StatusBadge>;
      },
    },
    {
      id: "owner",
      header: "Owner",
      cell: (row) => {
        if (row.kind === "draft") return <Muted>{viewerEmail}</Muted>;
        if (row.ownerEmail !== null) return <Muted>{row.ownerEmail}</Muted>;
        return (
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">No owner</span>
            <span className="text-muted-foreground text-xs">The owner&apos;s account was removed</span>
          </span>
        );
      },
    },
    {
      id: "entries",
      header: "Entries, last 7 days",
      kind: "number",
      cell: (row) => (row.kind === "draft" ? <Muted>Not published</Muted> : <span className="font-heading">{formatCount(row.entries)}</span>),
    },
    {
      id: "updated",
      header: "Updated",
      cell: (row) => {
        if (row.updatedAt === null) return <Muted>Unknown</Muted>;
        const changed = formatTimestamp(row.updatedAt, now, zone);
        return (
          <time className="whitespace-nowrap text-muted-foreground" title={changed.exact}>
            {changed.text}
          </time>
        );
      },
    },
  ];
}

function emptyMessage(query: ListQuery): string {
  if (query.owner === "mine" && query.status === "any" && query.search.trim() === "") {
    return "You own no journey. Pick All to see your colleagues' journeys.";
  }
  return "No journey matches the search and filters.";
}

function ownerNote(owner: OwnerFilter, viewer: Viewer): string {
  if (owner === "all") return "All shows every published journey. Drafts show only under Mine.";
  return viewer.role === "admin"
    ? "Mine shows your journeys, your drafts, and journeys with no owner."
    : "Mine shows your journeys and your drafts.";
}

function pick<T extends string>(options: readonly T[], value: readonly unknown[], set: (next: T) => void): void {
  const next = options.find((option) => option === value[0]);
  if (next) set(next);
}

function target(row: JourneyRow): LifecycleTarget {
  return { kind: row.kind, id: row.id, name: row.name };
}

function NoJourneyYet({ createHref }: { createHref: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-card border border-border bg-card px-6 py-14 text-center">
      <span className="flex size-11 items-center justify-center rounded-tile bg-muted text-muted-foreground">
        <RouteIcon aria-hidden className="size-5" />
      </span>
      <h2 className="font-heading font-semibold text-[1.0625rem]">No journey yet. Create one to start.</h2>
      <p className="max-w-md text-balance text-muted-foreground text-sm">
        Start blank, describe it in a sentence, or pick a template like Abandoned cart or Welcome series. Nothing is sent until you
        publish.
      </p>
      <Button render={<Link href={createHref} />}>
        <PlusIcon aria-hidden />
        Create journey
      </Button>
    </div>
  );
}

export interface JourneyListProps {
  published: readonly PublishedJourney[];
  /** The viewer's rows of `journey_drafts`, empty for a viewer the v2 builder does not let through. */
  drafts: readonly DraftJourney[];
  viewer: Viewer;
  viewerEmail: string;
  now: number;
  zone: TimeZone;
  /** The v2 builder lets the viewer through, so Duplicate can open the copy. */
  canBuild: boolean;
  createHref: string;
}

// JBD-FR-18, CMP-FR-08: the published journeys and the viewer's drafts, searchable, filterable, and
// sortable, each with the lifecycle actions the viewer may take.
export function JourneyList({ published, drafts, viewer, viewerEmail, now, zone, canBuild, createHref }: JourneyListProps) {
  const [query, setQuery] = useState<ListQuery>(DEFAULT_QUERY);
  const [statuses, setStatuses] = useState<ReadonlyMap<string, PublishedStatus>>(new Map());
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const hydrated = useHydrated();
  const lifecycle = useJourneyLifecycle({
    onStatus: (id, status) => setStatuses((current) => new Map(current).set(id, status)),
    onDeleted: (deleted) => setGone((current) => new Set(current).add(`${deleted.kind}:${deleted.id}`)),
  });

  const rows = useMemo<JourneyRow[]>(() => {
    const browser = hydrated ? draftRows(loadDrafts(viewer.userId), published) : [];
    const serverIds = new Set(drafts.map((draft) => draft.id));
    return [
      ...published.map((row) => ({ ...row, status: statuses.get(row.id) ?? row.status })),
      ...drafts,
      ...browser.filter((draft) => !serverIds.has(draft.id)),
    ].filter((row) => !gone.has(rowKey(row)));
  }, [hydrated, published, drafts, viewer.userId, statuses, gone]);

  if (rows.length === 0) return <NoJourneyYet createHref={createHref} />;

  const shown = visibleJourneys(rows, query, viewer);
  const counts = statusCounts(rows, query, viewer);
  const update = (change: Partial<ListQuery>) => setQuery((current) => ({ ...current, ...change }));
  const allHint = query.owner === "mine" && query.status === "any" && query.search.trim() === "";

  return (
    <>
      <DataTable
        columns={columns(viewerEmail, now, zone)}
        empty={
          <RegionEmpty
            action={
              allHint ? (
                <Button onClick={() => update({ owner: "all" })} size="sm" variant="outline">
                  Show All
                </Button>
              ) : undefined
            }
            icon={RouteIcon}
            message={emptyMessage(query)}
          />
        }
        footer={
          <div className="flex flex-col gap-0.5 text-muted-foreground text-xs">
            <span>
              Showing <span className="font-heading tabular-nums">{formatCount(shown.length)}</span> journeys · {ownerNote(query.owner, viewer)}
            </span>
            <span>Entries count people who started the journey. Times in {zoneLabel(zone)}.</span>
          </div>
        }
        label="Journeys"
        open={{ kind: "link", href: (row) => rowHref(row, viewer) }}
        rowActions={(row) => <RowMenu canBuild={canBuild} href={rowHref(row, viewer)} lifecycle={lifecycle} row={row} viewer={viewer} />}
        rowKey={rowKey}
        rows={shown}
        toolbar={
          <>
            <InputGroup className="w-64 max-w-full">
              <InputGroupAddon>
                <SearchIcon aria-hidden />
              </InputGroupAddon>
              <InputGroupInput
                aria-label="Search journeys"
                onChange={(event) => update({ search: event.target.value })}
                placeholder="Search by name"
                type="search"
                value={query.search}
              />
            </InputGroup>
            <ToggleGroup
              aria-label="Owner"
              onValueChange={(value) => pick(OWNER_FILTERS, value, (owner) => update({ owner }))}
              size="sm"
              value={[query.owner]}
              variant="outline"
            >
              {OWNER_FILTERS.map((option) => (
                <ToggleGroupItem key={option} value={option}>
                  {OWNER_LABELS[option]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <ToggleGroup
              aria-label="Status"
              onValueChange={(value) => pick(STATUS_FILTERS, value, (status) => update({ status }))}
              size="sm"
              value={[query.status]}
              variant="outline"
            >
              {STATUS_FILTERS.map((option) => (
                <ToggleGroupItem key={option} value={option}>
                  {STATUS_LABELS[option]}
                  <span className="font-heading text-muted-foreground tabular-nums">{counts[option]}</span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <div className="flex items-center gap-2 sm:ms-auto">
              <span className="text-muted-foreground text-xs" id="journey-sort">
                Sort by
              </span>
              <ToggleGroup
                aria-labelledby="journey-sort"
                onValueChange={(value) => pick(SORTS, value, (sort) => update({ sort }))}
                size="sm"
                value={[query.sort]}
                variant="outline"
              >
                {SORTS.map((option) => (
                  <ToggleGroupItem key={option} value={option}>
                    {SORT_LABELS[option]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          </>
        }
      />
      {lifecycle.dialog}
    </>
  );
}

function RowMenu({
  row,
  viewer,
  canBuild,
  href,
  lifecycle,
}: {
  row: JourneyRow;
  viewer: Viewer;
  canBuild: boolean;
  href: string | null;
  lifecycle: ReturnType<typeof useJourneyLifecycle>;
}) {
  const actions = rowActions(row, viewer, canBuild);
  const label = `Actions for ${row.name}`;
  return (
    <Menu>
      <MenuTrigger render={<Button aria-label={label} size="icon-sm" variant="ghost" />}>
        <EllipsisIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="end" aria-label={label}>
        {actions.map((action) => {
          switch (action) {
            case "open":
              return href === null ? null : (
                <MenuItem key={action} render={<Link href={href} />}>
                  Open
                </MenuItem>
              );
            case "duplicate":
              return (
                <MenuItem key={action} onClick={() => void lifecycle.duplicate(target(row))}>
                  Duplicate
                </MenuItem>
              );
            case "pause":
              return (
                <MenuItem key={action} onClick={() => void lifecycle.pause(target(row))}>
                  Pause
                </MenuItem>
              );
            case "resume":
              return (
                <MenuItem key={action} onClick={() => void lifecycle.resume(target(row))}>
                  Resume
                </MenuItem>
              );
            case "delete":
              return [
                <MenuSeparator key="separator" />,
                <MenuItem key={action} onClick={() => lifecycle.askDelete(target(row))} variant="destructive">
                  Delete
                </MenuItem>,
              ];
          }
        })}
      </MenuPopup>
    </Menu>
  );
}
