import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { searchCustomers } from "@/features/customer-lookup/model/server";
import { BeforeSearch, NoMatch, SearchAside, SearchCard, SearchResults } from "@/features/customer-lookup/ui/CustomerSearch";
import { customerHref } from "@/features/customer-lookup/ui/CustomerTables";
import { parseTimeZone, TZ_COOKIE } from "@/shared/lib/time-range";
import { PageHeader } from "@/shared/ui/v2/PageHeader";
import { requireViewer } from "@/widgets/v2-shell/model/viewer";

export const dynamic = "force-dynamic";

// SHL-FR-15: `now` is the time of the request. The page is dynamic, so it renders once per request.
function requestTime(): number {
  return Date.now();
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// CUS-FR-01 to CUS-FR-03: `?q=` runs the search on load, so links and the command palette can start
// one. One match opens the profile. The page only reads.
export default async function V2CustomersPage({ searchParams }: { searchParams: SearchParams }) {
  const [, cookieStore, params] = await Promise.all([requireViewer(), cookies(), searchParams]);
  const query = typeof params.q === "string" ? params.q.trim() : "";
  const matches = query === "" ? null : await searchCustomers(query);
  if (matches?.length === 1) redirect(customerHref(matches[0].canonId));

  return (
    <>
      <PageHeader
        description="Find a shopper by id, email, phone or name, and see what Studio did for them: their activity, devices and accounts, every journey they entered with the step they are at, the messages they received, their segments and their behavior numbers. Useful when a shopper asks why they got a message twice, or never got it."
        title="Customers"
      />
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 flex-[2.4_1_560px] flex-col gap-4">
          <SearchCard query={query} />
          {matches === null ? (
            <BeforeSearch />
          ) : matches.length === 0 ? (
            <NoMatch query={query} />
          ) : (
            <SearchResults matches={matches} now={requestTime()} query={query} zone={parseTimeZone(cookieStore.get(TZ_COOKIE)?.value)} />
          )}
        </div>
        <SearchAside />
      </div>
    </>
  );
}
