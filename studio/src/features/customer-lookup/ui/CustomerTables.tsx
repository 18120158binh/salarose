import Link from "next/link";
import type { ReactNode } from "react";
import { ActivityIcon, ArrowLeftIcon, FingerprintIcon, MessageSquareIcon, RouteIcon, SearchIcon, SendIcon, UserRoundIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { formatDateTime, formatTimestamp } from "@/shared/lib/format";
import type { TimeZone } from "@/shared/lib/time-range";
import { DataTable, type Column } from "@/shared/ui/v2/DataTable";
import { StatusBadge } from "@/shared/ui/v2/StatusBadge";
import { NotAvailable, RegionEmpty } from "@/shared/ui/v2/states";
import { journeyHref, type Viewer } from "@/widgets/v2-shell/model/routes";
import type { Entry, EntryNow } from "../model/entries";
import type { Message } from "../model/messages";
import type { MetricValue } from "../model/metrics";
import type { Identity, MetricRow, PersonSummary, Shown } from "../model/queries";

export const ANONYMOUS = "Anonymous visitor";

export function customerHref(canonId: string): string {
  return `/v2/customers/${encodeURIComponent(canonId)}`;
}

/** CUS-FR-04: the newest user id, never the person id. */
export function personTitle(person: PersonSummary): string {
  return person.newestUserId ?? ANONYMOUS;
}

type Clock = { now: number; zone: TimeZone };

export function Time({ instant, now, zone }: Clock & { instant: number | null }) {
  if (instant === null) return <span className="text-muted-foreground">Unknown</span>;
  const { text, exact } = formatTimestamp(instant, now, zone);
  return (
    <time className="whitespace-nowrap" dateTime={new Date(instant).toISOString()} title={exact}>
      {text}
    </time>
  );
}

const NOTE = "text-muted-foreground text-xs";

/** The 50-newest note of a profile list, with the count of the rest when there is one. */
function Newest({ more }: { more: number }) {
  return (
    <p className={NOTE}>
      Newest first. Showing the 50 newest when there are more.
      {more > 0 && (
        <>
          {" "}
          <span className="font-heading tabular-nums">{more}</span> more.
        </>
      )}
    </p>
  );
}

/** CUS-FR-01: the profile's top row, a way back and **Find another customer**, which runs the search. */
export function FindAnother() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button render={<Link href="/v2/customers" />} size="sm" variant="outline">
        <ArrowLeftIcon aria-hidden />
        Search
      </Button>
      <form action="/v2/customers" className="flex min-w-0 flex-[0_1_340px]" method="get" role="search">
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Find another customer"
            autoComplete="off"
            name="q"
            placeholder="Search by id, email, phone or name"
            spellCheck={false}
            type="search"
          />
        </InputGroup>
      </form>
      <span className={NOTE}>Emails ignore case and phones match with +84 or a leading 0. Name search starts once your customer lists are imported.</span>
    </div>
  );
}

function Tile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-semibold text-ink-muted text-xs">{label}</span>
      <span className="font-heading font-semibold text-xl tabular-nums">{children}</span>
    </div>
  );
}

function TimeTile({ label, instant, now, zone }: Clock & { label: string; instant: number | null }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-semibold text-ink-muted text-xs">{label}</span>
      <span className="font-heading font-semibold text-base leading-[1.85] tabular-nums">
        <Time instant={instant} now={now} zone={zone} />
      </span>
    </div>
  );
}

function short(id: string): string {
  return id.length <= 10 ? id : `${id.slice(0, 4)}…${id.slice(-2)}`;
}

function subtitle(person: PersonSummary, now: number, zone: TimeZone): string {
  const devices = `${person.devices} ${person.devices === 1 ? "device" : "devices"}`;
  const seen = (label: string, instant: number | null) => (instant === null ? [] : [`${label} ${formatTimestamp(instant, now, zone).text}`]);
  return [`Person id ${person.canonId}`, devices, ...seen("First seen", person.firstSeen), ...seen("Last seen", person.lastSeen)].join(" · ");
}

function IdTag({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-muted-foreground text-xs">
      {label}
      <span className="font-mono text-foreground" title={value}>
        {value}
      </span>
    </span>
  );
}

/**
 * CUS-FR-04: who the person is. `entryTiles` holds the Journey entries and Waiting now tiles,
 * which load with the journeys.
 */
