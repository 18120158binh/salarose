import type { SqlQuery } from "@/lib/db";

export const CATALOG_PAGE_SIZE = 50;

export const KIND_FILTERS = ["all", "person", "business"] as const;
export const STATUS_FILTERS = ["all", "active", "inactive"] as const;
export const GATE_FILTERS = ["all", "on", "off"] as const;

export type KindFilter = (typeof KIND_FILTERS)[number];
export type StatusFilter = (typeof STATUS_FILTERS)[number];
export type GateFilter = (typeof GATE_FILTERS)[number];

export type CatalogQuery = {
  readonly search: string;
  readonly kind: KindFilter;
  readonly status: StatusFilter;
  readonly gate: GateFilter;
  /** 1-based. */
  readonly page: number;
};

export const DEFAULT_CATALOG_QUERY: CatalogQuery = { search: "", kind: "all", status: "all", gate: "all", page: 1 };

export type EventKind = "person" | "business";
export type EventStatus = "active" | "inactive";

export type CatalogAttribute = {
  readonly path: string;
  readonly type: string;
  readonly required: boolean;
  readonly example: string | null;
};

export type CatalogEvent = {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly description: string | null;
  readonly kind: EventKind;
  readonly status: EventStatus;
  readonly gate: boolean;
  readonly attributeCount: number;
  readonly requiredCount: number;
  /** Epoch ms, or null for a row created before the column had a default. */
  readonly createdAt: number | null;
  readonly attributes: readonly CatalogAttribute[];
};

/** How many events of the whole catalog each filter chip holds, before search and filters. */
export type CatalogCounts = {
  readonly strict: number;
  readonly hidden: number;
  readonly item: number;
};

export type CatalogPage = {
  readonly events: readonly CatalogEvent[];
  /** Every event in the catalog, before search and filters. */
  readonly catalogSize: number;
  readonly counts: CatalogCounts;
  /** The events that match the search and filters. */
  readonly matching: number;
  readonly page: number;
  readonly pageCount: number;
};

type Params = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function pick<T extends string>(options: readonly T[], value: string | undefined): T {
  return options.find((option) => option === value) ?? options[0];
}

/** The address's search and filters. An unknown value reads as no filter, and a bad page as the first. */
export function parseCatalogQuery(params: Params): CatalogQuery {
  const page = Number(first(params.page));
  return {
    search: (first(params.q) ?? "").trim(),
    kind: pick(KIND_FILTERS, first(params.kind)),
    status: pick(STATUS_FILTERS, first(params.status)),
    gate: pick(GATE_FILTERS, first(params.gate)),
    page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
  };
}

/** The address of a query. A default value stays out of it, so the plain page is `/v2/data/events`. */
export function catalogHref(query: CatalogQuery): string {
  const params = new URLSearchParams();
  if (query.search !== "") params.set("q", query.search);
  if (query.kind !== "all") params.set("kind", query.kind);
  if (query.status !== "all") params.set("status", query.status);
  if (query.gate !== "all") params.set("gate", query.gate);
  if (query.page > 1) params.set("page", String(query.page));
  const search = params.toString();
  return search === "" ? "/v2/data/events" : `/v2/data/events?${search}`;
}

const LABEL = "COALESCE(NULLIF(ue.display_name, ''), ue.event_name)";

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

// One WHERE clause for the count and the page, so the two always agree. A null parameter turns its
// filter off. A row with no status reads as active, as the classic catalog reads it.
function matching(query: CatalogQuery): { where: string; values: unknown[] } {
  return {
    where: `WHERE ($1::text IS NULL OR ue.event_name ILIKE $1 OR ue.display_name ILIKE $1)
  AND ($2::text IS NULL OR ue.kind = $2)
  AND ($3::text IS NULL OR COALESCE(ue.status, 'active') = $3)
  AND ($4::boolean IS NULL OR ue.enforce_schema = $4)`,
    values: [
      query.search === "" ? null : `%${escapeLike(query.search)}%`,
      query.kind === "all" ? null : query.kind,
      query.status === "all" ? null : query.status,
      query.gate === "all" ? null : query.gate === "on",
    ],
  };
}

export function catalogCountQuery(query: CatalogQuery): SqlQuery {
  const { where, values } = matching(query);
  return {
    text: `SELECT (SELECT count(*)::int FROM user_events) AS catalog_size,
  (SELECT count(*) FILTER (WHERE enforce_schema)::int FROM user_events) AS strict_count,
  (SELECT count(*) FILTER (WHERE status = 'inactive')::int FROM user_events) AS hidden_count,
  (SELECT count(*) FILTER (WHERE kind = 'business')::int FROM user_events) AS item_count,
  count(*)::int AS matching FROM user_events ue
${where}`,
    values,
  };
}

