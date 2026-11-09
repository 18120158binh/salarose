import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ArrowLeftIcon, PauseIcon, RouteIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { JourneySummary, PublishedStatus } from "@/features/journey-analytics/model/journeyList";
import {
  ANALYTICS_RANGES,
  analyticsRangeLabel,
  analyticsSpan,
  parseAnalyticsRange,
  type AnalyticsRange,
} from "@/features/journey-analytics/model/range";
import { loadJourneyAnalytics, loadJourneySummary } from "@/features/journey-analytics/model/server";
import { JourneyAnalytics } from "@/features/journey-analytics/ui/JourneyAnalytics";
import { managesJourney } from "@/features/journey-analytics/model/journeyList";
import { JourneyActions } from "@/features/journeys/ui/JourneyActions";
import { formatTimestamp } from "@/shared/lib/format";
import { parseTimeZone, TZ_COOKIE, zoneLabel, type Span, type TimeZone } from "@/shared/lib/time-range";
import { DataRegion } from "@/shared/ui/v2/DataRegion";
import { PageHeader } from "@/shared/ui/v2/PageHeader";
import { RangePicker } from "@/shared/ui/v2/RangePicker";
import { StatusBadge, type StatusTone } from "@/shared/ui/v2/StatusBadge";
import { RegionEmpty, TableSkeleton } from "@/shared/ui/v2/states";
import { JOURNEY_NEW, stageLets } from "@/widgets/v2-shell/model/routes";
import { requireViewer, viewerReach } from "@/widgets/v2-shell/model/viewer";

export const dynamic = "force-dynamic";

const STATUS: Record<PublishedStatus, { tone: StatusTone; label: string }> = {
  active: { tone: "success", label: "Active" },
  paused: { tone: "warning", label: "Paused" },
};

// SHL-FR-15: the range ends at the time of the request. The page is dynamic, so it renders once per request.
function spanAtRequest(range: AnalyticsRange, zone: TimeZone): { now: number; span: Span | null } {
  const now = Date.now();
  return { now, span: analyticsSpan(range, now, zone) };
}

function analyticsHref(id: string): (range: AnalyticsRange) => string {
  return (range) => `/v2/journeys/${encodeURIComponent(id)}?range=${range}`;
}

// JBD-FR-19 to JBD-FR-24: the numbers of one published journey for any staff user, with Pause or
// Resume and Delete for its owner or an admin, and Duplicate to edit for anyone the v2 builder lets
// through. No control links to the classic builder (JBD-FR-23).
export default async function V2JourneyAnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [viewer, cookieStore, { id }, query] = await Promise.all([requireViewer(), cookies(), params, searchParams]);
  const href = analyticsHref(id);
  const { range, rewrite } = parseAnalyticsRange(query.range);
  if (rewrite) redirect(href(range));

  const journey = await loadJourneySummary(id);
  if (journey === null) return <JourneyNotFound />;

  const zone = parseTimeZone(cookieStore.get(TZ_COOKIE)?.value);
  const { now, span } = spanAtRequest(range, zone);
  const reach = await viewerReach();

  return (
    <>
      <BackToJourneys />
      <PageHeader
        actions={
          <JourneyActions
            canBuild={stageLets(JOURNEY_NEW.stage, reach.preview)}
            id={journey.id}
            manages={managesJourney(journey, viewer)}
            name={journey.name}
            status={journey.status}
          />
        }
        controls={
          <div className="flex w-full flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-3">
              <RangePicker href={href} label={analyticsRangeLabel} options={ANALYTICS_RANGES} value={range} zone={zone} />
              <span className="text-muted-foreground text-xs">Times in {zoneLabel(zone)}</span>
            </div>
            <p className="text-muted-foreground text-xs">
              Entered: people who reached a step in this range. Waiting: still there now. Completed: moved past it.
            </p>
          </div>
        }
        description={<JourneyFacts journey={journey} now={now} zone={zone} />}
        title={journey.name}
      />
      {journey.status === "paused" && (
        <div className="flex items-center gap-2 rounded-card border border-warning/30 bg-warning/10 px-4 py-3 text-sm" role="status">
          <PauseIcon aria-hidden className="size-4 shrink-0 text-warning" />
          <span>
            <b>Paused.</b> Nobody new enters and nobody moves on until it is resumed.
          </span>
        </div>
      )}
      <DataRegion errorMessage="Journey analytics could not load." loading={<TableSkeleton rows={6} />}>
        <Analytics id={id} rangeLabel={analyticsRangeLabel(range)} span={span} />
      </DataRegion>
    </>
  );
}

async function Analytics({ id, span, rangeLabel }: { id: string; span: Span | null; rangeLabel: string }) {
  const { nodes, removed } = await loadJourneyAnalytics(id, span);
  return <JourneyAnalytics rangeLabel={rangeLabel} removed={removed} steps={nodes} />;
}

function JourneyFacts({ journey, now, zone }: { journey: JourneySummary; now: number; zone: TimeZone }) {
  const status = STATUS[journey.status];
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
      <span>Owner: {journey.ownerEmail ?? "No owner"}</span>
      {journey.updatedAt !== null && <LastChange at={journey.updatedAt} now={now} zone={zone} />}
      <span className="basis-full">A published journey can&apos;t be edited. Duplicate it to make changes.</span>
    </span>
  );
}

function LastChange({ at, now, zone }: { at: number; now: number; zone: TimeZone }) {
  const { text, exact } = formatTimestamp(at, now, zone);
  return (
    <span>
      Last change:{" "}
      <time dateTime={new Date(at).toISOString()} title={exact}>
        {text}
      </time>
    </span>
  );
}

function BackToJourneys() {
  return (
    <Link
      className="-mb-3 inline-flex w-fit items-center gap-1 rounded-sm text-muted-foreground text-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      href="/v2/journeys"
    >
      <ArrowLeftIcon aria-hidden className="size-4" />
      Journeys
    </Link>
  );
}

function JourneyNotFound() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <RegionEmpty
        action={
          <Button render={<Link href="/v2/journeys" />} size="sm" variant="outline">
            Go to Journeys
          </Button>
        }
        icon={RouteIcon}
        message="This journey does not exist. It may have been deleted, or the link is wrong."
      />
    </div>
  );
}
