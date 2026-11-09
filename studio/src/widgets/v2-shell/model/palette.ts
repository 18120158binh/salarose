import type { SqlQuery } from "@/lib/db";
import { JOURNEY_NEW, mayReach, navFor, type Access, type NavId, type Reach, type Stage } from "./routes";

/** SHL-FR-07: the palette shows at most this many journeys and this many segments. */
export const NAME_MATCH_LIMIT = 8;

/** A journey or a segment whose name holds the typed text. */
export type NameMatch = { readonly id: string; readonly name: string };

export type NameSearch =
  | { readonly status: "found"; readonly journeys: readonly NameMatch[]; readonly segments: readonly NameMatch[] }
  | { readonly status: "failed" };

export type CreateId = "create-journey" | "new-segment" | "add-event";

// SHL-FR-07: the palette's create targets. Each follows the stage of the area that adds it, so a
// lane flips the stage here when its page or control arrives. Reserved means not built yet.
export interface CreateTarget {
  readonly id: CreateId;
  readonly label: string;
  readonly href: string;
  readonly access: Access;
  readonly stage: Stage;
}

export const CREATE_TARGETS: readonly CreateTarget[] = [
  { id: "create-journey", label: "Create journey", href: JOURNEY_NEW.href, access: "staff", stage: JOURNEY_NEW.stage },
  { id: "new-segment", label: "New segment", href: "/v2/segments/new", access: "staff", stage: "reserved" },
  { id: "add-event", label: "Add event", href: "/v2/data/events?add=event", access: "admin", stage: "reserved" },
];

// `preview` marks a target at stage preview, which carries the Preview badge (SHL-FR-22).
export type PaletteItem =
  | { readonly kind: "page"; readonly key: string; readonly page: NavId; readonly label: string; readonly href: string; readonly preview: boolean }
  | { readonly kind: "create"; readonly key: string; readonly label: string; readonly href: string; readonly preview: boolean }
  | { readonly kind: "journey" | "segment" | "customer"; readonly key: string; readonly label: string; readonly href: string };

export type PaletteGroup = { readonly value: string; readonly items: readonly PaletteItem[] };

const holds = (name: string, text: string) => name.toLowerCase().includes(text.toLowerCase());

/** SHL-FR-04, SHL-FR-22: the sidebar pages the viewer may reach, whose label holds the text. */
export function pageItems(viewer: Reach, text: string): PaletteItem[] {
  return navFor(viewer)
    .filter((entry) => entry.section !== "menu" && holds(entry.label, text))
    .map((entry) => ({
      kind: "page",
      key: `page:${entry.id}`,
      page: entry.id,
      label: entry.label,
      href: entry.href,
      preview: entry.stage === "preview",
    }));
}

/** The create targets the viewer may reach, whose label holds the text. */
export function createItems(viewer: Reach, text: string): PaletteItem[] {
  return CREATE_TARGETS.filter((target) => mayReach(target, viewer) && holds(target.label, text)).map((target) => ({
    kind: "create",
    key: `create:${target.id}`,
    label: target.label,
    href: target.href,
    preview: target.stage === "preview",
  }));
}

const journeyHref = (id: string) => `/v2/journeys/${encodeURIComponent(id)}`;
// SEG-FR-09: the segment list marks the segment that `?segment=` names.
const segmentHref = (id: string) => `/v2/segments?segment=${encodeURIComponent(id)}`;
const customerLookupHref = (text: string) => `/v2/customers?q=${encodeURIComponent(text)}`;

/**
 * The palette's groups for the typed text: create targets, pages, then the journeys and segments the server found
 * for that text, then the customer lookup. Empty groups are left out.
 */
export function paletteGroups(viewer: Reach, text: string, found: NameSearch | null): PaletteGroup[] {
  const query = text.trim();
  const named = found?.status === "found" ? found : { journeys: [], segments: [] };
  const groups: PaletteGroup[] = [
    { value: "Create", items: createItems(viewer, query) },
    { value: "Pages", items: pageItems(viewer, query) },
    {
      value: "Journeys",
      items: named.journeys.map((match) => ({ kind: "journey", key: `journey:${match.id}`, label: match.name, href: journeyHref(match.id) })),
    },
    {
      value: "Segments",
      items: named.segments.map((match) => ({ kind: "segment", key: `segment:${match.id}`, label: match.name, href: segmentHref(match.id) })),
    },
    {
      value: "Customers",
      items: query === "" ? [] : [{ kind: "customer", key: "customer", label: `Look up customer "${query}"`, href: customerLookupHref(query) }],
    },
  ];
  return groups.filter((group) => group.items.length > 0);
}

// ILIKE treats % and _ as wildcards and \ as their escape, so typed ones match only themselves.
function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

// Only active and paused journeys have an analytics page, so a draft is never offered.
const JOURNEYS = `SELECT id, name FROM campaigns
WHERE status IN ('active', 'paused') AND name ILIKE $1 ESCAPE '\\'
ORDER BY lower(name), id
LIMIT $2`;

const SEGMENTS = `SELECT id, name FROM segments
WHERE name ILIKE $1 ESCAPE '\\'
ORDER BY lower(name), id
LIMIT $2`;

/** SHL-FR-07: journeys whose name holds the text, ignoring case. */
export function journeyNameQuery(text: string): SqlQuery {
  return { text: JOURNEYS, values: [containsPattern(text), NAME_MATCH_LIMIT] };
}

/** SHL-FR-07: segments whose name holds the text, ignoring case. */
export function segmentNameQuery(text: string): SqlQuery {
  return { text: SEGMENTS, values: [containsPattern(text), NAME_MATCH_LIMIT] };
}

/** Rows without a text id and name are dropped. */
export function parseNameMatches(rows: readonly Record<string, unknown>[]): NameMatch[] {
  return rows.flatMap((row) => (typeof row.id === "string" && typeof row.name === "string" ? [{ id: row.id, name: row.name }] : []));
}
