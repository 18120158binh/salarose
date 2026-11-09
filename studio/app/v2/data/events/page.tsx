import Link from "next/link";
import { cookies } from "next/headers";
import { ArrowRightIcon, LockIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { parseCatalogQuery, type CatalogQuery } from "@/features/data-health/model/catalog";
import { loadCatalogPage } from "@/features/data-health/model/catalogServer";
import type { EventHealth } from "@/features/data-health/model/eventHealth";
import { droppedInLast } from "@/features/data-health/model/monitoringServer";
import { loadEventHealth } from "@/features/data-health/model/volumeServer";
import { EventCatalog } from "@/features/data-health/ui/EventCatalog";
import { AddEventDialog } from "@/features/event-management/ui/AddEventDialog";
import { formatCount, type Reading } from "@/shared/lib/format";
import { parseTimeZone, TZ_COOKIE, type TimeZone } from "@/shared/lib/time-range";
import { DataRegion } from "@/shared/ui/v2/DataRegion";
import { PageHeader } from "@/shared/ui/v2/PageHeader";
import { NotAvailable, RegionSkeleton, TableSkeleton } from "@/shared/ui/v2/states";
import { requireViewer } from "@/widgets/v2-shell/model/viewer";

export const dynamic = "force-dynamic";

// DHL-FR-01, DHL-FR-02, CAT-FR-10: every staff user reads the catalog here. An admin also gets
// Add event and a row menu, and a row opens the event's detail page for the changes. An editor's
// row opens the read-only side sheet until the shell's preview check lets an editor reach the
// detail page. The pipeline dashboards moved to Monitoring (DHL-FR-03).
export default async function V2EventsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [viewer, cookieStore, params] = await Promise.all([requireViewer(), cookies(), searchParams]);
  const zone = parseTimeZone(cookieStore.get(TZ_COOKIE)?.value);
  const query = parseCatalogQuery(params);
  const admin = viewer.role === "admin";

  return (
    <>
      <PageHeader
        actions={
          admin ? (
            <>
              <Button render={<Link href="/v2/data/sources" />} variant="outline">
                How to send events
              </Button>
              <AddEventDialog />
            </>
          ) : undefined
        }
        description="The actions your website, app and other systems send to Studio, like a product view or a finished order. Journeys and segments can only use events listed here."
        title="Events"
      />
      {!admin && (
        <p className="flex items-center gap-2 rounded-card border border-border bg-card px-4 py-2.5 text-muted-foreground text-sm">
          <LockIcon aria-hidden className="size-4" />
          You can read every event and its fields. Only admins can add or change events.
        </p>
      )}
      <DataHealthStrip zone={zone} />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <DataRegion errorMessage="The event catalog could not load." loading={<TableSkeleton rows={8} />}>
          <Catalog admin={admin} query={query} zone={zone} />
        </DataRegion>
        <HowEventsReachJourneys />
      </div>
    </>
  );
}

const DAY_MS = 86_400_000;

// DHL-FR-01, DHL-FR-14: the slim strip that links to Monitoring, with the catalog events receiving
// data today, the quiet ones, and the records dropped in the last 24 hours.
function DataHealthStrip({ zone }: { zone: TimeZone }) {
  const health = loadEventHealth("today", zone);
  const dropped = droppedInLast(DAY_MS);
  health.catch(() => {});
  return (
    <section aria-label="Data health" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card border border-border bg-card px-4 py-2.5 text-sm">
      <b className="font-heading font-semibold">Data health</b>
      <DataRegion errorMessage="Data health could not load." loading={<RegionSkeleton className="h-4 w-56" />}>
        <HealthCounts dropped={dropped} health={health} />
      </DataRegion>
      <Link className="ml-auto inline-flex items-center gap-1 font-medium text-primary hover:underline" href="/v2/data/monitoring">
        Open monitoring
        <ArrowRightIcon aria-hidden className="size-3" />
      </Link>
    </section>
  );
}

async function HealthCounts({ health, dropped }: { health: Promise<EventHealth>; dropped: Promise<Reading<number>> }) {
  const [{ receiving, quiet }, drops] = await Promise.all([health, dropped]);
  const num = "font-heading font-semibold tabular-nums";
  return (
    <span className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
      <span>
        <span className={`${num} text-foreground`}>{formatCount(receiving)}</span> receiving
      </span>
      <span aria-hidden>·</span>
      <span>
        <span className={`${num} text-foreground`}>{formatCount(quiet.length)}</span> quiet
      </span>
      <span aria-hidden>·</span>
      {drops.available ? (
        <span>
          <span className={`${num} text-foreground`}>{formatCount(drops.value)}</span> dropped in 24 h
        </span>
      ) : (
        <NotAvailable reason={drops.reason} />
      )}
    </span>
  );
}

function HowEventsReachJourneys() {
  const steps = [
    <>
      Your website, app or a server sends an event, like <span className="font-mono">com.acme/add_to_cart</span>.
    </>,
    <>
      If the event is <b>Strict</b>, Studio checks its fields and drops it when they don&apos;t fit. Otherwise every event is accepted.
    </>,
    <>Journeys and segments react to it within seconds.</>,
  ];
  return (
    <aside className="flex flex-col gap-3 rounded-card border border-border bg-card p-4">
      <h2 className="font-heading font-semibold text-[0.9375rem]">How an event reaches a journey</h2>
      <ol className="flex flex-col gap-2.5 text-sm">
        {steps.map((step, index) => (
          <li className="flex gap-2.5" key={index}>
            <span className="font-heading font-semibold text-primary tabular-nums">{index + 1}</span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </aside>
  );
}

async function Catalog({ admin, query, zone }: { admin: boolean; query: CatalogQuery; zone: TimeZone }) {
  return (
    <EventCatalog
      addEvent={admin ? <AddEventDialog /> : undefined}
      catalog={await loadCatalogPage(query)}
      openDetail={admin}
      query={query}
      rowMenu={admin}
      zone={zone}
    />
  );
}
