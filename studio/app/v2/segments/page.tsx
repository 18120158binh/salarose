import Link from "next/link";
import { cookies } from "next/headers";
import { ArrowUpRightIcon, PlusIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { loadSegmentRows } from "@/features/segments/model/server";
import { SegmentList } from "@/features/segments/ui/SegmentList";
import { parseTimeZone, TZ_COOKIE } from "@/shared/lib/time-range";
import { DataRegion } from "@/shared/ui/v2/DataRegion";
import { PageHeader } from "@/shared/ui/v2/PageHeader";
import { PreviewBadge } from "@/shared/ui/v2/PreviewBadge";
import { SectionCard } from "@/shared/ui/v2/SectionCard";
import { TableSkeleton } from "@/shared/ui/v2/states";
import { classicHref, SEGMENT_EDITOR, stageLets } from "@/widgets/v2-shell/model/routes";
import { viewerReach } from "@/widgets/v2-shell/model/viewer";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// SEG-FR-01: the list, with New segment, Edit, and Delete for viewers who may reach the editor
// (stage preview). Everyone else changes segments in the classic studio until cutover.
// `?segment=` marks one segment, so the command palette can open it (SHL-FR-07).
export default async function V2SegmentsPage({ searchParams }: { searchParams: SearchParams }) {
  const reach = await viewerReach();
  const canEdit = stageLets(SEGMENT_EDITOR.stage, reach.preview);
  const classic = classicHref("/v2/segments", reach.role);
  return (
    <>
      <PageHeader
        actions={
          canEdit ? (
            <Button render={<Link href="/v2/segments/new" />}>
              <PlusIcon aria-hidden />
              New segment
              <PreviewBadge on="primary" />
            </Button>
          ) : (
            <Button render={<Link href={classic} />} variant="outline">
              Manage in classic studio
              <ArrowUpRightIcon aria-hidden />
            </Button>
          )
        }
        description="Segments are saved groups of shoppers, like “Hà Nội cart builders”. A journey can start when someone joins a segment, or check at any step whether someone is in it. Change a segment once and every journey that uses it follows."
        title="Segments"
      />
      {!canEdit && (
        <Alert variant="info">
          <AlertDescription>
            Creating and editing segments here is in preview. Until you have preview access, change segments in the
            classic studio. Ask an admin for access.
          </AlertDescription>
        </Alert>
      )}
      <div className="grid items-start gap-space-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <DataRegion errorMessage="Segments could not load." loading={<TableSkeleton />}>
          <Segments canEdit={canEdit} classic={classic} searchParams={searchParams} />
        </DataRegion>
        <aside className="flex flex-col gap-space-4">
          <SectionCard title="How journeys use a segment">
            <ul className="flex flex-col gap-2 text-sm">
              <li>
                <span className="font-medium">Entry trigger.</span>{" "}
                <span className="text-muted-foreground">The journey starts when a shopper joins the segment.</span>
              </li>
              <li>
                <span className="font-medium">Business-event audience.</span>{" "}
                <span className="text-muted-foreground">A business event, like a sale launch, goes to the segment&apos;s members.</span>
              </li>
              <li>
                <span className="font-medium">Condition.</span>{" "}
                <span className="text-muted-foreground">A step checks whether the shopper is in the segment right now.</span>
              </li>
            </ul>
            <p className="mt-3 text-muted-foreground text-xs">
              A segment can&apos;t be deleted while an active or paused journey uses it.
            </p>
          </SectionCard>
          <SectionCard title="Size">
            <p className="text-sm">Size shows once membership is stored. Until then the list has no Size column.</p>
            <p className="mt-2 text-muted-foreground text-xs">
              Size never decides who enters a journey. Journeys check each shopper&apos;s own data at the moment they act.
            </p>
          </SectionCard>
        </aside>
      </div>
    </>
  );
}

async function Segments({ searchParams, canEdit, classic }: { searchParams: SearchParams; canEdit: boolean; classic: string }) {
  const [cookieStore, params] = await Promise.all([cookies(), searchParams]);
  const rows = await loadSegmentRows(parseTimeZone(cookieStore.get(TZ_COOKIE)?.value));
  return <SegmentList canEdit={canEdit} classicHref={classic} rows={rows} selected={typeof params.segment === "string" ? params.segment : undefined} />;
}
