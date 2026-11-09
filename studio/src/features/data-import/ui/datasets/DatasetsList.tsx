import Link from "next/link";
import { DatabaseIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatCount, formatDateTime, NOT_AVAILABLE } from "@/shared/lib/format";
import type { TimeZone } from "@/shared/lib/time-range";
import { DataTable, type Column } from "@/shared/ui/v2/DataTable";
import { KpiCard, KpiRow } from "@/shared/ui/v2/KpiCard";
import { SectionCard } from "@/shared/ui/v2/SectionCard";
import { StatusBadge } from "@/shared/ui/v2/StatusBadge";
import { RegionEmpty } from "@/shared/ui/v2/states";
import { DATASET_KINDS, RUN_STATE_LABELS, type DatasetKind, type StatusTone as RunTone } from "../../model/domain";
import {
  datasetHref,
  DELIVERY_MODE_LABELS,
  KIND_FILTER_LABELS,
  KIND_LABELS,
  LOW_MATCH_RATE,
  RUN_SOURCE_LABELS,
  type DatasetOverview,
  type DatasetSummary,
  type LastRun,
} from "../../model/datasets";
import type { StatusTone } from "@/shared/ui/v2/StatusBadge";

export const RUN_TONE: Record<RunTone, StatusTone> = { ok: "success", warn: "warning", bad: "error", info: "info", off: "neutral" };

export type KindFilter = DatasetKind | "all";

export function parseKindFilter(value: unknown): KindFilter {
  return value === "profile" || value === "event" ? value : "all";
}

const STORED_ROWS_REASON = "Stored rows live in the import store, which Studio does not read yet.";

function LastFile({ run, zone }: { run: LastRun | null; zone: TimeZone }) {
  if (run === null) return <span className="text-muted-foreground text-xs">No file yet</span>;
  const { label, tone } = RUN_STATE_LABELS[run.state];
  return (
    <span className="flex flex-col gap-0.5">
      <StatusBadge tone={RUN_TONE[tone]}>{label}</StatusBadge>
      <span className="text-muted-foreground text-xs">{formatDateTime(run.at, zone)}</span>
    </span>
  );
}

export function MatchRate({ rate }: { rate: number | null }) {
  if (rate === null) return <span className="text-muted-foreground text-xs">n/a</span>;
  const percent = Math.round(rate * 100);
  return (
    <span className="flex flex-col items-end gap-1">
      <span className="flex items-center gap-2">
        <span aria-hidden className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
          <span className="block h-full rounded-full bg-info" style={{ width: `${percent}%` }} />
        </span>
        <span className="font-heading tabular-nums">{percent}%</span>
      </span>
      {rate < LOW_MATCH_RATE && <StatusBadge tone="warning">Key may be the wrong column</StatusBadge>}
    </span>
  );
}

function columns(zone: TimeZone): readonly [Column<DatasetSummary>, ...Column<DatasetSummary>[]] {
  return [
    {
      id: "dataset",
      header: "Dataset",
      cell: (row) => (
        <span className="flex flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{row.displayName}</span>
            <span className="rounded-full bg-muted px-1.5 font-semibold text-[0.65625rem] text-muted-foreground">{KIND_LABELS[row.kind]}</span>
          </span>
          <span className="font-mono text-muted-foreground text-xs">{row.name}</span>
        </span>
      ),
    },
    {
      id: "version",
      header: "Version",
      cell: (row) => (
        <span className="flex flex-col gap-0.5">
          <span className="font-heading tabular-nums">v{row.version}</span>
          <span className="text-muted-foreground text-xs">{DELIVERY_MODE_LABELS[row.deliveryMode]}</span>
        </span>
      ),
    },
    {
      id: "writer",
      header: "Sent by",
      cell: (row) =>
        row.lastRun === null ? (
          <span className="text-muted-foreground text-xs">Nobody yet</span>
        ) : (
          <span className="flex flex-col gap-0.5">
            <span>{row.lastRun.writer}</span>
            <span className="text-muted-foreground text-xs">{RUN_SOURCE_LABELS[row.lastRun.source]}</span>
          </span>
        ),
    },
    { id: "last", header: "Last file", cell: (row) => <LastFile run={row.lastRun} zone={zone} /> },
    {
      id: "stored",
      header: "Stored rows",
      kind: "number",
      cell: () => (
        <span className="text-muted-foreground text-xs" title={STORED_ROWS_REASON}>
          {NOT_AVAILABLE}
        </span>
      ),
    },
    { id: "match", header: "Customer key match", kind: "number", cell: (row) => <MatchRate rate={row.lastRun?.matchRate ?? null} /> },
  ];
}