export function SummaryCard({ person, entryTiles, now, zone }: Clock & { person: PersonSummary; entryTiles: ReactNode }) {
  return (
    <section aria-label="Customer summary" className="rounded-card border border-border bg-card">
      <div className="flex flex-wrap items-center gap-4.5 p-5">
        <span className="flex size-14 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <UserRoundIcon aria-hidden className="size-6" />
        </span>
        <div className="flex min-w-60 flex-[1_1_300px] flex-col gap-1">
          <h1 className="font-heading font-semibold text-[1.375rem] leading-tight">{personTitle(person)}</h1>
          <p className="text-muted-foreground text-xs">{subtitle(person, now, zone)}</p>
        </div>
        <div className="ml-auto flex flex-wrap gap-6.5">
          <Tile label="Devices">{person.devices}</Tile>
          {entryTiles}
          <TimeTile instant={person.firstSeen} label="First seen" now={now} zone={zone} />
          <TimeTile instant={person.lastSeen} label="Last seen" now={now} zone={zone} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-border border-t px-5 py-3">
        <span className="font-semibold text-ink-muted text-xs tracking-wider">IDS</span>
        {person.newestUserId !== null && <IdTag label="User id" value={person.newestUserId} />}
        <IdTag label="Devices" value={`× ${person.devices}`} />
        <IdTag label="Person id" value={short(person.canonId)} />
        <a className="ml-auto font-semibold text-primary text-xs hover:underline" href="#devices">
          See every device and account
        </a>
      </div>
    </section>
  );
}

/** The Journey entries and Waiting now tiles. A failed read reads "Not available" in both. */
export function EntryTiles({ shown }: { shown: Shown<Entry> | null }) {
  if (shown === null) {
    return (
      <>
        <Tile label="Journey entries">
          <span className="text-muted-foreground text-sm">Not available</span>
        </Tile>
        <Tile label="Waiting now">
          <span className="text-muted-foreground text-sm">Not available</span>
        </Tile>
      </>
    );
  }
  return (
    <>
      <Tile label="Journey entries">{shown.rows.length + shown.more}</Tile>
      <Tile label="Waiting now">{shown.rows.filter((entry) => entry.now.kind === "waiting").length}</Tile>
    </>
  );
}

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function Value({ value }: { value: MetricValue }) {
  switch (value.kind) {
    case "value":
      return <span className="font-heading font-semibold tabular-nums">{NUMBER.format(value.value)}</span>;
    case "no-value":
      return <span className="text-muted-foreground">No value</span>;
    case "not-shown":
      return <span className="text-muted-foreground">Not shown yet</span>;
    case "not-available":
      return <span className="text-muted-foreground">Not available</span>;
    default: {
      const unhandled: never = value;
      return unhandled;
    }
  }
}

function asOfLine(row: MetricRow, clock: Clock): ReactNode {
  const occurrences = row.value.kind === "not-shown" ? row.value.occurrences : null;
  return (
    <>
      As of <Time instant={row.asOf} {...clock} />
      {occurrences !== null && (
        <>
          {" · "}
          <span className="font-heading tabular-nums">{NUMBER.format(occurrences)}</span> {occurrences === 1 ? "occurrence" : "occurrences"}
        </>
      )}
    </>
  );
}

/** CUS-FR-08: each metric as three lines: the event, the function line, and the system name. */
export function TraitsList({ rows, now, zone }: Clock & { rows: readonly MetricRow[] }) {
  if (rows.length === 0) return <RegionEmpty icon={ActivityIcon} message="No metric counts this person's behavior yet." />;
  return (
    <ul aria-label="Computed traits" className="flex flex-col divide-y divide-border">
      {rows.map((row) => (
        <li className="flex flex-col gap-0.5 py-2.5 first:pt-0" key={row.metricId}>
          <div className="flex items-start gap-2">
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2 font-medium text-sm">
              {row.label.event}
              {row.paused && <StatusBadge tone="warning">Not updating</StatusBadge>}
            </span>
            <span className="text-right text-sm">
              <Value value={row.value} />
            </span>
          </div>
          <div className="flex flex-wrap justify-between gap-x-2 text-muted-foreground text-xs">
            <span>{row.label.measure}</span>
            <span>{asOfLine(row, { now, zone })}</span>
          </div>
          <span className="font-mono text-ink-muted text-xs">{row.label.system}</span>
        </li>
      ))}
    </ul>
  );
}

export const TRAITS_FOOTNOTE =
  "“Not updating” means nothing uses the number now, so it is paused. “Not shown yet” is a median or a count of different values, which Studio can't show yet. “Not available” means the stored numbers could not be read.";

function Now({ now, zone }: { now: EntryNow; zone: TimeZone }) {
  switch (now.kind) {
    case "finished":
      return <StatusBadge tone="neutral">Finished</StatusBadge>;
    case "journey-deleted":
      return <span className="text-muted-foreground">Journey deleted</span>;
    case "waiting":
      return (
        <ul className="flex flex-col gap-0.5">
          {now.steps.map((step, index) => (
            <li key={index}>
              Waiting at {step.label}
              {step.deadline !== null && <span className="text-muted-foreground"> until {formatDateTime(step.deadline, zone)}</span>}
            </li>
          ))}
        </ul>
      );
    default: {
      const unhandled: never = now;
      return unhandled;
    }
  }
}

