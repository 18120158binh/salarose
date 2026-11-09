import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { formatCount, formatTimestamp, type Reading } from "@/shared/lib/format";
import type { TimeZone } from "@/shared/lib/time-range";
import { DataRegion } from "@/shared/ui/v2/DataRegion";
import { KpiSparkline } from "@/shared/ui/v2/KpiSparkline";
import { SectionCard } from "@/shared/ui/v2/SectionCard";
import { StatusBadge, type StatusTone } from "@/shared/ui/v2/StatusBadge";
import { NotAvailable, RegionSkeleton, TableSkeleton } from "@/shared/ui/v2/states";
import { windowPhrase, type DeadLetterQuery } from "../model/deadLetterQuery";
import type { EventHealth, EventHealthRow } from "../model/eventHealth";
import type { Arrival } from "../model/eventVolume";
import { monitoringHref } from "../model/monitoring";

export interface MonitoringOverviewProps {
  query: DeadLetterQuery;
  dropped: Promise<Reading<number>>;
  // DHL-FR-14: every catalog event's volume in the query's window, from event_volume.
  health: Promise<EventHealth>;
  admin: boolean;
  now: number;
  zone: TimeZone;
  // The home overview's pipeline strip, rendered by the page.
  pipeline: ReactNode;
}

const HEALTH_ERROR = "Event volume could not load";
const NUMBER = "font-heading font-semibold text-[1.625rem] leading-tight tabular-nums";

// DHL-FR-13: the pipeline strip, then the section's counts, then each event.
export function MonitoringOverview({ query, dropped, health, admin, now, zone, pipeline }: MonitoringOverviewProps) {
  const phrase = windowPhrase(query.window);
  const droppedHref = admin ? monitoringHref("dropped", query) : null;
  return (
    <div className="flex flex-col gap-6">
      {pipeline}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Tile label="Receiving data">
          <DataRegion errorMessage={HEALTH_ERROR} loading={<RegionSkeleton className="h-9 w-24" />}>
            <ReceivingCount health={health} phrase={phrase} />
          </DataRegion>
        </Tile>
        <Tile label="Quiet">
          <DataRegion errorMessage={HEALTH_ERROR} loading={<RegionSkeleton className="h-9 w-24" />}>
            <QuietCount health={health} />
          </DataRegion>
        </Tile>
        <Tile label={`Dropped ${phrase}`}>
          <DataRegion errorMessage="Dropped records could not load" loading={<RegionSkeleton className="h-9 w-24" />}>
            <DroppedCount reading={dropped} />
          </DataRegion>
          {droppedHref ? (
            <Button className="self-start" render={<Link href={droppedHref} scroll={false} />} size="sm" variant="ghost">
              See why they were dropped
            </Button>
          ) : (
            <p className="text-muted-foreground text-xs">Ask an admin for details.</p>
          )}
        </Tile>
      </div>
      <SectionCard description="Sorted with problems first" title="Each event">
        <DataRegion errorMessage={HEALTH_ERROR} loading={<TableSkeleton rows={6} />}>
          <EventTable droppedHref={droppedHref} health={health} now={now} phrase={phrase} zone={zone} />
        </DataRegion>
        <p className="mt-3 text-muted-foreground text-xs">
          Receiving means at least one event {phrase}. Quiet means nothing for 7 days. Not yet means never seen. Dropped records that can&apos;t be
          tied to one event, like an unreadable request, count only in the total above.
        </p>
      </SectionCard>
    </div>
  );
}

function Tile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="flex flex-col gap-2 rounded-tile border border-border bg-card p-4 text-card-foreground">
      <h2 className="text-muted-foreground text-xs">{label}</h2>
      {children}
    </section>
  );
}

async function ReceivingCount({ health, phrase }: { health: Promise<EventHealth>; phrase: string }) {
  const { receiving, rows } = await health;
  return (
    <p className="flex flex-wrap items-baseline gap-1.5">
      <span className={NUMBER}>{formatCount(receiving)}</span>
      <span className="text-muted-foreground text-sm">
        of {formatCount(rows.length)} events seen {phrase}
      </span>
    </p>
  );
}

