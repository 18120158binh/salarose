import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { activeJourneys, engineLag, kpiCounts, pipelineHealth, recentJourneys } from "@/features/home-overview/model/server";
import { entriesKpi, messagesKpi, watchKpi } from "@/features/home-overview/model/home";
import { HealthStrip } from "@/features/home-overview/ui/HealthStrip";
import { ContinueList, JourneysTable, SectionHeader, ViewAllJourneys } from "@/features/home-overview/ui/JourneyLists";
import { CountKpiCard, LagKpiCard } from "@/features/home-overview/ui/KpiCards";
import { computeRange, parseRange, parseTimeZone, RANGE_KEYS, rangeLabel, TZ_COOKIE, type RangeKey, type TimeRange, type TimeZone } from "@/shared/lib/time-range";
import { DataRegion } from "@/shared/ui/v2/DataRegion";
import { KpiCardSkeleton, KpiRow } from "@/shared/ui/v2/KpiCard";
import { PageHeader } from "@/shared/ui/v2/PageHeader";
import { RangePicker } from "@/shared/ui/v2/RangePicker";
import { RegionSkeleton, TableSkeleton } from "@/shared/ui/v2/states";
import { Button } from "@/components/ui/button";
import { PreviewBadge } from "@/shared/ui/v2/PreviewBadge";
import { CREATE_TARGETS } from "@/widgets/v2-shell/model/palette";
import { stageLets, type Reach } from "@/widgets/v2-shell/model/routes";
import { requireViewer, viewerReach } from "@/widgets/v2-shell/model/viewer";
import Link from "next/link";

export const dynamic = "force-dynamic";

const rangeHref = (key: RangeKey) => `/v2?range=${key}`;

// SHL-FR-15: `now` is the time of the request. The page is dynamic, so it renders once per request.
function rangeAtRequest(key: RangeKey, zone: TimeZone): { now: number; range: TimeRange } {
  const now = Date.now();
  return { now, range: computeRange(key, now, zone) };
}

// Each region awaits its read inside its own boundary. The read starts here, before React reaches
// the boundary, so a rejection is marked handled now and rethrown to the awaiting region.
function started<T>(read: Promise<T>): Promise<T> {
  read.catch(() => {});
  return read;
}

// The home overview (HOM-FR-01): the KPI row, the health strip, the active journeys, and the
// viewer's own journeys, each loading and failing on its own.
export default async function V2HomePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [viewer, reach, cookieStore, params] = await Promise.all([requireViewer(), viewerReach(), cookies(), searchParams]);
  const { key, rewrite } = parseRange(params.range);
  if (rewrite) redirect(rangeHref(key));

  const zone = parseTimeZone(cookieStore.get(TZ_COOKIE)?.value);
  const { now, range } = rangeAtRequest(key, zone);

  const counts = started(kpiCounts(range));
  const lag = started(engineLag(range));
  const health = started(pipelineHealth(now));
  const journeys = started(activeJourneys(range, now));
  const recent = started(recentJourneys(viewer.userId));

  return (
    <>
      <PageHeader
        controls={<RangePicker href={rangeHref} label={rangeLabel} options={RANGE_KEYS} value={key} zone={zone} />}
        actions={<CreateJourney reach={reach} />}
        description="How your journeys did, and whether the pipeline keeps up."
        title="Home"
      />
      <KpiRow>
        <DataRegion errorMessage="Entries could not load" loading={<KpiCardSkeleton />}>
          <CountKpiCard counts={counts} view={entriesKpi} />
        </DataRegion>
        <DataRegion errorMessage="Messages requested could not load" loading={<KpiCardSkeleton />}>
          <CountKpiCard counts={counts} view={messagesKpi} />
        </DataRegion>
        <DataRegion errorMessage="Watch success could not load" loading={<KpiCardSkeleton />}>
          <CountKpiCard counts={counts} view={watchKpi} />
        </DataRegion>
        <DataRegion errorMessage="Engine lag could not load" loading={<KpiCardSkeleton />}>
          <LagKpiCard lag={lag} />
        </DataRegion>
      </KpiRow>
      <DataRegion errorMessage="Pipeline health could not load" loading={<RegionSkeleton className="h-12" />}>
        <HealthStrip health={health} now={now} viewer={reach} zone={zone} />
      </DataRegion>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section aria-labelledby="active-journeys" className="flex min-w-0 flex-col gap-3">
          <SectionHeader action={<ViewAllJourneys viewer={reach} />} description="Biggest change first, up to 10" id="active-journeys" title="Active journeys" />
          <DataRegion errorMessage="Active journeys could not load" loading={<TableSkeleton />}>
            <JourneysTable journeys={journeys} viewer={viewer} />
          </DataRegion>
          <p className="text-muted-foreground text-xs">Entries and messages count the selected range. Change compares entries with the period before.</p>
        </section>
        <section aria-labelledby="continue" className="flex min-w-0 flex-col gap-3">
          <SectionHeader id="continue" title="Continue where you left off" />
          <DataRegion errorMessage="Your recent journeys could not load" loading={<RegionSkeleton className="h-72" />}>
            <ContinueList journeys={recent} now={now} zone={zone} />
          </DataRegion>
        </section>
      </div>
      <p className="text-muted-foreground text-xs">
        Messages requested counts what journeys asked the sender to send. Delivery, opens, clicks and revenue aren&apos;t reported back to Studio yet.
      </p>
    </>
  );
}

const CREATE_JOURNEY = CREATE_TARGETS.find((target) => target.id === "create-journey")!;

// HOM-FR-11: Create journey opens /v2/journeys/new, so it shows only once that route's stage lets
// the viewer reach it, with the Preview badge while it is at preview.
function CreateJourney({ reach }: { reach: Reach }) {
  if (!stageLets(CREATE_JOURNEY.stage, reach.preview)) return null;
  return (
    <Button render={<Link href={CREATE_JOURNEY.href} />} size="sm">
      Create journey
      {CREATE_JOURNEY.stage === "preview" && <PreviewBadge />}
    </Button>
  );
}
