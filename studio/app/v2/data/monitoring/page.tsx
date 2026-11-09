import { Suspense } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { pipelineDashboards } from "@/features/data-health/model/catalogServer";
import { deadLetterAccess } from "@/features/data-health/model/deadLetterAccess";
import { DEAD_LETTER_WINDOWS, DEFAULT_QUERY, parseDeadLetterQuery, windowLabel, type DeadLetterQuery } from "@/features/data-health/model/deadLetterQuery";
import { retentionSentence } from "@/features/data-health/model/deadLetterView";
import { MONITORING_PATH, monitoringHref, parseTab, tabsFor } from "@/features/data-health/model/monitoring";
import { droppedInWindow } from "@/features/data-health/model/monitoringServer";
import { loadEventHealth } from "@/features/data-health/model/volumeServer";
import { DashboardCards } from "@/features/data-health/ui/DashboardCards";
import { DeadLetterBrowser } from "@/features/data-health/ui/DeadLetterBrowser";
import { DeadLetterFilters } from "@/features/data-health/ui/DeadLetterFilters";
import { MonitoringOverview } from "@/features/data-health/ui/MonitoringOverview";
import { MonitoringTabs } from "@/features/data-health/ui/MonitoringTabs";
import { ReasonGuide } from "@/features/data-health/ui/ReasonGuide";
import { pipelineHealth } from "@/features/home-overview/model/server";
import { HealthStrip } from "@/features/home-overview/ui/HealthStrip";
import { toCheckedAdmin, type CheckedAdmin } from "@/shared/auth/types";
import { parseTimeZone, TZ_COOKIE, type TimeZone } from "@/shared/lib/time-range";
import { DataRegion } from "@/shared/ui/v2/DataRegion";
import { PageHeader } from "@/shared/ui/v2/PageHeader";
import { RangePicker } from "@/shared/ui/v2/RangePicker";
import { Forbidden, RegionSkeleton } from "@/shared/ui/v2/states";
import { openRoute, viewerReach } from "@/widgets/v2-shell/model/viewer";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// SHL-FR-15: the time of the request. The page is dynamic, so it renders once per request.
function requestTime(): number {
  return Date.now();
}

// A read starts before React reaches its boundary. Its rejection is marked handled here and
// rethrown to the region that awaits it.
function started<T>(read: Promise<T>): Promise<T> {
  read.catch(() => {});
  return read;
}

// DHL-FR-13: one section for event monitoring, with one window for every tab. The route guard runs
// before any read, and the Dropped data tab checks the admin role again (DHL-FR-05).
export default async function V2MonitoringPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const viewer = await openRoute("monitoring");
  if (!viewer) return <Forbidden />;

  const [cookieStore, params, reach] = await Promise.all([cookies(), searchParams, viewerReach()]);
  const query = parseDeadLetterQuery((name) => first(params[name]));
  const tab = parseTab(first(params.tab));
  if (!query || !tab) redirect(monitoringHref(tab ?? "overview", query ?? DEFAULT_QUERY));

  const admin = toCheckedAdmin(viewer);
  if (tab === "dropped" && !admin) return <Forbidden />;
  const dashboards = pipelineDashboards();
  if (!tabsFor(viewer.role, dashboards.length).includes(tab)) redirect(monitoringHref("overview", query));

  const zone = parseTimeZone(cookieStore.get(TZ_COOKIE)?.value);
  const now = requestTime();
  const dropped = started(droppedInWindow(query.window, zone, now));
  const windowHref = (window: DeadLetterQuery["window"]) => monitoringHref(tab, { ...query, window });

  return (
    <>
      <PageHeader
        controls={<RangePicker href={windowHref} label={windowLabel} options={DEAD_LETTER_WINDOWS} scope="applies to every tab" value={query.window} zone={zone} />}
        description="Is data arriving, and is anything being dropped? Check here when a journey seems quiet or after your website or app ships a change."
        preview
        title="Monitoring"
      />
      <MonitoringTabs current={tab} dropped={dropped} query={query} tabs={tabsFor(viewer.role, dashboards.length)} />
      {tab === "overview" && (
        <MonitoringOverview
          admin={admin !== null}
          dropped={dropped}
          health={started(loadEventHealth(query.window, zone))}
          now={now}
          zone={zone}
          pipeline={
            <DataRegion errorMessage="Pipeline health could not load" loading={<RegionSkeleton className="h-12" />}>
              <HealthStrip health={started(pipelineHealth(now))} note="Same strip as Home · always the last hour" now={now} viewer={reach} zone={zone} />
            </DataRegion>
          }
          query={query}
        />
      )}
      {tab === "dropped" && admin && <DroppedData admin={admin} query={query} zone={zone} />}
      {tab === "dashboards" && <DashboardCards dashboards={dashboards} />}
    </>
  );
}

const DROPPED_BASE = `${MONITORING_PATH}?tab=dropped`;

// DHL-FR-05 to DHL-FR-11: the dead-letter browser, for admins.
function DroppedData({ admin, query, zone }: { admin: CheckedAdmin; query: DeadLetterQuery; zone: TimeZone }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 text-sm">
        <p>Events and requests that reached Studio but could not be used, with the reason for each, so you can tell your developer exactly what to fix.</p>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-xs">
          <li>
            <Suspense fallback={<RegionSkeleton className="h-4 w-56" />}>
              <RetentionLine admin={admin} />
            </Suspense>
          </li>
          <li>Admins only. Can hold personal data: Studio keeps no copy and logs who opens a record.</li>
          <li>Read only: nothing here changes or replays data.</li>
        </ul>
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <DeadLetterFilters base={DROPPED_BASE} query={query} />
            <span className="text-muted-foreground text-xs">Newest first · {windowLabel(query.window)}</span>
          </div>
          <DeadLetterBrowser key={monitoringHref("dropped", query)} query={query} zone={zone} />
        </div>
        <aside>
          <ReasonGuide />
        </aside>
      </div>
    </div>
  );
}

async function RetentionLine({ admin }: { admin: CheckedAdmin }) {
  return <span>{retentionSentence(await deadLetterAccess(admin).retention())}</span>;
}
