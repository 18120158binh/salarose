"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { EyeOffIcon, SearchIcon, ShieldCheckIcon, ZapIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { eventDetailHref } from "@/features/event-management/model/eventDetail";
import { EventRowMenu } from "@/features/event-management/ui/EventRowMenu";
import { formatCount, formatDateTime } from "@/shared/lib/format";
import type { TimeZone } from "@/shared/lib/time-range";
import { DataTable, TablePager, type Column } from "@/shared/ui/v2/DataTable";
import { SideSheet } from "@/shared/ui/v2/SideSheet";
import { StatusBadge } from "@/shared/ui/v2/StatusBadge";
import { NotAvailable, RegionEmpty } from "@/shared/ui/v2/states";
import {
  attributeDepth,
  CATALOG_CHIPS,
  CATALOG_PAGE_SIZE,
  catalogHref,
  chipFilters,
  chipOf,
  mustSendNote,
  type CatalogChip,
  type CatalogCounts,
  type CatalogEvent,
  type CatalogPage,
  type CatalogQuery,
} from "../model/catalog";

const CHIP_LABELS = {
  all: "All",
  strict: "Strict",
  hidden: "Hidden from builder",
  item: "About a product",
} as const satisfies Record<CatalogChip, string>;

const SEARCH_DELAY_MS = 300;

// The board's "12 Oct 2026": the date in the viewer's zone, with the time on hover.
function addedOn(instant: number, zone: TimeZone): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, day: "numeric", month: "short", year: "numeric" }).format(instant);
}

function EventCell({ event }: { event: CatalogEvent }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium">{event.label}</span>
        {event.kind === "business" && (
          <span className="rounded-full border border-border px-1.5 text-[0.6875rem] text-muted-foreground">About a product</span>
        )}
        {event.status === "inactive" && (
          <span className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 text-[0.6875rem] text-muted-foreground">
            <EyeOffIcon aria-hidden className="size-2.5" />
            Hidden from builder
          </span>
        )}
      </span>
      {event.description !== null && <span className="text-muted-foreground text-xs">{event.description}</span>}
      <span className="font-mono text-muted-foreground text-xs">{event.name}</span>
    </span>
  );
}

function columns(zone: TimeZone): readonly [Column<CatalogEvent>, ...Column<CatalogEvent>[]] {
  return [
    { id: "event", header: "Event", cell: (event) => <EventCell event={event} /> },
    {
      id: "checking",
      header: "Checking",
      cell: (event) =>
        event.gate ? (
          <span className="flex flex-col gap-0.5">
            <span className="inline-flex items-center gap-1 font-medium text-primary text-xs">
              <ShieldCheckIcon aria-hidden className="size-3" />
              Strict
            </span>
            <span className="text-muted-foreground text-xs">Drops events that don&apos;t fit</span>
          </span>
        ) : (
          <span className="text-muted-foreground text-xs">Accepts all</span>
        ),
    },
    {
      id: "fields",
      header: "Fields",
      kind: "number",
      cell: (event) => {
        const note = mustSendNote(event);
        return (
          <span className="flex flex-col items-end gap-0.5">
            <span className="font-heading">{formatCount(event.attributeCount)}</span>
            {note !== null && <span className="text-muted-foreground text-xs">{note}</span>}
          </span>
        );
      },
    },
    // A per-event count of journeys and segments needs a reader the catalog does not have yet.
    { id: "used", header: "Used by", cell: () => <NotAvailable reason="Coming later" /> },
    {
      id: "added",
      header: "Added",
      cell: (event) =>
        event.createdAt === null ? (
          <span className="text-muted-foreground">Unknown</span>
        ) : (
          <time className="whitespace-nowrap text-muted-foreground" title={formatDateTime(event.createdAt, zone)}>
            {addedOn(event.createdAt, zone)}
          </time>
        ),
    },
  ];
}

// The search and filters live in the address, so the server pages the matching events and a view
// can be shared as a link. Typing waits a moment before it asks the server.
function Toolbar({ query, catalogSize, counts }: { query: CatalogQuery; catalogSize: number; counts: CatalogCounts }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [search, setSearch] = useState(query.search);
  const [shownSearch, setShownSearch] = useState(query.search);
  const [sent, setSent] = useState(query.search);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const go = (change: Partial<CatalogQuery>) =>
    startTransition(() => router.replace(catalogHref({ ...query, ...change, page: 1 }), { scroll: false }));

  // The back button can change the search under the box. A search this box sent does not reset it,
  // so the characters typed while the server answered stay.
  if (query.search !== shownSearch) {
    setShownSearch(query.search);
    if (query.search !== sent) setSearch(query.search);
  }

  useEffect(() => () => clearTimeout(timer.current), []);

  const send = (change: Partial<CatalogQuery>, text: string) => {
    clearTimeout(timer.current);
    setSent(text.trim());
    go({ ...change, search: text.trim() });
  };

  const type = (value: string) => {
    setSearch(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => send({}, value), SEARCH_DELAY_MS);
  };

  // A filter click sends the box's text with it and cancels the wait, so a pending search can
  // neither be lost nor fire later with the filters from before the click.
  const filter = (change: Partial<CatalogQuery>) => send(change, search);

  const pressed = chipOf(query);

  return (
    <>
      <InputGroup className="w-72 max-w-full">
        <InputGroupAddon>
          <SearchIcon aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          aria-label="Search events"
          onChange={(event) => type(event.target.value)}
          placeholder="Search by name, like cart"
          type="search"
          value={search}
        />
      </InputGroup>
      <div aria-label="Filter events" className="flex flex-wrap gap-1.5" role="group">
        {CATALOG_CHIPS.map((chip) => (
          <Button
            aria-pressed={pressed === chip}
            className="rounded-full"
            key={chip}
            onClick={() => filter(chipFilters(chip))}
            size="sm"
            type="button"
            variant={pressed === chip ? "secondary" : "outline"}
          >
            {CHIP_LABELS[chip]}
            <span className="font-heading text-muted-foreground tabular-nums">{formatCount(chip === "all" ? catalogSize : counts[chip])}</span>
          </Button>
        ))}
      </div>
    </>
  );
}

