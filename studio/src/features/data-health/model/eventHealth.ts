import type { SqlQuery } from "@/lib/db";
import type { EventVolume } from "./eventVolume";

// DHL-FR-13, DHL-FR-14: every catalog event with its volume, for Monitoring's tiles and table
// and the Events page's Data health strip.

export interface CatalogEventName {
  id: string;
  name: string;
  label: string;
}

export interface EventHealthRow extends CatalogEventName {
  volume: EventVolume;
}

export interface EventHealth {
  // Quiet events first, then the most drops, then catalog order.
  rows: EventHealthRow[];
  receiving: number;
  quiet: EventHealthRow[];
}

export const CATALOG_EVENT_NAMES_QUERY: SqlQuery = {
  text: `SELECT id, event_name, COALESCE(NULLIF(display_name, ''), event_name) AS label FROM user_events
ORDER BY lower(COALESCE(NULLIF(display_name, ''), event_name)), event_name, id`,
  values: [],
};

export function parseCatalogEventNames(rows: readonly Record<string, unknown>[]): CatalogEventName[] {
  return rows.flatMap((row) =>
    typeof row.event_name === "string" && row.id !== null && row.id !== undefined
      ? [{ id: String(row.id), name: row.event_name, label: typeof row.label === "string" ? row.label : row.event_name }]
      : [],
  );
}

export function eventHealth(events: readonly CatalogEventName[], volumes: readonly EventVolume[]): EventHealth {
  const byName = new Map(volumes.map((volume) => [volume.eventName, volume]));
  const rows = events.flatMap((event) => {
    const volume = byName.get(event.name);
    return volume ? [{ ...event, volume }] : [];
  });
  const quietFirst = (row: EventHealthRow) => (row.volume.arrival === "quiet" ? 0 : 1);
  const sorted = rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => quietFirst(a.row) - quietFirst(b.row) || b.row.volume.dropped - a.row.volume.dropped || a.index - b.index)
    .map(({ row }) => row);
  return {
    rows: sorted,
    receiving: rows.filter((row) => row.volume.arrival === "receiving").length,
    quiet: sorted.filter((row) => row.volume.arrival === "quiet"),
  };
}
