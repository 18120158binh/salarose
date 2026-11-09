import type { SegmentSummary } from "@/lib/db";
import type { SegmentUse, SegmentUseKind } from "shared/lib/segments";
import { formatTimestamp } from "@/shared/lib/format";
import type { TimeZone } from "@/shared/lib/time-range";
import { journeyHref, type Viewer } from "@/widgets/v2-shell/model/routes";

export const UNKNOWN_CREATOR = "Unknown";

export const USE_KIND_LABELS = {
  entry_trigger: "Entry trigger",
  event_audience: "Business-event audience",
  condition: "Condition",
} as const satisfies Record<SegmentUseKind, string>;

export const FILTER_LABELS = { all: "All", used: "In use", unused: "Unused" } as const;

export const USE_FILTERS = ["all", "used", "unused"] as const;
export type UseFilter = (typeof USE_FILTERS)[number];

export function segmentEditHref(id: string): string {
  return `/v2/segments/${encodeURIComponent(id)}`;
}

/** How many segments each filter keeps, for the counts beside the filter chips. */
export function filterCounts(rows: readonly SegmentRow[]): Record<UseFilter, number> {
  const used = rows.filter((row) => row.usedBy.length > 0).length;
  return { all: rows.length, used, unused: rows.length - used };
}

/** A journey that uses the segment, with where its name links for the viewer, or null for no link. */
export type JourneyUse = Omit<SegmentUse, "ownerId"> & { href: string | null };

// One row of /v2/segments, formatted on the server so the browser renders the same text.
export interface SegmentRow {
  id: string;
  name: string;
  description: string;
  creator: string;
  lastChange: { text: string; exact: string } | null;
  usedBy: JourneyUse[];
}

/** What the editor shows about the segment beside the form: the Details card. */
export interface SegmentDetails {
  createdBy: string;
  created: { text: string; exact: string } | null;
  lastChange: { text: string; exact: string } | null;
}

export function segmentRows(segments: readonly SegmentSummary[], now: number, zone: TimeZone, viewer: Viewer): SegmentRow[] {
  return segments.map((segment) => {
    const changedAt = segment.updatedAt === null ? Number.NaN : Date.parse(segment.updatedAt);
    return {
      id: segment.id,
      name: segment.name,
      description: segment.description,
      creator: segment.createdBy ?? UNKNOWN_CREATOR,
      lastChange: Number.isNaN(changedAt) ? null : formatTimestamp(changedAt, now, zone),
      usedBy: journeyUses(segment.usedBy, viewer),
    };
  });
}

export function journeyUses(uses: readonly SegmentUse[], viewer: Viewer): JourneyUse[] {
  return uses.map(({ ownerId, ...use }) => ({ ...use, href: journeyHref({ id: use.campaignId, ownerId }, viewer) }));
}

// SEG-FR-09: the search matches the typed text anywhere in the name or the description, ignoring
// case, and the filter keeps the segments in use or the unused ones.
export function filterSegments(rows: readonly SegmentRow[], search: string, filter: UseFilter): SegmentRow[] {
  const needle = search.trim().toLowerCase();
  return rows.filter((row) => {
    const inUse = row.usedBy.length > 0;
    if (filter === "used" && !inUse) return false;
    if (filter === "unused" && inUse) return false;
    return needle === "" || row.name.toLowerCase().includes(needle) || row.description.toLowerCase().includes(needle);
  });
}