function FilterChips({ filter, counts }: { filter: KindFilter; counts: Record<KindFilter, number> }) {
  const options: { key: KindFilter; label: string }[] = [
    { key: "all", label: "All" },
    ...DATASET_KINDS.map((kind) => ({ key: kind, label: KIND_FILTER_LABELS[kind] })),
  ];
  return (
    <div aria-label="Filter datasets" className="flex flex-wrap gap-2" role="group">
      {options.map((option) => (
        <Link
          aria-current={option.key === filter ? "true" : undefined}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
            option.key === filter ? "border-primary/30 bg-primary/10 font-semibold text-primary" : "border-border bg-background",
          )}
          href={option.key === "all" ? "/v2/data/datasets" : `/v2/data/datasets?kind=${option.key}`}
          key={option.key}
        >
          {option.label}
          <span className="font-heading tabular-nums">{counts[option.key]}</span>
        </Link>
      ))}
    </div>
  );
}

function SideNotes() {
  return (
    <aside className="flex flex-col gap-4">
      <SectionCard title="How imported data reaches a journey">
        <ol className="flex flex-col gap-2.5 text-sm">
          {[
            "Your ERP or loyalty system sends a file each night, or an admin uploads a spreadsheet.",
            "Studio checks every row against the dataset and stores the good ones within 10 minutes.",
            "The nightly pass at 03:00 works out metrics like Spend, last 90 days. Conditions see the new values when it is done.",
          ].map((step, index) => (
            <li className="flex gap-2.5" key={step}>
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 font-heading font-semibold text-primary text-xs">
                {index + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </SectionCard>
      <SectionCard title="Customer key match">
        <div className="flex flex-col gap-2 text-muted-foreground text-sm">
          <p>
            The share of customer keys in the last file that Studio already knows from your website and app. A key must equal the user id
            your trackers send, character for character.
          </p>
          <p>A very low share, like 3%, usually means the customer key points at the wrong column.</p>
        </div>
      </SectionCard>
    </aside>
  );
}

export function DatasetsEmpty({ admin }: { admin: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2.5 rounded-card border border-border bg-card px-6 py-12 text-center">
      <DatabaseIcon aria-hidden className="size-6 text-ink-muted" />
      <h2 className="font-heading font-semibold text-[1.0625rem]">No datasets yet.</h2>
      <p className="max-w-md text-muted-foreground text-sm">
        Create one for each kind of row your shop can send, like <span className="font-mono">orders</span> or{" "}
        <span className="font-mono">customers</span>. Drop a sample file and Studio suggests the columns.
      </p>
      {admin ? (
        <Button render={<Link href="/v2/data/datasets/new" />}>New dataset</Button>
      ) : (
        <p className="text-muted-foreground text-sm">Ask an admin to set up the data your shop sends.</p>
      )}
    </div>
  );
}

/** DIM-FR-01, DIM-FR-24: the Datasets board, list state. */
export function DatasetsList({ overview, filter, zone }: { overview: DatasetOverview; filter: KindFilter; zone: TimeZone }) {
  const { datasets } = overview;
  const counts: Record<KindFilter, number> = {
    all: datasets.length,
    profile: datasets.filter((dataset) => dataset.kind === "profile").length,
    event: datasets.filter((dataset) => dataset.kind === "event").length,
  };
  const rows = datasets.filter((dataset) => filter === "all" || dataset.kind === filter);
  const kinds = `${counts.profile} customer ${counts.profile === 1 ? "profile" : "profiles"} · ${counts.event} event ${counts.event === 1 ? "type" : "types"}`;

  return (
    <div className="flex flex-col gap-4">
      <KpiRow>
        <KpiCard change={null} definition="Datasets defined in this workspace." detail={kinds} label="Datasets" value={{ available: true, value: formatCount(datasets.length) }} />
        <KpiCard change={null} definition="Rows kept in the import store across every dataset." label="Stored rows" value={{ available: false, reason: STORED_ROWS_REASON }} />
        <KpiCard
          change={null}
          definition="When the nightly pass last finished. Conditions see imported values as of that pass."
          detail={overview.lastPassAt === null ? undefined : "Nightly pass done"}
          label="Values in conditions"
          value={
            overview.lastPassAt === null
              ? { available: false, reason: "No nightly pass has finished yet." }
              : { available: true, value: formatDateTime(overview.lastPassAt, zone) }
          }
        />
        <KpiCard
          change={null}
          definition="Files held for review because a safety check failed. An admin approves or discards each one on Imports."
          detail={overview.held > 0 ? "Held for review" : "Nothing held"}
          label="Waiting for an admin"
          value={{ available: true, value: formatCount(overview.held) }}
        />
      </KpiRow>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-2">
          <DataTable
            columns={columns(zone)}
            empty={<RegionEmpty icon={DatabaseIcon} message="No dataset of this kind." />}
            label="Datasets"
            open={{ kind: "link", href: (row) => datasetHref(row.id) }}
            rowKey={(row) => row.id}
            rows={rows}
            toolbar={
              <>
                <FilterChips counts={counts} filter={filter} />
                <span className="ml-auto text-muted-foreground text-xs">Times in {zone}</span>
              </>
            }
          />
          <p className="text-muted-foreground text-xs">
            Showing <span className="font-heading tabular-nums">{rows.length}</span> of{" "}
            <span className="font-heading tabular-nums">{datasets.length}</span> datasets, sorted by name
          </p>
        </div>
        <SideNotes />
      </div>
    </div>
  );
}
