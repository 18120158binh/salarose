import { Suspense } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { deadLetterAccess } from "@/features/data-health/model/deadLetterAccess";
import {
  DEAD_LETTER_WINDOWS,
  DEFAULT_QUERY,
  parseDeadLetterQuery,
  querySearch,
  windowLabel,
  type DeadLetterQuery,
} from "@/features/data-health/model/deadLetterQuery";
import { monitoringHref } from "@/features/data-health/model/monitoring";
import { retentionSentence } from "@/features/data-health/model/deadLetterView";
import { DeadLetterBrowser } from "@/features/data-health/ui/DeadLetterBrowser";
import { DeadLetterFilters } from "@/features/data-health/ui/DeadLetterFilters";
import type { CheckedAdmin } from "@/shared/auth/types";
import { parseTimeZone, TZ_COOKIE } from "@/shared/lib/time-range";
import { PageHeader } from "@/shared/ui/v2/PageHeader";
import { RangePicker } from "@/shared/ui/v2/RangePicker";
import { Forbidden, RegionSkeleton } from "@/shared/ui/v2/states";
import { mayReach, NAV, type NavEntry } from "@/widgets/v2-shell/model/routes";
import { adminViewer, viewerReach } from "@/widgets/v2-shell/model/viewer";

export const dynamic = "force-dynamic";

const BASE = "/v2/data/dead-letters";

// A missing entry reaches nobody, so the page keeps serving.
const MONITORING: Pick<NavEntry, "access" | "stage"> = NAV.find((entry) => entry.id === "monitoring") ?? { access: "admin", stage: "reserved" };

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// DHL-FR-05 to DHL-FR-11: what ingestion dropped and why, for admins. The page reads the topic's
// retention. The rows and each record's content load in the browser from the records and content
// routes, which check the role again and forbid storage.
export default async function V2DeadLettersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const admin = await adminViewer();
  if (!admin) return <Forbidden />;

  const [cookieStore, params, reach] = await Promise.all([cookies(), searchParams, viewerReach()]);
  const query = parseDeadLetterQuery((name) => first(params[name]));
  // DHL-FR-05: the browser lives in Monitoring's Dropped data tab. While Monitoring is at preview,
  // a viewer it does not let through keeps this page, so dropped data stays reachable.
  if (mayReach(MONITORING, reach)) redirect(monitoringHref("dropped", query ?? DEFAULT_QUERY));
  if (!query) redirect(BASE + querySearch(DEFAULT_QUERY));
  const zone = parseTimeZone(cookieStore.get(TZ_COOKIE)?.value);
  const windowHref = (window: DeadLetterQuery["window"]) => BASE + querySearch({ ...query, window });

  return (
    <>
      <PageHeader
        controls={
          <>
            <RangePicker href={windowHref} label={windowLabel} options={DEAD_LETTER_WINDOWS} value={query.window} zone={zone} />
            <DeadLetterFilters base={BASE} query={query} />
          </>
        }
        description={
          <Suspense fallback={<RegionSkeleton className="h-5 w-80 max-w-full" />}>
            <RetentionLine admin={admin} />
          </Suspense>
        }
        title="Dead letters"
      />
      <DeadLetterBrowser key={querySearch(query)} query={query} zone={zone} />
    </>
  );
}

async function RetentionLine({ admin }: { admin: CheckedAdmin }) {
  return <p>{retentionSentence(await deadLetterAccess(admin).retention())}</p>;
}
