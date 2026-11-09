import Link from "next/link";
import { cookies } from "next/headers";
import { ArrowUpRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { loadSourceKeys } from "@/features/data-health/model/catalogServer";
import { parseTrackingConfig } from "@/features/data-ingestion/model/trackingConfig";
import { CreateSourceKeyDialog } from "@/features/data-ingestion/ui/CreateSourceKeyDialog";
import { RevokeSourceKeyButton } from "@/features/data-ingestion/ui/RevokeSourceKeyButton";
import { SendDataGuide } from "@/features/data-ingestion/ui/SendDataGuide";
import { SourceKeysTable } from "@/features/data-ingestion/ui/SourceKeysTable";
import { parseTimeZone, TZ_COOKIE, type TimeZone } from "@/shared/lib/time-range";
import { DataRegion } from "@/shared/ui/v2/DataRegion";
import { PageHeader } from "@/shared/ui/v2/PageHeader";
import { SectionCard } from "@/shared/ui/v2/SectionCard";
import { Forbidden, TableSkeleton } from "@/shared/ui/v2/states";
import { openRoute } from "@/widgets/v2-shell/model/viewer";

export const dynamic = "force-dynamic";

// DHL-FR-04: admins only, and an editor gets the forbidden state before any key is read. Create and
// revoke write only through the data ingestion API's source key actions (DHL-FR-12).
export default async function V2SourcesPage() {
  if (!(await openRoute("sources"))) return <Forbidden />;
  const cookieStore = await cookies();
  const zone = parseTimeZone(cookieStore.get(TZ_COOKIE)?.value);
  const config = parseTrackingConfig(process.env);

  return (
    <>
      <PageHeader
        actions={
          <>
            <Button render={<Link href="/admin/source-keys" />} variant="outline">
              Manage in classic
              <ArrowUpRightIcon aria-hidden />
            </Button>
            <CreateSourceKeyDialog />
          </>
        }
        description="The systems that send events to Studio through its API, like your order service or inventory system. Each one has its own secret key. Your website and app send through the tracker and need no key here."
        title="Sources"
      />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <DataRegion
          errorMessage="Source keys could not load."
          loading={
            <SectionCard flush title="Source keys">
              <TableSkeleton />
            </SectionCard>
          }
        >
          <SourceKeys zone={zone} />
        </DataRegion>
        <SendDataGuide origin={config.ingestOrigin} />
      </div>
    </>
  );
}

async function SourceKeys({ zone }: { zone: TimeZone }) {
  return (
    <SourceKeysTable
      create={<CreateSourceKeyDialog />}
      keys={await loadSourceKeys()}
      revoke={(key) => <RevokeSourceKeyButton appId={key.appId} id={key.id} />}
      zone={zone}
    />
  );
}
