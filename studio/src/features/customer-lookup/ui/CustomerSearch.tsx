import Link from "next/link";
import type { ReactNode } from "react";
import { InfoIcon, SearchIcon, UserRoundIcon, UserSearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import type { TimeZone } from "@/shared/lib/time-range";
import { CellLabel, DataTable, type Column } from "@/shared/ui/v2/DataTable";
import { SectionCard } from "@/shared/ui/v2/SectionCard";
import type { PersonSummary } from "../model/queries";
import { customerHref, personTitle, Time } from "./CustomerTables";

const SEARCH_LABEL = "Search by id, email, phone or name";

/** CUS-FR-01: the search card. The name sentence differs from the board until customer lists are imported. */
export function SearchCard({ query }: { query: string }) {
  return (
    <section aria-label="Search customers" className="flex flex-col gap-2.5 rounded-card border border-border bg-card p-4">
      <form action="/v2/customers" className="flex flex-col gap-2" method="get" role="search">
        <label className="font-semibold text-sm" htmlFor="customer-search">
          {SEARCH_LABEL}
        </label>
        <div className="flex flex-wrap gap-2">
          <InputGroup className="min-w-0 flex-1 basis-64">
            <InputGroupAddon>
              <SearchIcon aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              autoComplete="off"
              defaultValue={query}
              id="customer-search"
              name="q"
              placeholder="User id, device id, email, phone or name, like usr_1001"
              spellCheck={false}
              type="search"
            />
          </InputGroup>
          <Button type="submit">Search</Button>
        </div>
      </form>
      <p className="flex items-start gap-1.5 text-muted-foreground text-xs">
        <InfoIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Ids match exactly, emails ignore case, and phones match with +84 or a leading 0. Type the whole value: <span className="font-mono">usr_100</span> does not find{" "}
          <span className="font-mono">usr_1001</span>. Name search starts once your customer lists are imported.
        </span>
      </p>
    </section>
  );
}

type Clock = { now: number; zone: TimeZone };

function Empty() {
  return <span className="sr-only">None</span>;
}

/** CUS-FR-02: several people. Email and Phone stay empty until customer lists are imported. */
export function SearchResults({ matches, query, now, zone }: Clock & { matches: readonly PersonSummary[]; query: string }) {
  const columns: readonly [Column<PersonSummary>, ...Column<PersonSummary>[]] = [
    { id: "person", header: "Customer", cell: (row) => <CellLabel label={personTitle(row)} secondary={row.canonId} /> },
    { id: "email", header: "Email", cell: () => <Empty /> },
    { id: "phone", header: "Phone", cell: () => <Empty /> },
    { id: "devices", header: "Devices", kind: "number", cell: (row) => <span className="font-heading">{row.devices}</span> },
    { id: "last-seen", header: "Last seen", cell: (row) => <Time instant={row.lastSeen} now={now} zone={zone} /> },
    {
      id: "open",
      header: "Open",
      cell: (row) => (
        <Link className="relative z-10 whitespace-nowrap font-semibold text-primary text-xs hover:underline" href={customerHref(row.canonId)}>
          Open profile
        </Link>
      ),
    },
  ];
  return (
    <DataTable
      columns={columns}
      empty={null}
      footer={<p className="text-muted-foreground text-xs">When only one customer matches, Studio opens their profile straight away.</p>}
      label="Customers"
      rowKey={(row) => row.canonId}
      rows={matches}
      toolbar={
        <div className="flex flex-col gap-0.5">
          <h2 className="font-heading font-semibold text-[0.9375rem]">
            <span className="tabular-nums">{matches.length}</span> customers match “{query}”
          </h2>
          <p className="text-muted-foreground text-xs">Newest activity first.</p>
        </div>
      }
    />
  );
}

function StateCard({ icon: Icon, accent, title, children }: { icon: typeof UserSearchIcon; accent: boolean; title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col items-center gap-2.5 rounded-card border border-border bg-card px-6 py-11 text-center">
      <span
        className={
          accent
            ? "flex size-11 items-center justify-center rounded-tile border border-primary/30 bg-primary/10 text-primary"
            : "flex size-11 items-center justify-center rounded-tile bg-muted text-muted-foreground"
        }
      >
        <Icon aria-hidden className="size-5" />
      </span>
      <h2 className="font-heading font-semibold text-[1.0625rem]">{title}</h2>
      <p className="max-w-[30rem] text-balance text-muted-foreground text-sm">{children}</p>
    </section>
  );
}

export function NoMatch({ query }: { query: string }) {
  return (
    <StateCard accent={false} icon={UserSearchIcon} title="No customer matches this search.">
      Studio looked for “{query}”. Ids must match exactly, including upper and lower case: copy the value again from your order
      system or app, and search once more.
    </StateCard>
  );
}

export function BeforeSearch() {
  return (
    <StateCard accent icon={UserRoundIcon} title="Look up one shopper">
      Paste the account id support gave you, like <span className="font-mono">usr_1001</span>, or a device id from your app, or type an email,
      phone or name. You can also press Ctrl K anywhere and type the id.
    </StateCard>
  );
}

const PROFILE_PARTS: readonly [string, string][] = [
  ["Activity timeline", ": events like views and orders, newest first."],
  ["Devices and accounts", " joined into this shopper."],
  ["Journeys", " they entered, the last step, and where they wait now."],
  ["Messages received", " from journeys, by push and SMS."],
  ["Segments", " they are in now."],
  ["Behavior numbers", ", like how many times they added to cart in 30 days."],
  ["Imported fields", ", like loyalty tier. Emails and phones stay masked."],
];

export function SearchAside() {
  return (
    <aside className="flex min-w-0 flex-[1_1_260px] flex-col gap-4">
      <SectionCard title="What a profile shows">
        <ul className="flex flex-col gap-2 text-xs">
          {PROFILE_PARTS.map(([part, rest]) => (
            <li key={part}>
              <b className="font-semibold">{part}</b>
              {rest}
            </li>
          ))}
        </ul>
      </SectionCard>
      <SectionCard title="Look up from anywhere">
        <p className="text-xs">
          Press <Kbd>Ctrl K</Kbd>, type an id, email, phone or name, and pick <b className="font-semibold">Look up customer “usr_1001”</b>.
        </p>
        <p className="mt-2 text-muted-foreground text-xs">Every teammate can look up any shopper.</p>
      </SectionCard>
    </aside>
  );
}
