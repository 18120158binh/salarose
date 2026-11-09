"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChartColumnIcon, EllipsisIcon, PlusIcon, SearchIcon, SheetIcon, ZapIcon } from "lucide-react";
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
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { cn } from "@/lib/utils";
import { formatCount } from "@/shared/lib/format";
import { callServerAction } from "@/shared/lib/serverAction";
import type { TimeZone } from "@/shared/lib/time-range";
import { CellLabel, DataTable, type Column } from "@/shared/ui/v2/DataTable";
import { KpiCard } from "@/shared/ui/v2/KpiCard";
import { PageHeader } from "@/shared/ui/v2/PageHeader";
import { RegionEmpty } from "@/shared/ui/v2/states";
import { notify } from "@/shared/ui/v2/toast";
import { ImportStatus } from "../imports/ImportStatus";
import {
  calculationText,
  describeUses,
  EVENT_ARCHIVE_GAP,
  METRIC_PAGE_DESCRIPTION,
  eventCalculationText,
  METRIC_STATE_LABELS,
  metricKey,
  systemNameOf,
  windowText,
  type DatasetMetric,
  type MetricDataset,
  type MetricRow,
  type MetricState,
} from "../../model/metrics";
import { archiveDatasetMetricAction, unarchiveDatasetMetricAction } from "../../model/metricsActions";
import { hrefOfUse, MetricDetailSheet } from "./MetricDetailSheet";
import { MetricEditorSheet } from "./MetricEditorSheet";

const SELECT = "h-8 rounded-control border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

type KindFilter = "all" | "event" | "dataset";
type StateFilter = "any" | MetricState;
type UseFilter = "any" | "used" | "unused";

const KIND_LABELS: Record<KindFilter, string> = { all: "All", event: "Events", dataset: "Datasets" };

export interface MetricsViewProps {
  metrics: MetricRow[];
  datasets: MetricDataset[];
  zone: TimeZone;
}

function stateNote(metric: MetricRow): string {
  if (metric.source === "event") return metric.state === "live" ? "Counting now" : "No active journey or segment uses it";
  switch (metric.state) {
    case "archived":
      return "Frozen · keeps its last values";
    case "not_updating":
      return "The nightly pass hasn't finished lately";
    default:
      return "Nightly";
  }
}