async function QuietCount({ health }: { health: Promise<EventHealth> }) {
  const { quiet } = await health;
  return (
    <>
      <p className="flex flex-wrap items-baseline gap-1.5">
        <span className={NUMBER}>{formatCount(quiet.length)}</span>
        {quiet.length > 0 && <StatusBadge tone="warning">{quiet.map((row) => row.label).join(", ")}</StatusBadge>}
      </p>
      {quiet.length > 0 && <p className="text-muted-foreground text-xs">Nothing in 7 days. Check your tracking.</p>}
    </>
  );
}

async function DroppedCount({ reading }: { reading: Promise<Reading<number>> }) {
  const count = await reading;
  if (!count.available) return <NotAvailable reason={count.reason} />;
  return (
    <p className="flex items-baseline gap-1.5">
      <span className={NUMBER}>{formatCount(count.value)}</span>
      <span className="text-muted-foreground text-sm">records</span>
    </p>
  );
}

// Icon and label, never color alone.
const ARRIVAL: Record<Arrival, { text: string; tone: StatusTone }> = {
  receiving: { text: "Yes", tone: "success" },
  idle: { text: "Idle", tone: "neutral" },
  quiet: { text: "Quiet", tone: "warning" },
  never: { text: "Not yet", tone: "neutral" },
};

const TH = "px-3 py-2 text-start font-medium text-muted-foreground text-xs";

async function EventTable({
  health,
  phrase,
  droppedHref,
  now,
  zone,
}: {
  health: Promise<EventHealth>;
  phrase: string;
  droppedHref: string | null;
  now: number;
  zone: TimeZone;
}) {
  const { rows } = await health;
  if (rows.length === 0) return <p className="text-muted-foreground text-sm">No events in the catalog yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-border border-b">
            <th className={TH}>Event</th>
            <th className={TH}>Receiving</th>
            <th className={TH}>Last 7 days</th>
            <th className={TH}>Last seen</th>
            <th className={`${TH} text-end`}>Dropped {phrase}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <EventRow droppedHref={droppedHref} key={row.id} now={now} row={row} zone={zone} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EventRow({ row, droppedHref, now, zone }: { row: EventHealthRow; droppedHref: string | null; now: number; zone: TimeZone }) {
  const { volume } = row;
  const arrival = ARRIVAL[volume.arrival];
  const week = volume.daily.reduce((sum, day) => sum + day, 0);
  const seen = volume.lastSeenAt === null ? null : formatTimestamp(Date.parse(volume.lastSeenAt), now, zone);
  return (
    <tr className="border-border border-b last:border-0">
      <td className="px-3 py-2">
        <Link className="flex flex-col hover:underline" href={`/v2/data/events/${encodeURIComponent(row.id)}`}>
          <span className="font-medium">{row.label}</span>
          <span className="font-mono text-muted-foreground text-xs">{row.name}</span>
        </Link>
      </td>
      <td className="px-3 py-2">
        <StatusBadge tone={arrival.tone}>{arrival.text}</StatusBadge>
      </td>
      <td className="px-3 py-2">
        <span className="flex items-center gap-2">
          <KpiSparkline
            className="h-6 w-18"
            label={row.label}
            points={volume.daily.map((value, index) => ({ label: `Day ${index + 1}`, value }))}
            unit="count"
          />
          <span className="font-heading tabular-nums">{formatCount(week)}</span>
        </span>
      </td>
      <td className="px-3 py-2 text-muted-foreground">{seen === null ? "Not yet" : <time title={seen.exact}>{seen.text}</time>}</td>
      <td className="px-3 py-2 text-end">
        <span className="inline-flex items-center gap-2">
          <span className="font-heading tabular-nums">{formatCount(volume.dropped)}</span>
          {volume.dropped > 0 && droppedHref && (
            <Link className="font-medium text-primary text-xs hover:underline" href={droppedHref} scroll={false}>
              See why
            </Link>
          )}
        </span>
      </td>
    </tr>
  );
}
