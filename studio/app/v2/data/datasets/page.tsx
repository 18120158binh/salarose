import Link from "next/link";
import { cookies } from "next/headers";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { loadDatasets } from "@/features/data-import/model/datasetsServer";
import { DatasetsEmpty, DatasetsList, parseKindFilter, type KindFilter } from "@/features/data-import/ui/datasets/DatasetsList";
import { parseTimeZone, TZ_COOKIE, type TimeZone } from "@/shared/lib/time-range";
import { DataRegion } from "@/shared/ui/v2/DataRegion";
import { PageHeader } from "@/shared/ui/v2/PageHeader";
import { TableSkeleton } from "@/shared/ui/v2/states";
import { openRoute } from "@/widgets/v2-shell/model/viewer";

export const dynamic = "force-dynamic";

// DIM-FR-01, DIM-FR-24, DIM-FR-25: every staff user reads the datasets. Only an admin gets New
// dataset. The route guard runs before anything is read.
export default async function V2DatasetsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await openRoute("datasets");
  if (!viewer) return null;
  const [cookieStore, params] = await Promise.all([cookies(), searchParams]);
  const zone = parseTimeZone(cookieStore.get(TZ_COOKIE)?.value);
  const admin = viewer.role === "admin";

  return (
    <>
      <PageHeader
        actions={
          admin ? (
            <>
              <Button render={<Link href="/v2/data/sources" />} variant="outline">
                How to send files
              </Button>
              <Button render={<Link href="/v2/data/datasets/new" />}>
                <PlusIcon aria-hidden />
                New dataset
              </Button>
            </>
          ) : undefined
        }
        description="The rows your shop sends once a day from its own systems, like orders from the ERP or customer records from the loyalty program. Metrics, segments and journey conditions can use them. Importing never starts a journey."
        preview
        title="Datasets"
      />
      {!admin && <p className="text-muted-foreground text-sm">You can read every dataset and its columns. Only admins can create, change or upload.</p>}
      <DataRegion errorMessage="Datasets could not load." loading={<TableSkeleton />}>
        <Datasets admin={admin} filter={parseKindFilter(params.kind)} zone={zone} />
      </DataRegion>
    </>
  );
}

async function Datasets({ admin, filter, zone }: { admin: boolean; filter: KindFilter; zone: TimeZone }) {
  const overview = await loadDatasets();
  if (overview.datasets.length === 0) return <DatasetsEmpty admin={admin} />;
  return <DatasetsList filter={filter} overview={overview} zone={zone} />;
}
