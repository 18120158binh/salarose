import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRightIcon, HistoryIcon, RouteIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatCount, formatSignedCount, formatTimestamp } from "@/shared/lib/format";
import type { TimeZone } from "@/shared/lib/time-range";
import { CellLabel, DataTable } from "@/shared/ui/v2/DataTable";
import { RegionEmpty } from "@/shared/ui/v2/states";
import { KpiSparkline } from "@/shared/ui/v2/KpiSparkline";
import { StatusBadge, type StatusTone } from "@/shared/ui/v2/StatusBadge";
import { journeyHref, liveHref, ownJourneyHref, type Reach, type Viewer } from "@/widgets/v2-shell/model/routes";
import { formatDay, type ActiveJourney, type JourneyStatus, type RecentJourney } from "../model/home";

const CREATE_JOURNEY = (
  <Button render={<Link href="/campaign/new" />} size="sm" variant="outline">
    Create journey
  </Button>
);

export function SectionHeader({ id, title, description, action }: { id: string; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-4">
      <div className="flex flex-col gap-0.5">
        <h2 className="font-heading font-semibold text-base tracking-tight" id={id}>
          {title}
        </h2>
        {description && <p className="text-muted-foreground text-xs">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function ViewAllJourneys({ viewer }: { viewer: Reach }) {
  const href = liveHref("journeys", viewer);
  if (href === null) return null;
  return (
    <Link
      className="inline-flex items-center gap-1 rounded-sm font-medium text-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      href={href}
    >
      View all
      <ArrowRightIcon aria-hidden className="size-3.5" />
    </Link>
  );
}

function ChangeCell({ change }: { change: number }) {
  return (
    <span className={cn(change > 0 && "text-success", change < 0 && "text-destructive", change === 0 && "text-muted-foreground")}>
      {formatSignedCount(change)}
    </span>
  );
}

// HOM-FR-05, HOM-FR-06: every active journey's numbers, whoever owns it.
export async function JourneysTable({ journeys, viewer }: { journeys: Promise<ActiveJourney[]>; viewer: Viewer }) {
  const rows = await journeys;
  return (
    <DataTable
      columns={[
        { id: "name", header: "Name", cell: (row) => <CellLabel label={row.name} /> },
        {
          id: "owner",
          header: "Owner",
          cell: (row) =>
            row.ownerEmail ?? <span className="text-muted-foreground">No owner</span>,
        },
        { id: "entries", header: "Entries", kind: "number", cell: (row) => formatCount(row.entries) },
        { id: "messages", header: "Messages", kind: "number", cell: (row) => formatCount(row.messages) },
        {
          id: "trend",
          header: "Last 7 days",
          cell: (row) => (
            <KpiSparkline
              className="w-28"
              label={`${row.name}, entries`}
              points={row.last7Days.map((day) => ({ label: formatDay(day.date), value: day.value }))}
              unit="count"
            />
          ),
        },
        { id: "change", header: "Change", kind: "number", cell: (row) => <ChangeCell change={row.change} /> },
      ]}
      empty={<RegionEmpty action={CREATE_JOURNEY} icon={RouteIcon} message="No journey is running. Publish one to see its numbers here." />}
      label="Active journeys"
      open={{ kind: "link", href: (row) => journeyHref(row, viewer) }}
      rowKey={(row) => row.id}
      rows={rows}
    />
  );
}

const STATUS: Record<JourneyStatus, { tone: StatusTone; label: string }> = {
  active: { tone: "success", label: "Active" },
  paused: { tone: "warning", label: "Paused" },
};

// HOM-FR-07: the viewer's own journeys, newest change first.
export async function ContinueList({ journeys, now, zone }: { journeys: Promise<RecentJourney[]>; now: number; zone: TimeZone }) {
  const rows = await journeys;
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card">
        <RegionEmpty action={CREATE_JOURNEY} icon={HistoryIcon} message="You have no journeys yet. The ones you create show here." />
      </div>
    );
  }
  return (
    <ul aria-label="Continue where you left off" className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-card text-card-foreground">
      {rows.map((journey) => {
        const changed = formatTimestamp(journey.updatedAt, now, zone);
        const status = STATUS[journey.status];
        return (
          <li className="relative flex min-h-14 items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/50" key={journey.id}>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <Link
                className="truncate rounded-sm font-medium text-sm outline-none after:absolute after:inset-0 after:content-[''] focus-visible:ring-2 focus-visible:ring-ring"
                href={ownJourneyHref(journey.id)}
              >
                {journey.name}
              </Link>
              <span className="text-muted-foreground text-xs">
                Changed <time title={changed.exact}>{changed.text}</time>
              </span>
            </div>
            <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
          </li>
        );
      })}
    </ul>
  );
}
