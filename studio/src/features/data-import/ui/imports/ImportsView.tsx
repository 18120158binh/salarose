"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { InboxIcon, LockIcon, MoonIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatCount, formatDateTime, formatDuration } from "@/shared/lib/format";
import type { TimeZone } from "@/shared/lib/time-range";
import { DataTable, type Column } from "@/shared/ui/v2/DataTable";
import { SectionCard } from "@/shared/ui/v2/SectionCard";
import { RegionEmpty } from "@/shared/ui/v2/states";
import { PASS_STATE_LABELS, RUN_STATE_LABELS } from "../../model/domain";
import {
  canRetryPass,
  fileName,
  formatBytes,
  RUN_FILTER_LABELS,
  RUN_FILTERS,
  runActionsOf,
  runDuration,
  senderOf,
  type ImportRun,
  type MetricPass,
  type RunFilter,
  type RunQuery,
  type Staleness,
} from "../../model/imports";
import { retryPassAction, retryRunAction } from "../../model/importsActions";
import { ActionButton } from "./ActionButton";
import { ImportStatus } from "./ImportStatus";
import { RunDetailSheet } from "./RunDetailSheet";
import { dayLabel, inConditionsFrom, passName } from "./runText";

export interface ImportsViewProps {
  runs: ImportRun[];
  counts: Record<RunFilter, number>;
  datasets: { id: string; displayName: string }[];
  passes: MetricPass[];
  staleness: Staleness;
  query: RunQuery;
  admin: boolean;
  zone: TimeZone;
}

const SELECT =
  "h-8 rounded-control border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

function queryHref(query: RunQuery): string {
  const params = new URLSearchParams();
  if (query.filter !== "all") params.set("state", query.filter);
  if (query.dataset !== null) params.set("dataset", query.dataset);
  const search = params.toString();
  return search === "" ? "/v2/data/imports" : `/v2/data/imports?${search}`;
}

function countText(value: number | null): string {
  return value === null ? "–" : formatCount(value);
}

