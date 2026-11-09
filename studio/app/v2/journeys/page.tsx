import Link from "next/link";
import { cookies } from "next/headers";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { serverDraftRows, type DraftJourney } from "@/features/journey-analytics/model/journeyList";
import { loadPublishedJourneys } from "@/features/journey-analytics/model/server";
import { CLASSIC_CREATE_HREF, JourneyList } from "@/features/journey-analytics/ui/JourneyList";
import { listMyDrafts } from "@/features/journeys/model/drafts";
import { templateByKey } from "@/features/journeys/model/templates";
import { parseTimeZone, TZ_COOKIE, type TimeZone } from "@/shared/lib/time-range";
import { DataRegion } from "@/shared/ui/v2/DataRegion";
import { PageHeader } from "@/shared/ui/v2/PageHeader";
import { TableSkeleton } from "@/shared/ui/v2/states";
import type { AdminSession } from "@/shared/auth/types";
import { JOURNEY_NEW, stageLets } from "@/widgets/v2-shell/model/routes";
import { requireViewer, viewerReach } from "@/widgets/v2-shell/model/viewer";

export const dynamic = "force-dynamic";

// JBD-FR-18, CMP-FR-08: every journey the viewer may see, with the lifecycle actions. Create journey,
// the server drafts, and Duplicate need the v2 create page and builder, which are at stage preview,
// so a viewer they do not let through keeps the classic builder for those (SHL-FR-22).
export default async function V2JourneysPage() {
  const [viewer, reach, cookieStore] = await Promise.all([requireViewer(), viewerReach(), cookies()]);
  const zone = parseTimeZone(cookieStore.get(TZ_COOKIE)?.value);
  const canBuild = stageLets(JOURNEY_NEW.stage, reach.preview);
  const createHref = canBuild ? JOURNEY_NEW.href : CLASSIC_CREATE_HREF;

  return (
    <>
      <PageHeader
        actions={
          <Button render={<Link href={createHref} />}>
            <PlusIcon aria-hidden />
            Create journey
          </Button>
        }
        description="Every published journey, and your own drafts. A journey sends messages to people after something they do, like adding to cart."
        title="Journeys"
      />
      <DataRegion errorMessage="Journeys could not load. Your journeys are safe. Try again in a moment." loading={<TableSkeleton rows={8} />}>
        <Journeys canBuild={canBuild} createHref={createHref} viewer={viewer} zone={zone} />
      </DataRegion>
    </>
  );
}

async function Journeys({ viewer, zone, canBuild, createHref }: { viewer: AdminSession; zone: TimeZone; canBuild: boolean; createHref: string }) {
  const [{ now, journeys }, stored] = await Promise.all([loadPublishedJourneys(zone), canBuild ? listMyDrafts(viewer.userId) : []]);
  const drafts: DraftJourney[] = serverDraftRows(stored, journeys, (key) => templateByKey(key)?.name);
  return (
    <JourneyList
      canBuild={canBuild}
      createHref={createHref}
      drafts={drafts}
      now={now}
      published={journeys}
      viewer={{ userId: viewer.userId, role: viewer.role }}
      viewerEmail={viewer.email}
      zone={zone}
    />
  );
}
