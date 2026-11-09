import { cookies } from "next/headers";
import { readTombstoneKey } from "@/features/data-import/model/privacy";
import { parseLogFilter, type LogFilter } from "@/features/data-import/model/privacyLog";
import { loadPrivacyPage } from "@/features/data-import/model/privacyServer";
import { AccessLogCard, DeleteCard, PrivacyFacts, RequestsCard } from "@/features/data-import/ui/privacy/PrivacyView";
import { toCheckedAdmin, type CheckedAdmin } from "@/shared/auth/types";
import { parseTimeZone, TZ_COOKIE, type TimeZone } from "@/shared/lib/time-range";
import { DataRegion } from "@/shared/ui/v2/DataRegion";
import { PageHeader } from "@/shared/ui/v2/PageHeader";
import { Forbidden, TableSkeleton } from "@/shared/ui/v2/states";
import { openRoute } from "@/widgets/v2-shell/model/viewer";

export const dynamic = "force-dynamic";

// DIM-FR-21 to DIM-FR-23, DIM-FR-25, DIM-FR-28: admins only. An editor gets the forbidden state
// before the page reads anything.
export default async function V2PrivacyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await openRoute("privacy");
  const admin = viewer && toCheckedAdmin(viewer);
  if (!admin) return <Forbidden message="Privacy holds the access log and deletion requests." />;
  const [cookieStore, params] = await Promise.all([cookies(), searchParams]);
  const zone = parseTimeZone(cookieStore.get(TZ_COOKIE)?.value);

  return (
    <>
      <PageHeader
        description="Emails, phones and other personal data from your datasets stay masked everywhere in Studio, for admins too. Here you delete a person's imported data and see every time someone looked at a clear value."
        preview
        title="Privacy"
      />
      <PrivacyFacts />
      <DataRegion errorMessage="Privacy could not load." loading={<TableSkeleton rows={6} />}>
        <Privacy admin={admin} filter={parseLogFilter(params.action)} zone={zone} />
      </DataRegion>
    </>
  );
}

async function Privacy({ admin, filter, zone }: { admin: CheckedAdmin; filter: LogFilter; zone: TimeZone }) {
  const page = await loadPrivacyPage(admin, filter);
  return (
    <>
      <div className="flex flex-wrap items-start gap-4">
        <DeleteCard configured={readTombstoneKey().configured} />
        <RequestsCard requests={page.requests} zone={zone} />
      </div>
      <AccessLogCard counts={page.counts} filter={filter} log={page.log} zone={zone} />
    </>
  );
}