export function ImportsView({ runs, counts, datasets, passes, staleness, query, admin, zone }: ImportsViewProps) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);
  const open = runs.find((run) => run.id === openId) ?? null;

  const columns: [Column<ImportRun>, ...Column<ImportRun>[]] = [
    { id: "received", header: "Received", cell: (run) => <span className="whitespace-nowrap">{formatDateTime(run.createdAt, zone)}</span> },
    {
      id: "file",
      header: "Dataset and file",
      cell: (run) => (
        <span className="flex max-w-72 flex-col">
          <span className="font-semibold">{run.dataset.displayName}</span>
          <span className="truncate font-mono text-muted-foreground text-xs">{fileName(run)}</span>
        </span>
      ),
    },
    {
      id: "by",
      header: "Sent by",
      cell: (run) => {
        const sender = senderOf(run);
        return (
          <span className="flex flex-col">
            <span>{sender.by}</span>
            <span className="text-muted-foreground text-xs">{sender.kind}</span>
          </span>
        );
      },
    },
    { id: "version", header: "Version", cell: (run) => <span className="font-heading tabular-nums">v{run.version}</span> },
    { id: "rows", header: "Rows", kind: "number", cell: (run) => <span className="font-heading">{countText(run.counts.rowsRead)}</span> },
    { id: "rejected", header: "Rejected", kind: "number", cell: (run) => <span className="font-heading">{countText(run.counts.rejected)}</span> },
    {
      id: "result",
      header: "Result",
      cell: (run) => (
        <span className="flex flex-col gap-0.5">
          <ImportStatus {...RUN_STATE_LABELS[run.state]} />
          {run.reason && <span className="text-muted-foreground text-xs">{run.reason}</span>}
        </span>
      ),
    },
    {
      id: "took",
      header: "Took",
      cell: (run) => {
        const took = runDuration(run);
        return <span className="whitespace-nowrap">{took === null ? "–" : formatDuration(took)}</span>;
      },
    },
    { id: "pass", header: "In conditions from", cell: (run) => <span className="whitespace-nowrap">{inConditionsFrom(run, zone)}</span> },
  ];

  const rowActions = (run: ImportRun) => {
    const actions = runActionsOf(run);
    return (
      <span className="flex items-center justify-end gap-2 whitespace-nowrap">
        <Button onClick={() => setOpenId(run.id)} size="sm" variant="ghost">
          Details
        </Button>
        {admin && actions.retry && (
          <ActionButton
            ariaLabel={`Retry ${fileName(run)}`}
            doneTitle={`${fileName(run)} is waiting to apply again`}
            failedTitle="The file was not retried."
            run={() => retryRunAction(run.id)}
          >
            Retry
          </ActionButton>
        )}
        {admin && actions.discard && (
          <Button aria-label={`Review ${fileName(run)}`} onClick={() => setOpenId(run.id)} size="sm" variant="outline">
            Review
          </Button>
        )}
      </span>
    );
  };

  return (
    <>
      {staleness.stale && <StaleNotice admin={admin} staleness={staleness} zone={zone} />}

      <DataTable
        columns={columns}
        empty={
          <RegionEmpty
            icon={InboxIcon}
            message={
              query.filter === "all" && query.dataset === null
                ? "No file has arrived yet. Files your shop sends, and files an admin uploads to a dataset, show here."
                : "No file matches these filters."
            }
          />
        }
        footer={
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <span>Showing {runs.length} files, newest first</span>
            <span className="ml-auto">50 per page</span>
          </div>
        }
        label="Files"
        rowActions={rowActions}
        rowKey={(run) => run.id}
        rows={runs}
        toolbar={
          <>
            <h2 className="mr-1.5 font-heading font-semibold text-[0.9375rem]">Files</h2>
            <nav aria-label="Filter files" className="flex flex-wrap gap-1.5">
              {RUN_FILTERS.map((filter) => {
                const on = query.filter === filter;
                return (
                  <Link
                    aria-current={on ? "page" : undefined}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      on ? "border-primary/30 bg-primary/10 font-semibold text-primary" : "border-input bg-background text-foreground",
                    )}
                    href={queryHref({ ...query, filter })}
                    key={filter}
                  >
                    {RUN_FILTER_LABELS[filter]}
                    <span className="font-heading text-muted-foreground tabular-nums">{counts[filter]}</span>
                  </Link>
                );
              })}
            </nav>
            <label className="ml-auto flex items-center gap-1.5 text-muted-foreground text-xs">
              Dataset
              <select
                className={SELECT}
                onChange={(event) => router.push(queryHref({ ...query, dataset: event.target.value === "" ? null : event.target.value }))}
                value={query.dataset ?? ""}
              >
                <option value="">All</option>
                {datasets.map((dataset) => (
                  <option key={dataset.id} value={dataset.id}>
                    {dataset.displayName}
                  </option>
                ))}
              </select>
            </label>
          </>
        }
      />

      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-[1_1_760px]">
          <PassesTable admin={admin} passes={passes} zone={zone} />
        </div>
        <aside className="flex min-w-0 flex-[1_1_260px] flex-col gap-4">
          <SectionCard title="When a file is held">
            <p className="text-sm">
              Studio stores nothing from a file when more than 5% of its rows are rejected, when a full file is much smaller than the
              last one, or when it would pass the 5,000,000 row limit.
            </p>
            <p className="mt-2 text-sm">An admin then approves or discards it. Later files of the same dataset wait until then.</p>
          </SectionCard>
          {!admin && (
            <p className="flex gap-2.5 rounded-card border border-border bg-card p-4 text-muted-foreground text-sm">
              <LockIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
              Only admins can approve, discard, retry or download rejected rows.
            </p>
          )}
        </aside>
      </div>

      <RunDetailSheet admin={admin} onClose={() => setOpenId(null)} run={open} zone={zone} />
    </>
  );
}

