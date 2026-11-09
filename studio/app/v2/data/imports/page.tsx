import Link from "next/link";
import { cookies } from "next/headers";
import { Button } from "@/components/ui/button";
import { parseRunQuery, type RunQuery } from "@/features/data-import/model/imports";
import { loadImportsPage } from "@/features/data-import/model/importsServer";
import { ImportsView } from "@/features/data-import/ui/imports/ImportsView";
import { parseTimeZone, TZ_COOKIE, zoneLabel, type TimeZone } from "@/shared/lib/time-range";
import { DataRegion } from "@/shared/ui/v2/DataRegion";
import { PageHeader } from "@/shared/ui/v2/PageHeader";
import { TableSkeleton } from "@/shared/ui/v2/states";
import { openRoute } from "@/widgets/v2-shell/model/viewer";

export const dynamic = "force-dynamic";

// DIM-FR-20, DIM-FR-24, DIM-FR-25: every staff user reads the runs and the passes. Only an admin
// gets the approve, discard, and retry controls, and each action checks the role again itself.
export default async function V2ImportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await openRoute("imports");
  if (!viewer) return null;
  const [cookieStore, params] = await Promise.all([cookies(), searchParams]);
  const zone = parseTimeZone(cookieStore.get(TZ_COOKIE)?.value);
  const admin = viewer.role === "admin";

  return (
    <>
      <PageHeader
        actions={
          admin ? (
            <Button render={<Link href="/v2/data/datasets" />} variant="outline">
              Upload a file
            </Button>
          ) : undefined
        }
        description={`Every file your shop sent, what Studio did with it, and the nightly pass that turns stored rows into the values conditions use. ${zoneLabel(zone)}.`}
        preview
        title="Imports"
      />
      <DataRegion errorMessage="Imports could not load." loading={<TableSkeleton rows={8} />}>
        <Imports admin={admin} query={parseRunQuery(params)} zone={zone} />
      </DataRegion>
    </>
  );
}

async function Imports({ admin, query, zone }: { admin: boolean; query: RunQuery; zone: TimeZone }) {
  const page = await loadImportsPage(query);
  return (
    <ImportsView
      admin={admin}
      counts={page.counts}
      datasets={page.datasets}
      passes={page.passes}
      query={query}
      runs={page.runs}
      staleness={page.staleness}
      zone={zone}
    />
  );
}
