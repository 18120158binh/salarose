import Link from "next/link";
import { cookies } from "next/headers";
import { Suspense } from "react";
import { UserXIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { loadEntries, loadIdentities, loadMessages, loadMetrics, loadPerson } from "@/features/customer-lookup/model/server";
import type { Entry } from "@/features/customer-lookup/model/entries";
import type { Message } from "@/features/customer-lookup/model/messages";
import type { Identity, MetricRow, Shown } from "@/features/customer-lookup/model/queries";
import {
  EntryTiles,
  FindAnother,
  IdentitiesTable,
  JourneysList,
  MessagesList,
  NotYet,
  SummaryCard,
  TRAITS_FOOTNOTE,
  TraitsList,
} from "@/features/customer-lookup/ui/CustomerTables";
import { parseTimeZone, TZ_COOKIE, type TimeZone } from "@/shared/lib/time-range";
import { DataRegion } from "@/shared/ui/v2/DataRegion";
import { SectionCard } from "@/shared/ui/v2/SectionCard";
import { RegionSkeleton, TableSkeleton } from "@/shared/ui/v2/states";
import type { Viewer } from "@/widgets/v2-shell/model/routes";
import { requireViewer } from "@/widgets/v2-shell/model/viewer";

export const dynamic = "force-dynamic";

// Each region awaits its read inside its own boundary. The read starts here, before React reaches
// the boundary, so a rejection is marked handled now and rethrown to the awaiting region.
function started<T>(read: Promise<T>): Promise<T> {
  read.catch(() => {});
  return read;
}

// SHL-FR-15: `now` is the time of the request. The page is dynamic, so it renders once per request.
function requestTime(): number {
  return Date.now();
}

const LIST_SKELETON = <RegionSkeleton className="h-24" />;

// CUS-FR-04 to CUS-FR-08, CUS-FR-13: one person's summary, metric values, journey entries,
// messages, and identities, each region loading and failing on its own. Every staff user may open
// any profile (CUS-FR-09). The timeline and segments have no store yet, so they say so.
export default async function V2CustomerPage({ params }: { params: Promise<{ canonId: string }> }) {
  const [viewer, cookieStore, { canonId }] = await Promise.all([requireViewer(), cookies(), params]);
  const zone = parseTimeZone(cookieStore.get(TZ_COOKIE)?.value);
  const now = requestTime();
  const person = await loadPerson(canonId);

  if (person === null) {
    return (
      <>
        <FindAnother />
        <section
          aria-label="Customer not found"
          className="flex flex-col items-center gap-2.5 rounded-card border border-border bg-card px-6 py-11 text-center"
        >
          <span className="flex size-11 items-center justify-center rounded-tile bg-muted text-muted-foreground">
            <UserXIcon aria-hidden className="size-5" />
          </span>
          <h1 className="font-heading font-semibold text-[1.0625rem]">No customer has this id.</h1>
          <p className="max-w-[30rem] text-balance text-muted-foreground text-sm">
            The link may be old, or the id was typed by hand. Search again with the shopper&apos;s user id or device id.
          </p>
          <Button render={<Link href="/v2/customers" />} size="sm" variant="outline">
            Search customers
          </Button>
        </section>
      </>
    );
  }

  const identities = started(loadIdentities(canonId));
  const entries = started(loadEntries(canonId));
  const metrics = started(loadMetrics(canonId));
  const messages = started(loadMessages(canonId));
  const clock = { now, zone };

  return (
    <>
      <FindAnother />
      <SummaryCard
        entryTiles={
          <Suspense fallback={<RegionSkeleton className="h-11 w-40" />}>
            <EntryNumbers read={entries} />
          </Suspense>
        }
        person={person}
        {...clock}
      />
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-4">
          <SectionCard
            actions={<span className="text-ink-muted text-xs">From metrics</span>}
            description="What journeys and segments count for this shopper. Each window counts back from its “As of” time."
            title="Computed traits"
          >
            <DataRegion errorMessage="Metrics could not load." loading={LIST_SKELETON}>
              <Metrics read={metrics} {...clock} />
            </DataRegion>
            <p className="mt-2.5 text-muted-foreground text-xs">{TRAITS_FOOTNOTE}</p>
          </SectionCard>
        </div>
        <SectionCard className="flex-[1.5_1_380px]" title="Activity timeline">
          <NotYet reason="Studio does not keep each shopper's events yet, so their activity cannot show here." />
        </SectionCard>
        <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-4">
          <SectionCard description="Each time this shopper entered a journey, newest first. Open one to see its numbers." title="Journeys">
            <DataRegion errorMessage="Journeys could not load." loading={LIST_SKELETON}>
              <Entries read={entries} viewer={{ userId: viewer.userId, role: viewer.role }} {...clock} />
            </DataRegion>
          </SectionCard>
          <SectionCard description="Segments this shopper is in now. Open one to see who else is in it." title="Segments">
            <NotYet reason="Studio does not store who is in each segment yet." />
          </SectionCard>
          <SectionCard description="Every push and SMS a journey sent to this shopper, newest first." title="Messages received">
            <DataRegion errorMessage="Messages could not load." loading={LIST_SKELETON}>
              <Messages read={messages} {...clock} />
            </DataRegion>
          </SectionCard>
        </div>
      </div>
      <section aria-label="Devices and accounts" className="scroll-mt-4" id="devices">
        <DataRegion errorMessage="Devices and accounts could not load." loading={<TableSkeleton rows={3} />}>
          <Identities read={identities} {...clock} />
        </DataRegion>
      </section>
    </>
  );
}

type Clock = { now: number; zone: TimeZone };

// The tiles read the journeys' result. Their failure shows in the Journeys region, so here it reads
// "Not available" rather than a second error.
async function EntryNumbers({ read }: { read: Promise<Shown<Entry>> }) {
  const shown = await read.catch(() => null);
  return <EntryTiles shown={shown} />;
}

async function Identities({ read, ...clock }: Clock & { read: Promise<Shown<Identity>> }) {
  return <IdentitiesTable shown={await read} {...clock} />;
}

async function Entries({ read, viewer, ...clock }: Clock & { read: Promise<Shown<Entry>>; viewer: Viewer }) {
  return <JourneysList shown={await read} viewer={viewer} {...clock} />;
}

async function Metrics({ read, ...clock }: Clock & { read: Promise<MetricRow[]> }) {
  return <TraitsList rows={await read} {...clock} />;
}

async function Messages({ read, ...clock }: Clock & { read: Promise<Shown<Message>> }) {
  return <MessagesList shown={await read} {...clock} />;
}