function JourneyName({ entry, viewer }: { entry: Entry; viewer: Viewer }) {
  if (entry.journey === null) {
    return (
      <span className="flex flex-col gap-0.5">
        <span className="font-medium">Deleted journey</span>
        <span className="font-mono text-muted-foreground text-xs">{entry.campaignId}</span>
      </span>
    );
  }
  const href = journeyHref({ id: entry.campaignId, ownerId: entry.journey.ownerId }, viewer);
  if (href === null) return <span className="font-medium">{entry.journey.name}</span>;
  return (
    <Link className="rounded-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring" href={href}>
      {entry.journey.name}
    </Link>
  );
}

/** CUS-FR-06, CUS-FR-07: one item per entry, newest entered first. */
export function JourneysList({ shown, now, zone, viewer }: Clock & { shown: Shown<Entry>; viewer: Viewer }) {
  if (shown.rows.length === 0) return <RegionEmpty icon={RouteIcon} message="This person has not entered a journey." />;
  return (
    <div className="flex flex-col gap-2.5">
      <ul aria-label="Journey entries" className="flex flex-col divide-y divide-border">
        {shown.rows.map((entry) => (
          <li className="flex flex-col gap-1 py-2.5 text-sm first:pt-0" key={JSON.stringify([entry.campaignId, entry.entryId])}>
            <JourneyName entry={entry} viewer={viewer} />
            <dl className="grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-0.5 text-xs">
              <dt className="text-muted-foreground">Entered</dt>
              <dd>
                <Time instant={entry.entered} now={now} zone={zone} />
              </dd>
              <dt className="text-muted-foreground">Last step</dt>
              <dd>{entry.lastStep}</dd>
              <dt className="text-muted-foreground">Now</dt>
              <dd>
                <Now now={entry.now} zone={zone} />
              </dd>
            </dl>
          </li>
        ))}
      </ul>
      <Newest more={shown.more} />
    </div>
  );
}

/** CUS-FR-13: one item per message, newest first. "Sent" until a sender reports delivery. */
export function MessagesList({ shown, now, zone }: Clock & { shown: Shown<Message> }) {
  if (shown.rows.length === 0) return <RegionEmpty icon={MessageSquareIcon} message="No message sent to this shopper yet." />;
  return (
    <div className="flex flex-col gap-2.5">
      <ul aria-label="Messages" className="flex flex-col divide-y divide-border">
        {shown.rows.map((message) => (
          <li className="flex items-start gap-3 py-2.5 first:pt-0" key={message.key}>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="font-medium text-sm">{message.title}</span>
              <span className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
                {message.journeyName ?? "Deleted journey"}
                <span aria-hidden>·</span>
                <StatusBadge icon={SendIcon} tone="neutral">
                  Sent
                </StatusBadge>
              </span>
            </div>
            <span className="shrink-0 text-muted-foreground text-xs">
              <Time instant={message.sentAt} now={now} zone={zone} />
            </span>
          </li>
        ))}
      </ul>
      <Newest more={shown.more} />
    </div>
  );
}

/** A region whose store does not exist yet: the kit's not-available state, with the reason. */
export function NotYet({ reason }: { reason: string }) {
  return (
    <div className="py-2">
      <NotAvailable reason={reason} />
    </div>
  );
}

/** CUS-FR-05: every device and account of the person, newest first. */
export function IdentitiesTable({ shown, now, zone }: Clock & { shown: Shown<Identity> }) {
  const columns: readonly [Column<Identity>, ...Column<Identity>[]] = [
    { id: "device", header: "Device id", cell: (row) => <span className="font-mono text-xs">{row.deviceId}</span> },
    { id: "user", header: "User id", cell: (row) => (row.userId === null ? <span className="text-muted-foreground">(none)</span> : <span className="font-mono text-xs">{row.userId}</span>) },
    { id: "first-seen", header: "First seen", cell: (row) => <Time instant={row.firstSeen} now={now} zone={zone} /> },
    { id: "last-seen", header: "Last seen", cell: (row) => <Time instant={row.lastSeen} now={now} zone={zone} /> },
  ];
  return (
    <DataTable
      columns={columns}
      empty={<RegionEmpty icon={FingerprintIcon} message="No device or account is joined to this shopper." />}
      footer={shown.rows.length > 0 ? <Newest more={shown.more} /> : undefined}
      label="Devices and accounts"
      rowKey={(row) => row.deviceId}
      rows={shown.rows}
      toolbar={
        <div className="flex flex-col gap-0.5">
          <h2 className="font-heading font-semibold text-[0.9375rem]">Devices and accounts</h2>
          <p className={NOTE}>Every browser or phone joined into this shopper, and the account seen on it.</p>
        </div>
      }
    />
  );
}