/** DHL-FR-01: one page of the matching events, by display name, with each one's attribute counts. */
export function catalogPageQuery(query: CatalogQuery, page: number): SqlQuery {
  const { where, values } = matching(query);
  return {
    text: `SELECT ue.id, ue.event_name, ${LABEL} AS label, ue.description, ue.kind, ue.status, ue.enforce_schema, ue.created_at,
  (SELECT count(*)::int FROM user_event_fields f WHERE f.user_event_id = ue.id) AS attribute_count,
  (SELECT count(*)::int FROM user_event_fields f WHERE f.user_event_id = ue.id AND f.required) AS required_count
FROM user_events ue
${where}
ORDER BY lower(${LABEL}), ue.event_name, ue.id
LIMIT $5 OFFSET $6`,
    values: [...values, CATALOG_PAGE_SIZE, (page - 1) * CATALOG_PAGE_SIZE],
  };
}

export function catalogAttributesQuery(eventIds: readonly string[]): SqlQuery {
  return {
    text: `SELECT user_event_id, field_path, data_type, required, example_value FROM user_event_fields
WHERE user_event_id = ANY($1::text[]) ORDER BY user_event_id, field_path`,
    values: [[...eventIds]],
  };
}

export function pageCountOf(matchingEvents: number): number {
  return Math.max(1, Math.ceil(matchingEvents / CATALOG_PAGE_SIZE));
}

type Row = Record<string, unknown>;

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function instant(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const ms = new Date(value as string | Date).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export function parseCatalogCount(rows: readonly Row[]): { catalogSize: number; matching: number; counts: CatalogCounts } {
  const row = rows[0] ?? {};
  return {
    catalogSize: Number(row.catalog_size ?? 0),
    matching: Number(row.matching ?? 0),
    counts: { strict: Number(row.strict_count ?? 0), hidden: Number(row.hidden_count ?? 0), item: Number(row.item_count ?? 0) },
  };
}

/** The filter chips of the list. Each one sets one filter and clears the others. */
export const CATALOG_CHIPS = ["all", "strict", "hidden", "item"] as const;
export type CatalogChip = (typeof CATALOG_CHIPS)[number];

const CHIP_FILTERS = {
  all: { kind: "all", status: "all", gate: "all" },
  strict: { kind: "all", status: "all", gate: "on" },
  hidden: { kind: "all", status: "inactive", gate: "all" },
  item: { kind: "business", status: "all", gate: "all" },
} as const satisfies Record<CatalogChip, Pick<CatalogQuery, "kind" | "status" | "gate">>;

export function chipFilters(chip: CatalogChip): Pick<CatalogQuery, "kind" | "status" | "gate"> {
  return CHIP_FILTERS[chip];
}

/** The chip a query shows as pressed, or null for a combination no chip draws, such as an old link. */
export function chipOf(query: CatalogQuery): CatalogChip | null {
  return (
    CATALOG_CHIPS.find((chip) => {
      const filters = CHIP_FILTERS[chip];
      return filters.kind === query.kind && filters.status === query.status && filters.gate === query.gate;
    }) ?? null
  );
}

function attributesByEvent(rows: readonly Row[]): Map<string, CatalogAttribute[]> {
  const byEvent = new Map<string, CatalogAttribute[]>();
  for (const row of rows) {
    const eventId = text(row.user_event_id);
    const path = text(row.field_path);
    if (eventId === null || path === null) continue;
    const list = byEvent.get(eventId) ?? [];
    list.push({
      path,
      type: text(row.data_type) ?? "string",
      required: row.required === true,
      example: typeof row.example_value === "string" ? row.example_value : null,
    });
    byEvent.set(eventId, list);
  }
  return byEvent;
}

// The kind column's CHECK allows only person and business, so any other value is a broken row. It is
// logged and left out, as the classic catalog list does.
export function parseCatalogEvents(eventRows: readonly Row[], attributeRows: readonly Row[]): CatalogEvent[] {
  const attributes = attributesByEvent(attributeRows);
  return eventRows.flatMap((row): CatalogEvent[] => {
    const id = text(row.id);
    const name = text(row.event_name);
    if (id === null || name === null || (row.kind !== "person" && row.kind !== "business")) {
      console.warn(`[data-health] Skipping catalog row ${String(row.id)}: its id, name, or kind is not valid.`);
      return [];
    }
    return [
      {
        id,
        name,
        label: text(row.label) ?? name,
        description: text(row.description),
        kind: row.kind,
        status: row.status === "inactive" ? "inactive" : "active",
        gate: row.enforce_schema === true,
        attributeCount: Number(row.attribute_count ?? 0),
        requiredCount: Number(row.required_count ?? 0),
        createdAt: instant(row.created_at),
        attributes: attributes.get(id) ?? [],
      },
    ];
  });
}

/** The note under a field count: "3 must be sent", or null when every field is optional. */
export function mustSendNote(event: Pick<CatalogEvent, "requiredCount">): string | null {
  return event.requiredCount === 0 ? null : `${event.requiredCount} must be sent`;
}

/** An attribute's depth in the tree: 0 for `product`, 1 for `product.price`. */
export function attributeDepth(path: string): number {
  return Math.max(0, path.split(".").length - 1);
}