function StaleNotice({ staleness, admin, zone }: { staleness: Extract<Staleness, { stale: true }>; admin: boolean; zone: TimeZone }) {
  const retry = staleness.retry;
  const reasons = [...new Set(staleness.stopped.flatMap((pass) => (pass.reason ? [pass.reason] : [])))];
  const stoppedDays = staleness.stopped.map((pass) => dayLabel(pass.asOf, zone)).reverse();
  const title =
    staleness.valuesAsOf === null
      ? "Imported values are not in conditions yet"
      : `Imported values in conditions are from ${dayLabel(staleness.valuesAsOf, zone)}, ${staleness.ageDays} ${staleness.ageDays === 1 ? "day" : "days"} old`;
  return (
    <div className="flex flex-wrap gap-3 rounded-card border border-warning/40 bg-card px-4 py-3.5" role="alert">
      <TriangleAlertIcon aria-hidden className="mt-0.5 size-4.5 shrink-0 text-warning" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-semibold text-warning">{title}</p>
        <p>
          {stoppedDays.length > 0 ? (
            <>
              The nightly {stoppedDays.length === 1 ? "pass" : "passes"} on {stoppedDays.join(" and ")} stopped before{" "}
              {stoppedDays.length === 1 ? "it" : "they"} finished
              {reasons.length > 0 && (
                <>
                  : <span className="font-mono text-xs">{reasons.join(", ")}</span>
                </>
              )}
              .{" "}
            </>
          ) : (
            "No nightly pass has run since. "
          )}
          Files still apply. Segments and journeys see them after the next pass that finishes.
        </p>
      </div>
      {admin && retry && canRetryPass(retry) && (
        <span className="self-center">
          <ActionButton
            doneTitle="The pass will run again"
            failedTitle="The pass was not retried."
            run={() => retryPassAction(retry.id)}
            size="default"
          >
            {`Retry ${passName(retry.asOf, zone)}`}
          </ActionButton>
        </span>
      )}
    </div>
  );
}

function PassesTable({ passes, admin, zone }: { passes: MetricPass[]; admin: boolean; zone: TimeZone }) {
  const columns: [Column<MetricPass>, ...Column<MetricPass>[]] = [
    { id: "asOf", header: "Values as of", cell: (pass) => <span className="font-heading font-semibold">{dayLabel(pass.asOf, zone)}</span> },
    {
      id: "result",
      header: "Result",
      cell: (pass) => (
        <span className="flex flex-col gap-0.5">
          <ImportStatus {...PASS_STATE_LABELS[pass.state]} />
          {pass.state === "failed" && pass.reason && <span className="font-mono text-muted-foreground text-xs">{pass.reason}</span>}
          {pass.retryRequestedAt !== null && <span className="text-muted-foreground text-xs">Retry asked</span>}
        </span>
      ),
    },
    { id: "started", header: "Started", cell: (pass) => formatDateTime(pass.startedAt, zone) },
    {
      id: "took",
      header: "Took",
      cell: (pass) => {
        if (pass.finishedAt === null) return "–";
        if (pass.state === "failed") return `Stopped ${formatDateTime(pass.finishedAt, zone)}`;
        return formatDuration(pass.finishedAt - pass.startedAt);
      },
    },
    { id: "changed", header: "Changed rows", kind: "number", cell: (pass) => <span className="font-heading">{countText(pass.changedRows)}</span> },
    {
      id: "wal",
      header: "Database writes",
      kind: "number",
      cell: (pass) => <span className="font-heading">{pass.walBytes === null ? "–" : formatBytes(pass.walBytes)}</span>,
    },
    {
      id: "paused",
      header: "Paused",
      cell: (pass) => (pass.pauseCount === 0 ? "None" : `${pass.pauseCount} ${pass.pauseCount === 1 ? "pause" : "pauses"}`),
    },
  ];
  return (
    <SectionCard
      description="Every night at 03:00 Studio works out metrics and customer fields from stored rows. Conditions see a file after the first pass that finishes after it applied."
      flush
      title="Nightly passes"
    >
      <DataTable
        columns={columns}
        empty={<RegionEmpty icon={MoonIcon} message="No nightly pass has run yet. The first one runs at 03:00." />}
        footer={
          <p className="text-muted-foreground text-xs">
            The pass pauses itself while the shop&apos;s live traffic is high, so it never slows down journeys. Database writes counts only
            what the pass wrote.
          </p>
        }
        label="Nightly passes"
        rowActions={
          admin
            ? (pass) =>
                canRetryPass(pass) ? (
                  <ActionButton
                    ariaLabel={`Retry the ${passName(pass.asOf, zone)}`}
                    doneTitle="The pass will run again"
                    failedTitle="The pass was not retried."
                    run={() => retryPassAction(pass.id)}
                  >
                    Retry
                  </ActionButton>
                ) : null
            : undefined
        }
        rowKey={(pass) => pass.id}
        rows={passes}
      />
    </SectionCard>
  );
}
