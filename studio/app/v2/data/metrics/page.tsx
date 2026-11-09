import { cookies } from "next/headers";
import { loadMetricsPage } from "@/features/data-import/model/metricsServer";
import { METRIC_PAGE_DESCRIPTION } from "@/features/data-import/model/metrics";
import { MetricsView } from "@/features/data-import/ui/metrics/MetricsView";
import { parseTimeZone, TZ_COOKIE, type TimeZone } from "@/shared/lib/time-range";
import { DataRegion } from "@/shared/ui/v2/DataRegion";
import { PageHeader } from "@/shared/ui/v2/PageHeader";
import { TableSkeleton } from "@/shared/ui/v2/states";
import { openRoute } from "@/widgets/v2-shell/model/viewer";

export const dynamic = "force-dynamic";

// DIM-FR-17, DIM-FR-18, CMP-FR-21 to CMP-FR-23: every staff user reads both kinds of metric here,
// and creates, edits, archives, and unarchives dataset metrics. Each action checks the session itself.
export default async function V2MetricsPage() {
  await openRoute("metrics");
  const cookieStore = await cookies();
  const zone = parseTimeZone(cookieStore.get(TZ_COOKIE)?.value);

  return (
    <DataRegion
      errorMessage="Metrics could not load."
      loading={
        <>
          <PageHeader description={METRIC_PAGE_DESCRIPTION} preview title="Metrics" />
          <TableSkeleton rows={8} />
        </>
      }
    >
      <Metrics zone={zone} />
    </DataRegion>
  );
}

async function Metrics({ zone }: { zone: TimeZone }) {
  const page = await loadMetricsPage();
  return <MetricsView datasets={page.datasets} metrics={page.metrics} zone={zone} />;
}