export function MetricsView({ metrics, datasets, zone }: MetricsViewProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [source, setSource] = useState("any");
  const [stateFilter, setStateFilter] = useState<StateFilter>("any");
  const [showArchived, setShowArchived] = useState(false);
  const [useFilter, setUseFilter] = useState<UseFilter>("any");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ metric: DatasetMetric | null } | null>(null);
  const [archiving, setArchiving] = useState<DatasetMetric | null>(null);
  const [pending, startTransition] = useTransition();

  const columnsOf = (metric: DatasetMetric) => datasets.find((dataset) => dataset.id === metric.dataset.id)?.columns ?? [];
  const sourceName = (metric: MetricRow) => (metric.source === "event" ? (metric.eventDisplayName ?? metric.eventName) : metric.dataset.displayName);
  const sources = useMemo(() => [...new Set(metrics.map(sourceName))].sort(), [metrics]);

  const counts = {
    all: metrics.length,
    event: metrics.filter((metric) => metric.source === "event").length,
    dataset: metrics.filter((metric) => metric.source === "dataset").length,
  };
  const live = metrics.filter((metric) => metric.state === "live").length;
  const paused = metrics.filter((metric) => metric.state === "paused").length;
  const archived = metrics.filter((metric) => metric.state === "archived").length;
  const notUpdating = metrics.filter((metric) => metric.state === "not_updating").length;

  const needle = query.trim().toLowerCase();
  const rows = metrics.filter(
    (metric) =>
      (kind === "all" || metric.source === kind) &&
      (source === "any" || sourceName(metric) === source) &&
      (stateFilter === "any" ? showArchived || metric.state !== "archived" : metric.state === stateFilter) &&
      (useFilter === "any" || (useFilter === "used") === metric.uses.length > 0) &&
      (needle === "" || metric.displayName.toLowerCase().includes(needle) || sourceName(metric).toLowerCase().includes(needle)),
  );
  const opened = metrics.find((metric) => metricKey(metric) === openKey) ?? null;

  const unarchive = (metric: DatasetMetric) =>
    startTransition(async () => {
      const result = await callServerAction(() => unarchiveDatasetMetricAction(metric.id));
      if ("error" in result) notify({ kind: "failed", title: `${metric.displayName} was not unarchived.`, description: result.error });
      else {
        notify({ kind: "done", title: `Unarchived ${metric.displayName}` });
        router.refresh();
      }
    });

  const archive = (metric: DatasetMetric) =>
    startTransition(async () => {
      const result = await callServerAction(() => archiveDatasetMetricAction(metric.id));
      if ("error" in result) notify({ kind: "failed", title: `${metric.displayName} was not archived.`, description: result.error });
      else {
        notify({ kind: "done", title: `Archived ${metric.displayName}` });
        router.refresh();
      }
    });

  const columns: [Column<MetricRow>, ...Column<MetricRow>[]] = [
    { id: "metric", header: "Metric", cell: (metric) => <CellLabel label={metric.displayName} secondary={systemNameOf(metric)} /> },
    {
      id: "source",
      header: "Source",
      cell: (metric) => (
        <span className="flex flex-col">
          <span className="flex items-center gap-1.5">
            {metric.source === "event" ? (
              <ZapIcon aria-hidden className="size-3.5 text-muted-foreground" />
            ) : (
              <SheetIcon aria-hidden className="size-3.5 text-muted-foreground" />
            )}
            {sourceName(metric)}
          </span>
          <span className="text-muted-foreground text-xs">{metric.source === "event" ? `Event · ${metric.eventName}` : "Dataset"}</span>
        </span>
      ),
    },
    {
      id: "calc",
      header: "Calculation",
      cell: (metric) => (
        <span className="block max-w-52">{metric.source === "event" ? eventCalculationText(metric) : calculationText(metric, columnsOf(metric))}</span>
      ),
    },
    {
      id: "window",
      header: "Window",
      cell: (metric) => (
        <span className="whitespace-nowrap">{metric.source === "event" ? (metric.retentionDays === null ? "–" : windowText(metric.retentionDays)) : windowText(metric.windowDays)}</span>
      ),
    },
    {
      id: "state",
      header: "State",
      cell: (metric) => (
        <span className="flex flex-col gap-0.5">
          <ImportStatus {...METRIC_STATE_LABELS[metric.state]} />
          <span className="text-muted-foreground text-xs">{stateNote(metric)}</span>
        </span>
      ),
    },
    {
      id: "uses",
      header: "Used by",
      cell: (metric) =>
        metric.uses.length === 0 ? (
          <span className="text-muted-foreground text-xs">Not used by anything</span>
        ) : (
          <span className="relative z-10 flex max-w-56 flex-col text-xs">
            {metric.uses.map((use) => (
              <Link className="text-primary hover:underline" href={hrefOfUse(use)} key={`${use.kind}:${use.id}`}>
                {use.kind === "journey" ? "Journey" : "Segment"} {use.name}
              </Link>
            ))}
          </span>
        ),
    },
    {
      id: "customers",
      header: "Customers with a value",
      kind: "number",
      cell: () => <span className="text-muted-foreground text-xs">Not available</span>,
    },
    { id: "by", header: "Created by", cell: (metric) => <span className="text-xs">{metric.createdBy ?? "Unknown"}</span> },
  ];

  return (
    <>
      <PageHeader
        actions={
          <Button onClick={() => setEditor({ metric: null })}>
            <PlusIcon aria-hidden />
            New dataset metric
          </Button>
        }
        description={METRIC_PAGE_DESCRIPTION}
        preview
        title="Metrics"
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard
          change={null}
          definition="Every metric Studio keeps, archived ones included."
          detail={`${counts.event} from events · ${counts.dataset} from datasets`}
          label="Metrics"
          value={{ available: true, value: formatCount(counts.all) }}
        />
        <KpiCard
          change={null}
          definition="Metrics updating now: events in seconds, datasets nightly."
          detail="Events in seconds, datasets nightly"
          label="Live"
          value={{ available: true, value: formatCount(live) }}
        />
        <KpiCard
          change={null}
          definition="Event metrics no active journey or segment uses, and archived metrics."
          detail={`${paused} paused event metrics · ${archived} archived`}
          label="Paused or archived"
          value={{ available: true, value: formatCount(paused + archived) }}
        />
        <KpiCard
          change={null}
          definition="Dataset metrics whose latest finished nightly pass is more than a day old."
          detail="See Nightly passes on Imports"
          label="Not updating"
          value={{ available: true, value: formatCount(notUpdating) }}
        />
      </div>

      <DataTable
        columns={columns}
        empty={
          <RegionEmpty
            icon={metrics.length === 0 ? ChartColumnIcon : SearchIcon}
            message={
              metrics.length === 0
                ? "No metric yet. Publishing a journey with a behavior condition makes event metrics, and you can make a dataset metric here."
                : needle !== ""
                  ? `No metric matches "${query.trim()}".`
                  : "No metric matches these filters."
            }
          />
        }
        footer={
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <span>
              Showing {rows.length} of {metrics.length} metrics, live first
            </span>
            <span className="ml-auto">Open a metric for its definition and uses</span>
          </div>
        }
        label="Metrics"
        open={{ kind: "action", onOpen: (metric) => setOpenKey(metricKey(metric)) }}
        rowActions={(metric) => (
          <RowMenu
            metric={metric}
            onArchive={setArchiving}
            onOpen={() => setOpenKey(metricKey(metric))}
            onUnarchive={unarchive}
            pending={pending}
          />
        )}
        rowKey={metricKey}
        rows={rows}
        toolbar={
          <>
            <label className="flex h-8 min-w-0 flex-[0_1_240px] items-center gap-2 rounded-control border border-input bg-background px-2.5">
              <SearchIcon aria-hidden className="size-3.5 text-muted-foreground" />
              <span className="sr-only">Search metrics</span>
              <input
                className="w-full min-w-0 bg-transparent text-sm outline-none"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search, like spend"
                type="search"
                value={query}
              />
            </label>
            <div aria-label="Source type" className="flex gap-1.5" role="group">
              {(Object.keys(KIND_LABELS) as KindFilter[]).map((option) => (
                <button
                  aria-pressed={kind === option}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    kind === option ? "border-primary/30 bg-primary/10 font-semibold text-primary" : "border-input bg-background",
                  )}
                  key={option}
                  onClick={() => setKind(option)}
                  type="button"
                >
                  {KIND_LABELS[option]}
                  <span className="font-heading text-muted-foreground tabular-nums">{counts[option]}</span>
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1.5 text-muted-foreground text-xs">
              Source
              <select className={SELECT} onChange={(event) => setSource(event.target.value)} value={source}>
                <option value="any">Any event or dataset</option>
                {sources.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-muted-foreground text-xs">
              State
              <select className={SELECT} onChange={(event) => setStateFilter(event.target.value as StateFilter)} value={stateFilter}>
                <option value="any">Any</option>
                {(Object.keys(METRIC_STATE_LABELS) as MetricState[]).map((state) => (
                  <option key={state} value={state}>
                    {METRIC_STATE_LABELS[state].label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-xs">
              <input checked={showArchived} className="accent-primary" onChange={(event) => setShowArchived(event.target.checked)} type="checkbox" />
              Show archived
            </label>
            <label className="flex items-center gap-1.5 text-muted-foreground text-xs">
              Use
              <select className={SELECT} onChange={(event) => setUseFilter(event.target.value as UseFilter)} value={useFilter}>
                <option value="any">Used or unused</option>
                <option value="used">Used</option>
                <option value="unused">Unused</option>
              </select>
            </label>
          </>
        }
      />

      <MetricDetailSheet
        datasets={datasets}
        metric={opened}
        onClose={() => setOpenKey(null)}
        onEdit={(metric) => {
          setOpenKey(null);
          setEditor({ metric });
        }}
        zone={zone}
      />
      <MetricEditorSheet
        datasets={datasets}
        metric={editor?.metric ?? null}
        onOpenChange={(open) => !open && setEditor(null)}
        open={editor !== null}
      />
      <AlertDialog onOpenChange={(open) => !open && setArchiving(null)} open={archiving !== null}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {archiving?.displayName}?</AlertDialogTitle>
            <AlertDialogDescription render={<div />}>
              <ul className="flex list-disc flex-col gap-1 pl-4.5">
                <li>It is hidden from every condition picker, the segment editor and the journey builder.</li>
                <li>It stops updating and keeps its values as of the last nightly pass.</li>
                <li>
                  <b>Unarchive</b> brings it back into the pickers, and it starts updating again.
                </li>
              </ul>
              <p className="mt-2.5 text-xs">Not used by anything. Metrics are never deleted.</p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <AlertDialogClose onClick={() => archiving && archive(archiving)} render={<Button />}>
              Archive metric
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function RowMenu({
  metric,
  pending,
  onOpen,
  onArchive,
  onUnarchive,
}: {
  metric: MetricRow;
  pending: boolean;
  onOpen: () => void;
  onArchive: (metric: DatasetMetric) => void;
  onUnarchive: (metric: DatasetMetric) => void;
}) {
  const used = metric.uses.length > 0;
  return (
    <Menu>
      <MenuTrigger render={<Button aria-label={`Actions for ${metric.displayName}`} disabled={pending} size="icon-sm" variant="ghost" />}>
        <EllipsisIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="end" className="max-w-64">
        <MenuItem onClick={onOpen}>Open details</MenuItem>
        {metric.source === "dataset" && metric.state === "archived" && <MenuItem onClick={() => onUnarchive(metric)}>Unarchive</MenuItem>}
        {metric.source === "dataset" && metric.state !== "archived" && !used && <MenuItem onClick={() => onArchive(metric)}>Archive</MenuItem>}
        {used && (
          <p className="px-2 py-1.5 text-muted-foreground text-xs">Used by {describeUses(metric.uses)}. Archive becomes available when nothing uses it.</p>
        )}
        {metric.source === "event" && !used && <p className="px-2 py-1.5 text-muted-foreground text-xs">{EVENT_ARCHIVE_GAP}</p>}
      </MenuPopup>
    </Menu>
  );
}
