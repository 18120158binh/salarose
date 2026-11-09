"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { LockIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/shared/lib/format";
import type { TimeZone } from "@/shared/lib/time-range";
import { SideSheet } from "@/shared/ui/v2/SideSheet";
import { NotAvailable } from "@/shared/ui/v2/states";
import { ImportStatus } from "../imports/ImportStatus";
import {
  calculationText,
  describeUses,
  eventCalculationText,
  METRIC_STATE_LABELS,
  systemNameOf,
  windowText,
  type DatasetMetric,
  type EventMetric,
  type MetricDataset,
  type MetricRow,
  type MetricUse,
} from "../../model/metrics";

export function hrefOfUse(use: MetricUse): string {
  return use.kind === "journey" ? `/v2/journeys/${encodeURIComponent(use.id)}` : "/v2/segments";
}

function Definition({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[150px_1fr] gap-x-3 gap-y-1.5">
      {rows.map(([term, value]) => (
        <div className="contents" key={term}>
          <dt className="text-muted-foreground text-xs">{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function UsedBy({ uses }: { uses: readonly MetricUse[] }) {
  if (uses.length === 0) return <p className="text-muted-foreground">Nothing uses it.</p>;
  return (
    <ul className="flex flex-col gap-2">
      {uses.map((use) => (
        <li className="flex items-center gap-2" key={`${use.kind}:${use.id}`}>
          <Link className="font-semibold text-primary hover:underline" href={hrefOfUse(use)}>
            {use.name}
          </Link>
          <Badge variant="outline">{use.kind === "journey" ? "Journey" : "Segment"}</Badge>
        </li>
      ))}
    </ul>
  );
}

function Spread({ reason }: { reason: string }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
      {["Customers with a value", "Lowest", "Median", "Highest"].map((label) => (
        <div className="flex flex-col rounded-tile border border-border px-3 py-2.5" key={label}>
          <span className="text-muted-foreground text-xs">{label}</span>
          <span className="font-medium text-muted-foreground text-sm">Not available</span>
        </div>
      ))}
      <p className="col-span-full text-muted-foreground text-xs">{reason}</p>
    </div>
  );
}

function H({ children }: { children: ReactNode }) {
  return <h3 className="mt-4 mb-1.5 font-semibold text-[0.8125rem]">{children}</h3>;
}

export interface MetricDetailSheetProps {
  metric: MetricRow | null;
  datasets: readonly MetricDataset[];
  zone: TimeZone;
  onClose: () => void;
  onEdit: (metric: DatasetMetric) => void;
}

export function MetricDetailSheet({ metric, datasets, zone, onClose, onEdit }: MetricDetailSheetProps) {
  return (
    <SideSheet
      description={metric ? (metric.source === "event" ? "Event metric" : `Dataset metric · ${metric.dataset.displayName}`) : undefined}
      footer={
        metric?.source === "dataset" && metric.state !== "archived" ? (
          <>
            <span className="flex-1 self-center text-muted-foreground text-xs">
              Changes apply at the next nightly pass.
              {metric.uses.length > 0 && ` Used by ${describeUses(metric.uses)}. Archive becomes available when nothing uses it.`}
            </span>
            <Button onClick={() => onEdit(metric)}>Edit</Button>
          </>
        ) : undefined
      }
      onOpenChange={(open) => !open && onClose()}
      open={metric !== null}
      size="form"
      title={metric?.displayName ?? "Metric"}
    >
      {metric && (
        <div className="flex flex-col text-sm">
          <span className="font-mono text-muted-foreground text-xs">{systemNameOf(metric)}</span>
          {metric.source === "event" ? <EventDetail metric={metric} /> : <DatasetDetail datasets={datasets} metric={metric} zone={zone} />}
        </div>
      )}
    </SideSheet>
  );
}

function EventDetail({ metric }: { metric: EventMetric }) {
  return (
    <>
      <p className="mt-3 flex gap-2.5 rounded-tile bg-muted px-3 py-2.5">
        <LockIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>
          Made by Studio when a journey or segment with this behavior condition was published. Nobody edits it here. It pauses by itself
          when no active journey or segment uses it.
        </span>
      </p>
      <H>Definition</H>
      <Definition
        rows={[
          [
            "Event",
            <>
              <Link className="text-primary hover:underline" href="/v2/data/events">
                {metric.eventDisplayName ?? metric.eventName}
              </Link>{" "}
              <span className="font-mono text-muted-foreground text-xs">{metric.eventName}</span>
            </>,
          ],
          ["Calculation", eventCalculationText(metric)],
          ["Kept for", metric.retentionDays === null ? "–" : `${windowText(metric.retentionDays)}, the longest window among its uses`],
          ["State", <ImportStatus key="state" {...METRIC_STATE_LABELS[metric.state]} />],
          ["Created by", metric.createdBy ?? "Unknown"],
        ]}
      />
      <H>Used by</H>
      <UsedBy uses={metric.uses} />
      <H>Spread of values</H>
      <Spread reason="Each use counts over its own window at the moment an event arrives. There is no one value per customer to spread." />
    </>
  );
}

function DatasetDetail({ metric, datasets, zone }: { metric: DatasetMetric; datasets: readonly MetricDataset[]; zone: TimeZone }) {
  const columns = datasets.find((dataset) => dataset.id === metric.dataset.id)?.columns ?? [];
  return (
    <>
      <H>Definition</H>
      <Definition
        rows={[
          [
            "Dataset",
            <Link className="text-primary hover:underline" href="/v2/data/datasets" key="dataset">
              {metric.dataset.displayName}
            </Link>,
          ],
          ["Calculation", calculationText(metric, columns)],
          ["Window", windowText(metric.windowDays)],
          ["In conditions as", `${metric.dataset.displayName} > ${metric.displayName}`],
          ["State", <ImportStatus key="state" {...METRIC_STATE_LABELS[metric.state]} />],
          [
            "Created by",
            `${metric.createdBy ?? "Unknown"}${metric.createdAt === null ? "" : `, ${formatDateTime(metric.createdAt, zone)}`}`,
          ],
        ]}
      />
      <H>Used by</H>
      <UsedBy uses={metric.uses} />
      <H>Spread of values</H>
      <div className="rounded-tile border border-border px-3 py-2.5">
        <NotAvailable reason="Studio can't read the import store yet, so it can't show customers with a value, the lowest, the median, or the highest." />
      </div>
    </>
  );
}