function AttributeTree({ event }: { event: CatalogEvent }) {
  if (event.attributes.length === 0) {
    return <p className="text-muted-foreground text-sm">This event has no fields.</p>;
  }
  return (
    <ul aria-label="Fields" className="flex flex-col divide-y divide-border rounded-lg border border-border">
      {event.attributes.map((attribute) => (
        <li className="flex flex-col gap-1 px-3 py-2" key={attribute.path} style={{ paddingInlineStart: `${0.75 + attributeDepth(attribute.path) * 1.25}rem` }}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm">{attribute.path}</span>
            <span className="text-muted-foreground text-xs">{attribute.type}</span>
            {attribute.required && <StatusBadge tone="warning">Must be sent</StatusBadge>}
          </div>
          {attribute.example !== null && attribute.example !== "" && (
            <span className="text-muted-foreground text-xs">
              Example <span className="font-mono">{attribute.example}</span>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function EventSheet({ event, onClose }: { event: CatalogEvent | null; onClose: () => void }) {
  return (
    <SideSheet
      description={event?.name}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open={event !== null}
      title={event?.label ?? ""}
    >
      {event && (
        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-1">
            <h3 className="font-medium text-sm">Description</h3>
            <p className="text-muted-foreground text-sm">{event.description ?? "No description."}</p>
          </section>
          <section className="flex flex-col gap-2">
            <h3 className="font-medium text-sm">Fields</h3>
            <AttributeTree event={event} />
          </section>
        </div>
      )}
    </SideSheet>
  );
}

function Empty({ catalog, query, addEvent }: { catalog: CatalogPage; query: CatalogQuery; addEvent: ReactNode }) {
  if (catalog.catalogSize === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
        <ZapIcon aria-hidden className="size-5 text-muted-foreground" />
        <h2 className="font-heading font-semibold text-[0.9375rem]">No events in the catalog yet.</h2>
        <p className="max-w-md text-muted-foreground text-sm">
          Add the events your shop sends, like <span className="font-mono">com.acme/product_viewed</span> or{" "}
          <span className="font-mono">com.acme/order_completed</span>, so marketers can build journeys on them. Pasting one real event is the
          fastest way.
        </p>
        {addEvent ?? <p className="text-muted-foreground text-sm">Ask an admin to add the events your shop sends.</p>}
      </div>
    );
  }
  if (query.search !== "") {
    return (
      <p className="px-6 py-10 text-center text-muted-foreground text-sm">
        No event matches “{query.search}”. Try part of the name, like <span className="font-mono">cart</span>.
      </p>
    );
  }
  return <RegionEmpty icon={SearchIcon} message="No event matches these filters." />;
}

type EventCatalogProps = {
  catalog: CatalogPage;
  query: CatalogQuery;
  zone: TimeZone;
  /** DHL-FR-02: a row opens the event's detail page, or else the read-only side sheet. */
  openDetail: boolean;
  /** The event catalog's create dialog, for an admin, which the empty catalog offers too. */
  addEvent?: ReactNode;
  /** CAT-FR-10: an admin's row menu with edit details, hide from builder, and delete. */
  rowMenu?: boolean;
};

/** DHL-FR-01, DHL-FR-02: a page of the catalog. A row opens the event's detail page, or its side sheet. */
export function EventCatalog({ catalog, query, zone, openDetail, addEvent, rowMenu = false }: EventCatalogProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const opened = catalog.events.find((event) => event.id === openId) ?? null;

  return (
    <>
      <DataTable
        columns={columns(zone)}
        empty={<Empty addEvent={addEvent} catalog={catalog} query={query} />}
        footer={
          catalog.matching > 0 ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap justify-between gap-2 text-muted-foreground text-xs">
                <span>
                  Showing {formatCount(catalog.events.length)} of {formatCount(catalog.catalogSize)} {catalog.catalogSize === 1 ? "event" : "events"},
                  sorted by name
                </span>
                <span>{CATALOG_PAGE_SIZE} per page</span>
              </div>
              <TablePager href={(page) => catalogHref({ ...query, page })} page={catalog.page} pageCount={catalog.pageCount} />
            </div>
          ) : undefined
        }
        label="Events"
        open={
          openDetail
            ? { kind: "link", href: (event) => eventDetailHref(event.id) }
            : { kind: "action", onOpen: (event) => setOpenId(event.id) }
        }
        rowActions={rowMenu ? (event) => <EventRowMenu event={event} /> : undefined}
        rowKey={(event) => event.id}
        rows={catalog.events}
        toolbar={<Toolbar catalogSize={catalog.catalogSize} counts={catalog.counts} query={query} />}
      />
      <EventSheet event={opened} onClose={() => setOpenId(null)} />
    </>
  );
}
