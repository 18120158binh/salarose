import Link from "next/link";
import { cookies } from "next/headers";
import { InfoIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { eventsUrl } from "@/features/data-ingestion/model/ingestAddress";
import { parseTrackingConfig } from "@/features/data-ingestion/model/trackingConfig";
import { loadEventVolumes } from "@/features/data-health/model/volumeServer";
import { SAMPLE_EVENTS, sampleName } from "@/features/tracking-setup/model/plan";
import { loadTrackingPlan } from "@/features/tracking-setup/model/server";
import { CopyPageLink } from "@/features/tracking-setup/ui/CopyPageLink";
import { TrackingGuide } from "@/features/tracking-setup/ui/TrackingGuide";
import { DropsCard, MoreWaysCard, TrackingPlanCard } from "@/features/tracking-setup/ui/TrackingSidePanel";
import { parseTimeZone, TZ_COOKIE } from "@/shared/lib/time-range";
import { DataRegion } from "@/shared/ui/v2/DataRegion";
import { PageHeader } from "@/shared/ui/v2/PageHeader";
import { SectionCard } from "@/shared/ui/v2/SectionCard";
import { Forbidden, RegionSkeleton } from "@/shared/ui/v2/states";
import { openRoute } from "@/widgets/v2-shell/model/viewer";

export const dynamic = "force-dynamic";

// SHL-FR-15: the time of the request. The page is dynamic, so it renders once per request.
function requestTime(): number {
  return Date.now();
}

// DHL-FR-15, DHL-FR-16: every staff user at stage preview reads every step; only an admin gets the
// link to create a source key. The route guard runs before the catalog is read.
export default async function V2TrackingSetupPage() {
  const viewer = await openRoute("tracking");
  if (!viewer) return <Forbidden />;
  const admin = viewer.role === "admin";
  const plan = loadTrackingPlan();
  // Each consumer shows a rejection in its own region; this keeps it from counting as unhandled.
  plan.catch(() => undefined);
  // DHL-FR-14: step 5's live check.
  const zone = parseTimeZone((await cookies()).get(TZ_COOKIE)?.value);
  const arrivals = loadEventVolumes(SAMPLE_EVENTS.map(({ key }) => sampleName(key)), "today", zone);
  arrivals.catch(() => undefined);
  const now = requestTime();
  const config = parseTrackingConfig(process.env);

  return (
    <>
      <PageHeader
        actions={
          <>
            <CopyPageLink />
            <Button render={<Link href="/v2/data/events" />} variant="outline">
              See your events
            </Button>
          </>
        }
        description="Connect your website and your servers so Studio learns what shoppers do. Hand this page to your developer: five steps, in order. Journeys can only react to events that arrive here."
        preview
        title="Tracking setup"
      />
      {!admin && (
        <p className="flex items-center gap-2 rounded-control border border-border bg-card px-3 py-2 text-muted-foreground text-sm">
          <InfoIcon aria-hidden className="size-4 shrink-0" />
          You can read every step and copy every sample. Only admins can create the keys that servers need.
        </p>
      )}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <TrackingGuide
          admin={admin}
          appIds={config.appIds}
          arrivals={arrivals}
          eventsUrl={eventsUrl(config.ingestOrigin)}
          collector={config.collector}
          now={now}
          plan={plan}
          zone={zone}
        />
        <aside className="flex flex-col gap-4">
          <DataRegion
            errorMessage="The tracking plan could not load."
            loading={
              <SectionCard title="Your tracking plan">
                <RegionSkeleton className="h-40" />
              </SectionCard>
            }
          >
            <TrackingPlanCard admin={admin} plan={plan} />
          </DataRegion>
          <DropsCard />
          <MoreWaysCard admin={admin} />
        </aside>
      </div>
    </>
  );
}
